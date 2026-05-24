import type { StepRunner, StepRunnerCtx, StepRunnerResult } from '../step-runner'
import type { WaitForSetupConfig } from '../../../shared/automations-types'
import type { SetupScriptEntry } from '../../setup-script/registry'
import type { WorkspaceGroup } from '../../../shared/types'
import { parseMemberScopedRef } from '../../../shared/automation-member-scoped-ref'
import { findGroupById } from '../../workspace-group-runtime'
import { resolveTemplate, TemplateResolutionError } from '../template'

export type WaitForSetupDeps = {
  getSetupScript: (worktreeId: string) => SetupScriptEntry | undefined
  /** Snapshot of all workspace groups so the runner can resolve a
   *  `group:<uuid>` worktreeRef to its ordered member worktreeIds without an
   *  IPC roundtrip. Optional so legacy single-worktree tests don't need to
   *  wire it; absent + a group ref ⇒ the group lookup naturally returns
   *  undefined and the runner fails-fast. */
  getWorkspaceGroups?: () => readonly WorkspaceGroup[]
  now: () => number
}

type Tracker = {
  /** Wall-clock when the runner first looked at this worktree — anchors the
   *  per-step timeout. Once set on first tick, never re-stamped. */
  openedAt: number
}

export class WaitForSetupRunner implements StepRunner {
  // Why: nested map keyed by (runId, stepId) mirrors RunPromptRunner so a
  // step.id containing ':' can't collide with another run's tracker.
  private readonly trackers = new Map<string, Map<string, Tracker>>()

  constructor(private readonly deps: WaitForSetupDeps) {}

  async tick(ctx: StepRunnerCtx): Promise<StepRunnerResult> {
    const config = ctx.step.config as WaitForSetupConfig

    let resolvedRef: string
    try {
      resolvedRef = resolveTemplate(config.worktreeRef, ctx.context)
    } catch (e) {
      // Template resolution errors can never succeed on retry (bad authoring
      // or missing context), so fail-fast instead of looping forever.
      if (e instanceof TemplateResolutionError) {
        return { outcome: 'failed', status: 'failed', error: e.message }
      }
      throw e
    }

    let runTrackers = this.trackers.get(ctx.runId)
    let tracker = runTrackers?.get(ctx.step.id)
    if (!tracker) {
      tracker = { openedAt: this.deps.now() }
      if (!runTrackers) {
        runTrackers = new Map()
        this.trackers.set(ctx.runId, runTrackers)
      }
      runTrackers.set(ctx.step.id, tracker)
    }

    const now = this.deps.now()

    // Per design § "Agent step lifecycle": the step-level timeout is the only
    // hard escape valve. Check it BEFORE reading the registry so a permanently
    // running setup script can still time out cleanly. The timeout applies to
    // the whole wait (group or single), not to any individual member.
    if (ctx.step.timeoutSeconds != null) {
      const elapsedMs = now - tracker.openedAt
      if (elapsedMs >= ctx.step.timeoutSeconds * 1000) {
        return {
          outcome: 'failed',
          status: 'timed-out',
          error: `Step exceeded timeout of ${ctx.step.timeoutSeconds}s.`
        }
      }
    }

    // Why: a member-scoped ref (`member:<groupId>:<worktreeId>`, Ask C / Phase
    // L3) deliberately narrows the wait to ONE member's setup script — same
    // semantics as a single worktreeId wait, but with the group-aware prefix
    // peeled off.
    const memberScoped = parseMemberScopedRef(resolvedRef)
    if (memberScoped) {
      return this.tickSingleWorktree(memberScoped.worktreeId, config)
    }

    // Why: a `group:<uuid>` ref (produced by `{{steps.<cwg>.groupId}}`) must
    // wait on EVERY group member's setup script. Without this branch the
    // registry lookup returns undefined (the registry is keyed by member
    // worktreeId, never by group id) and the runner silently resolved as
    // success — the bug this branch fixes.
    if (resolvedRef.startsWith('group:')) {
      return this.tickGroup(resolvedRef, config)
    }

    return this.tickSingleWorktree(resolvedRef, config)
  }

  /** Single-worktree (or member-scoped) wait. Mirrors the legacy behavior:
   *  missing registry entry ⇒ resolve immediately as "no setup script
   *  configured", pending/running ⇒ needs-more-time, exit ⇒ resolve per
   *  `requireSuccess`. */
  private tickSingleWorktree(worktreeId: string, config: WaitForSetupConfig): StepRunnerResult {
    const entry = this.deps.getSetupScript(worktreeId)

    if (!entry) {
      // Why: missing registry entry means no setup script ever ran for this
      // worktree (either none is configured, or this worktree was created
      // outside the spawn path). Resolve immediately so chains don't block
      // waiting for a script that will never start. Authors who need to
      // require a setup-script success can encode that as a separate guard
      // step; `requireSuccess: true` only enforces success of an entry that
      // exists.
      return {
        outcome: 'done',
        status: 'succeeded',
        output: { exitCode: 0, durationMs: 0 }
      }
    }

    if (entry.state === 'pending' || entry.state === 'running') {
      return { outcome: 'needs-more-time', status: 'running' }
    }

    const durationMs =
      entry.startedAt != null && entry.finishedAt != null ? entry.finishedAt - entry.startedAt : 0
    const exitCode = entry.exitCode ?? 0

    if (entry.state === 'exited-success') {
      return {
        outcome: 'done',
        status: 'succeeded',
        output: { exitCode, durationMs }
      }
    }

    // entry.state === 'exited-failure'
    if (config.requireSuccess) {
      return {
        outcome: 'failed',
        status: 'failed',
        error: `Setup script exited with exit code ${exitCode}.`
      }
    }
    return {
      outcome: 'done',
      status: 'succeeded',
      output: { exitCode, durationMs }
    }
  }

  /** Group wait — iterates members in `group.memberWorktreeIds` order (stable
   *  at create time). Per-member missing-entry semantics match
   *  `tickSingleWorktree`: a member with no registry entry is treated as "no
   *  setup script configured" and doesn't block. */
  private tickGroup(groupId: string, config: WaitForSetupConfig): StepRunnerResult {
    const groups = this.deps.getWorkspaceGroups?.() ?? []
    const group = findGroupById(groupId, groups)
    if (!group) {
      // Fail-fast: this used to silently succeed (the bug). A missing group at
      // tick time means the chain author referenced something the store can't
      // resolve; retrying won't help.
      return {
        outcome: 'failed',
        status: 'failed',
        error: `Group not found for worktreeRef "${groupId}".`
      }
    }

    let maxDurationMs = 0
    let worstExitCode = 0
    const failedMembers: { id: string; exitCode: number }[] = []

    for (const memberId of group.memberWorktreeIds) {
      const entry = this.deps.getSetupScript(memberId)
      if (!entry) {
        // Same as single-worktree branch: missing entry ⇒ "no script
        // configured" for this member. Skip without blocking the wait.
        continue
      }
      if (entry.state === 'pending' || entry.state === 'running') {
        return { outcome: 'needs-more-time', status: 'running' }
      }
      const memberDuration =
        entry.startedAt != null && entry.finishedAt != null ? entry.finishedAt - entry.startedAt : 0
      const memberExitCode = entry.exitCode ?? 0
      if (memberDuration > maxDurationMs) {
        maxDurationMs = memberDuration
      }
      // Why: any non-zero exit code wins over 0; if multiple non-zero, keep
      // the first one encountered (deterministic, ordered by member list).
      if (worstExitCode === 0 && memberExitCode !== 0) {
        worstExitCode = memberExitCode
      }
      if (entry.state === 'exited-failure') {
        failedMembers.push({ id: memberId, exitCode: memberExitCode })
      }
    }

    if (failedMembers.length > 0 && config.requireSuccess) {
      const detail = failedMembers.map((m) => `${m.id} (exit code ${m.exitCode})`).join(', ')
      return {
        outcome: 'failed',
        status: 'failed',
        error: `Setup script failed for group member(s): ${detail}.`
      }
    }

    return {
      outcome: 'done',
      status: 'succeeded',
      output: { exitCode: worstExitCode, durationMs: maxDurationMs }
    }
  }

  dropRun(runId: string): void {
    this.trackers.delete(runId)
  }

  dropStep(runId: string, stepId: string): void {
    const runTrackers = this.trackers.get(runId)
    if (!runTrackers) {
      return
    }
    runTrackers.delete(stepId)
    if (runTrackers.size === 0) {
      this.trackers.delete(runId)
    }
  }
}
