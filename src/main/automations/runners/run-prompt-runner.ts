import type { StepRunner, StepRunnerCtx, StepRunnerResult } from '../step-runner'
import type { RunPromptConfig } from '../../../shared/automations-types'
import { parseMemberScopedRef } from '../../../shared/automation-member-scoped-ref'
import type { AgentStatusEntry } from '../../agent-status/registry'
import { OpenPromptPaneError } from '../open-prompt-pane'
import { SendPromptToPaneError } from '../send-prompt-to-pane'
import { resolveTemplate, TemplateResolutionError } from '../template'
import { OutputTail } from '../output-tail'

/** Cap PTY output capture at 32 KiB. Same sizing as run-command — big
 *  enough to read the agent's last reply for downstream templating, small
 *  enough that hundreds of concurrent chain runs can't pile up memory. */
const OUTPUT_TAIL_MAX_BYTES = 32 * 1024

export type RunPromptDeps = {
  openPromptPane: (params: {
    worktreeId: string
    agentId: string
    prompt: string
    worktreePath?: string
    connectionId?: string | null
    /** Member-scoped marker (Ask C). When true, the renderer threads
     *  `keepCwd: true` through to `pty.spawn` so the Phase J1 grouped-
     *  worktree cwd override doesn't redirect the agent's CWD to the
     *  group's parentPath. The tab itself is still bound to the member
     *  worktreeId (so the group's card/stop-all/tab strip still own it).
     *  Optional so non-grouped chains stay unaffected. */
    memberScoped?: boolean
  }) => Promise<{ paneKey: string }>
  /** Reuses an existing pane by paneKey instead of opening a new one. Optional
   *  so legacy `paneRef`-less chains keep working without wiring the IPC; the
   *  default below throws if a chain ever tries to invoke it without the dep
   *  being supplied. */
  sendPromptToPane?: (params: { paneKey: string; prompt: string }) => Promise<void>
  getAgentStatus: (paneKey: string) => AgentStatusEntry | undefined
  /** Resolves a worktree's path and owning repo connectionId from main's
   *  store so the openPromptPane payload carries everything the renderer
   *  needs to spawn the PTY without relying on its (possibly stale) cache.
   *  Returns null if the worktree id can't be parsed; the renderer falls
   *  back to the legacy cache lookup. */
  getWorktreeSummary?: (worktreeId: string) => {
    path: string
    connectionId: string | null
  } | null
  /** Resolves a `group:<uuid>` id (the output of CreateWorkspaceGroupRunner)
   *  into the group's parent path plus the first member's worktreeId. The
   *  agent is launched with CWD = `parentPath` so `pwd` shows the shared
   *  workspace folder; the member worktreeId is what the pane is bound to in
   *  the UI (status registry, tab activation). Returns null when the id is
   *  not a group reference; the runner then falls through to the worktree
   *  path. Optional so tests that never address a group can skip wiring. */
  getGroupSummary?: (groupId: string) => {
    parentPath: string
    firstMemberWorktreeId: string
    /** Connection id of the member's owning repo. Groups are uniform-
     *  connection by construction (validated at create time), so the first
     *  member is representative. */
    connectionId: string | null
  } | null
  /** Resolve a paneKey to its current ptyId so the runner can subscribe to
   *  the pane's data stream and capture the agent's last-turn output for
   *  step output. Returns undefined if the pane has no live PTY (pane gone,
   *  not yet spawned). Optional so existing test harnesses keep working. */
  getPtyIdForPaneKey?: (paneKey: string) => string | undefined
  /** Subscribe to the main-process PTY data stream so the runner can mirror
   *  what the renderer sees into a bounded OutputTail. Same shape as
   *  RunCommandDeps['subscribePtyData']. */
  subscribePtyData?: (listener: (ptyId: string, data: string) => void) => () => void
  now: () => number
}

type Tracker = {
  paneKey: string
  /** Wall-clock when the pane was first opened — anchors the per-step timeout
   *  and is included in the success output so the executor can record run
   *  durations. Set once when the tracker is recorded; never re-stamped. */
  openedAt: number
  /** Wall-clock of the first `done` ping that started the current debounce
   *  window. Reset to null whenever the agent flips back to `working`, so a
   *  brief done → working → done sequence cannot accidentally satisfy the
   *  debounce. */
  firstDoneAt: number | null
  /** Ring buffer scoped to the agent's current turn — reset the first time
   *  the agent flips to `working` so the tail surfaced on completion is the
   *  response to the current prompt, not the full pane history. May be null
   *  when the PTY isn't subscribable (deps not wired). */
  outputTail: OutputTail | null
  /** Set the first time we observe `working` for this turn; cleared after a
   *  successful completion drains the tail. */
  workingSeen: boolean
  /** True when the tracker was created by reusing an existing pane (`paneRef`
   *  branch). The agent was already idle (`done`) when we wrote into it, so
   *  we must observe a fresh `working` transition before treating any
   *  subsequent `done` as completion. Without this, the previous turn's
   *  lingering `done` state would satisfy the debounce and the step would
   *  succeed before the new prompt produced any work. */
  requiresWorkingFirst: boolean
  /** Tears down the PTY data subscription on terminal outcomes. No-op when
   *  no subscription was opened. */
  unsubscribe: () => void
}

export class RunPromptRunner implements StepRunner {
  // Nested map keyed by (runId, stepId) so a step.id containing ':' can't
  // collide with another run's tracker, and so a future run-level cleanup
  // can drop every tracker for a run with a single `trackers.delete(runId)`.
  // Why: tracker cleanup is deferred — the chain executor (Task 7) will call
  // a release hook on run completion, since runner instances are singletons
  // per AutomationService and outlive any individual run.
  private readonly trackers = new Map<string, Map<string, Tracker>>()

  constructor(private readonly deps: RunPromptDeps) {}

  async tick(ctx: StepRunnerCtx): Promise<StepRunnerResult> {
    const config = ctx.step.config as RunPromptConfig
    let runTrackers = this.trackers.get(ctx.runId)
    let tracker = runTrackers?.get(ctx.step.id)
    if (!tracker) {
      let worktreeId: string
      let prompt: string
      let resolvedPaneRef: string
      try {
        worktreeId = resolveTemplate(config.worktreeRef, ctx.context)
        prompt = resolveTemplate(config.prompt, ctx.context)
        // Why: paneRef is optional; only resolve when present so a chain
        // without it doesn't fail on a missing template input.
        resolvedPaneRef = config.paneRef ? resolveTemplate(config.paneRef, ctx.context) : ''
      } catch (e) {
        // Template resolution errors can never succeed on retry (bad authoring
        // or missing context), so fail-fast instead of looping forever.
        if (e instanceof TemplateResolutionError) {
          return { outcome: 'failed', status: 'failed', error: e.message }
        }
        throw e
      }

      // paneRef branch: reuse an existing pane instead of opening a new one.
      const paneRef = resolvedPaneRef.trim()
      if (paneRef.length > 0) {
        // Why: pre-send wait gate — never write into a pane mid-turn. A
        // `working` agent is still composing/executing, so we hold off until
        // it returns to `done`. Returning `needs-more-time` (not `failed`)
        // lets the per-step timeout be the only escape valve.
        const status = this.deps.getAgentStatus(paneRef)
        if (status?.state === 'working') {
          return { outcome: 'needs-more-time', status: 'running' }
        }
        if (status?.state === 'blocked' || status?.state === 'waiting') {
          // Same halt semantics as the polling branch below: can't send into
          // a pane whose agent is waiting on a human.
          return {
            outcome: 'failed',
            status: 'failed',
            error: `Agent needs human input (${status.state}). Chain halted.`
          }
        }
        if (!this.deps.sendPromptToPane) {
          throw new Error('RunPromptRunner: sendPromptToPane dep not wired.')
        }
        try {
          await this.deps.sendPromptToPane({ paneKey: paneRef, prompt })
        } catch (e) {
          // Why: mirror the openPromptPane branch — deterministic renderer
          // failures (pane gone, write rejected) fail-fast via the dedicated
          // error class; plain Errors are transient and re-thrown for retry.
          if (e instanceof SendPromptToPaneError) {
            return { outcome: 'failed', status: 'failed', error: e.message }
          }
          throw e
        }
        tracker = this.buildTracker(paneRef, { requiresWorkingFirst: true })
        if (!runTrackers) {
          runTrackers = new Map()
          this.trackers.set(ctx.runId, runTrackers)
        }
        runTrackers.set(ctx.step.id, tracker)
        return { outcome: 'needs-more-time', status: 'running' }
      }

      let paneKey: string
      try {
        // Why (grouped-workspaces L3): when the resolved worktreeRef is a
        // `group:<uuid>` id (e.g. `{{steps.<create-workspace-group>.groupId}}`),
        // the agent should run at the group's shared parent folder rather than
        // any single member's worktree. Redirect both the worktreeId binding
        // (to the first member, so UI tab/status lookups still find a real
        // worktree) and the CWD (to parentPath) here. Phase J's pty:spawn
        // override handles the inverse case — when the ref is a member
        // worktreeId, it already redirects the CWD to parentPath if the
        // worktree has groupId set — so we don't need a second branch for
        // member-targeted runs.
        //
        // Ask C (member-scoped): a `member:<groupId>:<worktreeId>` ref means
        // "run at the member worktree's path, but keep the terminal bound to
        // the group". We bind the tab to the member worktreeId (the group's
        // card already owns any tab whose worktreeId is a member), then pass
        // `memberScoped: true` so the renderer threads `keepCwd: true` and
        // Phase J1 doesn't bounce the CWD back up to parentPath.
        let effectiveWorktreeId = worktreeId
        let effectiveSummary: { path: string; connectionId: string | null } | null = null
        let memberScoped = false
        const parsedMemberScoped = parseMemberScopedRef(worktreeId)
        if (parsedMemberScoped) {
          // Why: ignore the renderer's possibly-stale cache here too — we
          // need the member's path to plant the agent there even if the
          // member was minted milliseconds earlier in the same chain.
          const memberSummary =
            this.deps.getWorktreeSummary?.(parsedMemberScoped.worktreeId) ?? null
          if (!memberSummary) {
            return {
              outcome: 'failed',
              status: 'failed',
              error: `Member worktree not found for worktreeRef "${worktreeId}".`
            }
          }
          effectiveWorktreeId = parsedMemberScoped.worktreeId
          effectiveSummary = memberSummary
          memberScoped = true
        } else if (worktreeId.startsWith('group:')) {
          const groupSummary = this.deps.getGroupSummary?.(worktreeId) ?? null
          if (!groupSummary) {
            return {
              outcome: 'failed',
              status: 'failed',
              error: `Group not found for worktreeRef "${worktreeId}".`
            }
          }
          effectiveWorktreeId = groupSummary.firstMemberWorktreeId
          effectiveSummary = {
            path: groupSummary.parentPath,
            connectionId: groupSummary.connectionId
          }
        } else {
          // Why: pre-resolve path + connectionId in main and hand them to the
          // renderer so it doesn't have to look the worktree up in its cache.
          // The chain creates the worktree milliseconds earlier; the renderer's
          // `worktrees:changed` broadcast may not have settled yet.
          effectiveSummary = this.deps.getWorktreeSummary?.(worktreeId) ?? null
        }
        const result = await this.deps.openPromptPane({
          worktreeId: effectiveWorktreeId,
          agentId: config.agentId,
          prompt,
          ...(effectiveSummary
            ? { worktreePath: effectiveSummary.path, connectionId: effectiveSummary.connectionId }
            : {}),
          ...(memberScoped ? { memberScoped: true } : {})
        })
        paneKey = result.paneKey
      } catch (e) {
        // Why: OpenPromptPaneError signals a deterministic renderer-side
        // failure (bad worktree/agent, empty startup plan) — same fail-fast
        // semantics as TemplateResolutionError above. Plain Errors here are
        // transient (destroyed webContents, timeout) so they re-throw and
        // the executor retries on the next tick.
        if (e instanceof OpenPromptPaneError) {
          return { outcome: 'failed', status: 'failed', error: e.message }
        }
        throw e
      }
      tracker = this.buildTracker(paneKey, { requiresWorkingFirst: false })
      if (!runTrackers) {
        runTrackers = new Map()
        this.trackers.set(ctx.runId, runTrackers)
      }
      runTrackers.set(ctx.step.id, tracker)
      return { outcome: 'needs-more-time', status: 'running' }
    }

    const now = this.deps.now()

    // Per design § "Agent step lifecycle": the step-level timeout is the only
    // hard escape valve when the agent fails to converge on `done`. Check it
    // BEFORE reading status so a long-pending or missing status can still time
    // out cleanly — never gate the timeout on having a fresh status entry.
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

    const status = this.deps.getAgentStatus(tracker.paneKey)

    if (!status) {
      // No status yet — pane just opened, hook hasn't pinged. Treat as still
      // warming up so we don't prematurely fail on a missing entry.
      return { outcome: 'needs-more-time', status: 'running' }
    }

    if (status.state === 'blocked' || status.state === 'waiting') {
      // Why: chain steps cannot make progress when the agent is asking for
      // human input. Halting here surfaces the block to the operator instead
      // of silently spinning until the step timeout fires.
      return {
        outcome: 'failed',
        status: 'failed',
        error: `Agent needs human input (${status.state}). Chain halted.`
      }
    }

    if (status.state === 'working') {
      // Why: any work flip after a done ping invalidates the debounce window.
      // Without this reset a brief done → working → done could satisfy the
      // window using the original firstDoneAt timestamp.
      tracker.firstDoneAt = null
      // Why: scope the outputTail to a single agent turn. First time we see
      // the agent flip to `working` for this prompt, drop everything that
      // was buffered during pane warm-up so the tail surfaced on completion
      // is the agent's actual reply (rather than the full pane history).
      if (!tracker.workingSeen) {
        tracker.workingSeen = true
        tracker.outputTail?.reset()
      }
      // Re-attempt subscription in case the PTY wasn't live yet on tracker
      // creation but is now — happens on freshly-opened panes where the
      // hook's `working` event arrives before the PTY id is registered.
      this.ensureSubscribed(tracker)
      return { outcome: 'needs-more-time', status: 'running' }
    }

    // status.state === 'done'
    // Why: for paneRef reuse, we wrote the new prompt into a pane that was
    // already idle. Until the agent actually flips to `working`, this `done`
    // is the OLD turn's terminal state — accepting it would let the
    // debounce satisfy before the new prompt does any work. Wait for a
    // fresh `working` transition to clear the gate.
    if (tracker.requiresWorkingFirst && !tracker.workingSeen) {
      return { outcome: 'needs-more-time', status: 'running' }
    }
    if (tracker.firstDoneAt == null) {
      tracker.firstDoneAt = now
      return { outcome: 'needs-more-time', status: 'running' }
    }
    const debounceMs = config.doneDebounceSeconds * 1000
    if (now - tracker.firstDoneAt >= debounceMs) {
      // Why: also publish paneKey into context.steps so a downstream step can
      // template `paneRef: '{{steps.<this-step-id>.paneKey}}'` and chain its
      // prompt into the same pane (the MP.10 paneRef use case). outputTail
      // surfaces the agent's last-turn response so downstream steps and the
      // run summary can read it without re-attaching to the pane.
      //
      // Prefer the hook-reported `lastAssistantMessage` — Claude Code's Stop
      // hook delivers the final response text directly, and the hook server
      // normalizes Codex/OpenCode/etc. into the same field. This is far more
      // deterministic than parsing the terminal stream (no ANSI/box-drawing,
      // no warm-up render, no spinner artifacts). Fall back to the captured
      // PTY tail only when no hook carried the field — typically a non-
      // agent command or an agent whose stop hook isn't installed.
      const output = {
        paneKey: tracker.paneKey,
        durationMs: now - tracker.openedAt,
        outputTail: status.lastAssistantMessage ?? tracker.outputTail?.read() ?? ''
      }
      this.cleanup(tracker)
      return {
        outcome: 'done',
        status: 'succeeded',
        output,
        contextPatch: { steps: { [ctx.step.id]: output } }
      }
    }
    return { outcome: 'needs-more-time', status: 'running' }
  }

  /** Build a fresh tracker, eagerly subscribing to the pane's PTY data so we
   *  can capture the agent's last-turn output. Subscription is best-effort:
   *  if the deps aren't wired or the pane isn't bound to a live PTY yet, we
   *  fall through with `outputTail = null` and downstream callsites surface
   *  an empty string. */
  private buildTracker(paneKey: string, opts: { requiresWorkingFirst: boolean }): Tracker {
    const tracker: Tracker = {
      paneKey,
      openedAt: this.deps.now(),
      firstDoneAt: null,
      outputTail: null,
      workingSeen: false,
      requiresWorkingFirst: opts.requiresWorkingFirst,
      unsubscribe: () => {}
    }
    this.ensureSubscribed(tracker)
    return tracker
  }

  /** Attach a PTY data subscription scoped to the tracker's pane, if both
   *  `subscribePtyData` and `getPtyIdForPaneKey` are wired and a live PTY
   *  exists. Idempotent — re-entering when already subscribed is a no-op.
   *  Why: chain runs created their pane milliseconds earlier; the paneKey →
   *  ptyId mapping may not have been written yet when `buildTracker` ran.
   *  The agent-status `working` tick is a deterministic later moment to
   *  retry the subscription. */
  private ensureSubscribed(tracker: Tracker): void {
    if (tracker.outputTail !== null) {
      return
    }
    if (!this.deps.subscribePtyData || !this.deps.getPtyIdForPaneKey) {
      return
    }
    const ptyId = this.deps.getPtyIdForPaneKey(tracker.paneKey)
    if (!ptyId) {
      return
    }
    const outputTail = new OutputTail(OUTPUT_TAIL_MAX_BYTES)
    const capturedPtyId = ptyId
    const unsubscribe = this.deps.subscribePtyData((dataPtyId, data) => {
      if (dataPtyId === capturedPtyId) {
        outputTail.append(data)
      }
    })
    tracker.outputTail = outputTail
    tracker.unsubscribe = unsubscribe
  }

  /** Tear down the PTY data subscription on a terminal outcome. No-op when
   *  no subscription was opened. Mirrors RunCommandRunner.cleanup. */
  private cleanup(tracker: Tracker): void {
    try {
      tracker.unsubscribe()
    } catch (err) {
      console.error('[run-prompt-runner] unsubscribe threw:', err)
    }
  }

  /** Drop every tracker for a run — used on cancel so a subsequent tick
   *  doesn't keep polling a pane the operator gave up on. */
  dropRun(runId: string): void {
    const runTrackers = this.trackers.get(runId)
    if (!runTrackers) {
      return
    }
    for (const tracker of runTrackers.values()) {
      this.cleanup(tracker)
    }
    this.trackers.delete(runId)
  }

  /** Drop a single step's tracker — used on retry-from-step so the retried
   *  step starts fresh while sibling completed steps' downstream context is
   *  preserved. */
  dropStep(runId: string, stepId: string): void {
    const runTrackers = this.trackers.get(runId)
    const tracker = runTrackers?.get(stepId)
    if (!tracker) {
      return
    }
    this.cleanup(tracker)
    runTrackers!.delete(stepId)
    if (runTrackers!.size === 0) {
      this.trackers.delete(runId)
    }
  }
}
