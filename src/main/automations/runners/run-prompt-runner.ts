import type { StepRunner, StepRunnerCtx, StepRunnerResult } from '../step-runner'
import type { RunPromptConfig } from '../../../shared/automations-types'
import type { TuiAgent } from '../../../shared/types'
import { parseMemberScopedRef } from '../../../shared/automation-member-scoped-ref'
import type { AgentStatusEntry } from '../../agent-status/registry'
import { OpenPromptPaneError } from '../open-prompt-pane'
import { SendPromptToPaneError } from '../send-prompt-to-pane'
import { resolveTemplate, TemplateResolutionError } from '../template'
import { OutputTail } from '../output-tail'
import type { PromptMainChangeResult, PromptMainChangeTarget } from '../prompt-target-main-changes'

/** Cap PTY output capture at 32 KiB. Same sizing as run-command — big
 *  enough to read the agent's last reply for downstream templating, small
 *  enough that hundreds of concurrent chain runs can't pile up memory. */
const OUTPUT_TAIL_MAX_BYTES = 32 * 1024

export type RunPromptDeps = {
  openPromptPane: (params: {
    dedupeKey?: string
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
  /** Resolves a group id to every member worktree. Used only by the clean
   *  target skip gate; launch behavior still uses getGroupSummary above. */
  getGroupMemberWorktreeIds?: (groupId: string) => string[] | null
  hasChangesFromMain?: (targets: PromptMainChangeTarget[]) => Promise<PromptMainChangeResult>
  resolvePresetPrompt?: (params: {
    source: 'review' | 'create-pr'
    commandId?: string
    promptOverride?: string
    fallbackAgentId: TuiAgent
    worktreeId: string
  }) => Promise<{ agentId: TuiAgent; prompt: string }>
  /** Resolve a paneKey to its current ptyId so the runner can subscribe to
   *  the pane's data stream and capture the agent's last-turn output for
   *  step output. Returns undefined if the pane has no live PTY (pane gone,
   *  not yet spawned). Optional so existing test harnesses keep working. */
  getPtyIdForPaneKey?: (paneKey: string) => string | undefined
  /** Subscribe to the main-process PTY data stream so the runner can mirror
   *  what the renderer sees into a bounded OutputTail. Same shape as
   *  RunCommandDeps['subscribePtyData']. */
  subscribePtyData?: (listener: (ptyId: string, data: string) => void) => () => void
  /** Close a pane this runner previously self-opened via openPromptPane.
   *  Invoked from dropStep on retry so the old agent tab is torn down before
   *  the executor opens a fresh one. Skipped for paneRef-reused trackers —
   *  those panes belong to upstream steps and must remain available for
   *  downstream paneRef consumers. Fire-and-forget. */
  closePane?: (paneKey: string) => void
  /** Pane FIFO queue. acquirePane returns true only when this token holds the
   *  pane; release frees it. token = `${runId}:${stepId}`. */
  acquirePane: (paneKey: string, token: string) => boolean
  releasePane: (paneKey: string, token: string) => void
  now: () => number
}

type PromptTargetResolution =
  | {
      ok: true
      effectiveWorktreeId: string
      effectiveSummary: { path: string; connectionId: string | null } | null
      memberScoped: boolean
      changeTargets: PromptMainChangeTarget[]
    }
  | { ok: false; error: string }

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
  /** True when this step opened the pane itself via openPromptPane (false
   *  for paneRef reuse). dropStep uses this to decide whether to close the
   *  pane on retry: self-opened panes are torn down so the retry gets a
   *  fresh agent session; paneRef panes are left alone since they're owned
   *  by an upstream step. */
  selfOpenedPane: boolean
  /** Wall-clock when the agent entered waiting/blocked state. Used to pause
   *  the timeout timer — elapsed wait time is added to openedAt when the
   *  agent resumes so only active execution counts toward timeoutSeconds. */
  waitStartedAt: number | null
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

  private resolvePromptTarget(
    worktreeId: string,
    includeChangeTargets: boolean
  ): PromptTargetResolution {
    let effectiveWorktreeId = worktreeId
    let effectiveSummary: { path: string; connectionId: string | null } | null = null
    let memberScoped = false
    let changeWorktreeIds = [worktreeId]

    const parsedMemberScoped = parseMemberScopedRef(worktreeId)
    if (parsedMemberScoped) {
      const memberSummary = this.deps.getWorktreeSummary?.(parsedMemberScoped.worktreeId) ?? null
      if (!memberSummary) {
        return {
          ok: false,
          error: `Member worktree not found for worktreeRef "${worktreeId}".`
        }
      }
      effectiveWorktreeId = parsedMemberScoped.worktreeId
      effectiveSummary = memberSummary
      memberScoped = true
      changeWorktreeIds = [parsedMemberScoped.worktreeId]
    } else if (worktreeId.startsWith('group:')) {
      const groupSummary = this.deps.getGroupSummary?.(worktreeId) ?? null
      if (!groupSummary) {
        return {
          ok: false,
          error: `Group not found for worktreeRef "${worktreeId}".`
        }
      }
      effectiveWorktreeId = groupSummary.firstMemberWorktreeId
      effectiveSummary = {
        path: groupSummary.parentPath,
        connectionId: groupSummary.connectionId
      }
      // Why: a group-scoped prompt is skipped only when every member has no
      // changes, even though the launched pane itself binds to the first member.
      changeWorktreeIds = this.deps.getGroupMemberWorktreeIds?.(worktreeId) ?? [
        groupSummary.firstMemberWorktreeId
      ]
    } else {
      // Why: pre-resolve path + connectionId in main and hand them to the
      // renderer so it doesn't have to look the worktree up in its cache.
      effectiveSummary = this.deps.getWorktreeSummary?.(worktreeId) ?? null
    }

    const changeTargets: PromptMainChangeTarget[] = []
    if (includeChangeTargets) {
      for (const id of changeWorktreeIds) {
        const summary = this.deps.getWorktreeSummary?.(id) ?? null
        if (summary) {
          changeTargets.push({
            worktreeId: id,
            path: summary.path,
            connectionId: summary.connectionId
          })
        }
      }
      if (changeTargets.length === 0 && effectiveSummary) {
        changeTargets.push({
          worktreeId: effectiveWorktreeId,
          path: effectiveSummary.path,
          connectionId: effectiveSummary.connectionId
        })
      }
    }

    return { ok: true, effectiveWorktreeId, effectiveSummary, memberScoped, changeTargets }
  }

  /** Release the pane claim this step holds (idempotent). Used on every
   *  terminal outcome so a dead holder never blocks the per-paneKey FIFO. */
  private releasePaneFor(ctx: StepRunnerCtx, paneKey: string | undefined): void {
    if (paneKey) {
      this.deps.releasePane(paneKey, `${ctx.runId}:${ctx.step.id}`)
    }
  }

  async tick(ctx: StepRunnerCtx): Promise<StepRunnerResult> {
    const config = ctx.step.config as RunPromptConfig
    const paneToken = `${ctx.runId}:${ctx.step.id}`
    let runTrackers = this.trackers.get(ctx.runId)
    let tracker = runTrackers?.get(ctx.step.id)
    if (!tracker) {
      let worktreeId: string
      let prompt: string
      let agentId: TuiAgent
      let resolvedPaneRef: string
      try {
        worktreeId = resolveTemplate(config.worktreeRef, ctx.context)
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

      const shouldCheckChanges =
        config.skipIfNoChangesFromMain === true && !!this.deps.hasChangesFromMain
      const target = this.resolvePromptTarget(worktreeId, shouldCheckChanges)
      if (!target.ok) {
        return { outcome: 'failed', status: 'failed', error: target.error }
      }

      if (shouldCheckChanges && target.changeTargets.length > 0 && this.deps.hasChangesFromMain) {
        const changes = await this.deps.hasChangesFromMain(target.changeTargets)
        if (!changes.hasChanges) {
          return {
            outcome: 'done',
            status: 'skipped',
            output: {
              reason: 'No changes from main',
              checkedWorktreeIds: changes.checkedWorktreeIds
            }
          }
        }
      }

      const source = config.source ?? 'custom'
      try {
        if (source === 'custom') {
          prompt = resolveTemplate(config.prompt, ctx.context)
          agentId = config.agentId
        } else {
          if (!this.deps.resolvePresetPrompt) {
            throw new Error('RunPromptRunner: resolvePresetPrompt dep not wired.')
          }
          const resolved = await this.deps.resolvePresetPrompt({
            source,
            commandId: config.commandId,
            promptOverride: config.promptOverride,
            fallbackAgentId: config.agentId,
            worktreeId: target.effectiveWorktreeId
          })
          prompt = resolveTemplate(resolved.prompt, ctx.context)
          agentId = resolved.agentId
        }
      } catch (e) {
        if (e instanceof TemplateResolutionError) {
          return { outcome: 'failed', status: 'failed', error: e.message }
        }
        if (e instanceof Error) {
          return { outcome: 'failed', status: 'failed', error: e.message }
        }
        throw e
      }

      // paneRef branch: reuse an existing pane instead of opening a new one.
      const paneRef = resolvedPaneRef.trim()
      if (paneRef.length > 0) {
        // Pane FIFO gate: only the queue head may drive the pane. Acquire
        // synchronously (before any await) so concurrent run-prompts to the
        // same paneKey serialize; non-head parks and retries next tick.
        if (!this.deps.acquirePane(paneRef, paneToken)) {
          return {
            outcome: 'needs-more-time',
            status: 'waiting',
            statusMessage: 'Waiting for pane'
          }
        }
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
          this.releasePaneFor(ctx, paneRef)
          return {
            outcome: 'failed',
            status: 'failed',
            error: `Agent needs human input (${status.state}). Chain halted.`
          }
        }
        if (!this.deps.sendPromptToPane) {
          // Release the pane we just acquired before throwing — the throw routes
          // to finalizeFailedRun, which (as a backstop) also frees panes.
          this.releasePaneFor(ctx, paneRef)
          throw new Error('RunPromptRunner: sendPromptToPane dep not wired.')
        }
        try {
          await this.deps.sendPromptToPane({ paneKey: paneRef, prompt })
        } catch (e) {
          // Why: mirror the openPromptPane branch — deterministic renderer
          // failures (pane gone, write rejected) fail-fast via the dedicated
          // error class; plain Errors are transient and re-thrown for retry.
          // Either way release the acquired pane so the queue doesn't deadlock.
          this.releasePaneFor(ctx, paneRef)
          if (e instanceof SendPromptToPaneError) {
            return { outcome: 'failed', status: 'failed', error: e.message }
          }
          throw e
        }
        tracker = this.buildTracker(paneRef, {
          requiresWorkingFirst: true,
          selfOpenedPane: false
        })
        if (!runTrackers) {
          runTrackers = new Map()
          this.trackers.set(ctx.runId, runTrackers)
        }
        runTrackers.set(ctx.step.id, tracker)
        return {
          outcome: 'needs-more-time',
          status: 'running',
          openedPane: { paneKey: paneRef, selfOpenedPane: false }
        }
      }

      let paneKey: string
      try {
        const result = await this.deps.openPromptPane({
          dedupeKey: `${ctx.runId}:${ctx.step.id}`,
          worktreeId: target.effectiveWorktreeId,
          agentId,
          prompt,
          ...(target.effectiveSummary
            ? {
                worktreePath: target.effectiveSummary.path,
                connectionId: target.effectiveSummary.connectionId
              }
            : {}),
          ...(target.memberScoped ? { memberScoped: true } : {})
        })
        paneKey = result.paneKey
        // Claim the freshly-opened key (always head since it's brand new) so a
        // concurrent reuse of this paneKey queues behind us until we release.
        this.deps.acquirePane(paneKey, paneToken)
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
      tracker = this.buildTracker(paneKey, {
        requiresWorkingFirst: false,
        selfOpenedPane: true
      })
      if (!runTrackers) {
        runTrackers = new Map()
        this.trackers.set(ctx.runId, runTrackers)
      }
      runTrackers.set(ctx.step.id, tracker)
      return {
        outcome: 'needs-more-time',
        status: 'running',
        openedPane: { paneKey, selfOpenedPane: true }
      }
    }

    const now = this.deps.now()

    // Per design § "Agent step lifecycle": the step-level timeout is the only
    // hard escape valve when the agent fails to converge on `done`. Check it
    // BEFORE reading status so a long-pending or missing status can still time
    // out cleanly — never gate the timeout on having a fresh status entry.
    if (ctx.step.timeoutSeconds != null) {
      const elapsedMs = now - tracker.openedAt
      if (elapsedMs >= ctx.step.timeoutSeconds * 1000) {
        // Release the pane on this terminal path so the next queued waiter can
        // drive — a dead holder would block the FIFO forever.
        this.releasePaneFor(ctx, tracker.paneKey)
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
      if (tracker.waitStartedAt == null) {
        tracker.waitStartedAt = now
      }
      return { outcome: 'needs-more-time', status: 'waiting' }
    }

    // Agent resumed from waiting — adjust timeout anchor to exclude wait duration.
    if (tracker.waitStartedAt != null) {
      tracker.openedAt += now - tracker.waitStartedAt
      tracker.waitStartedAt = null
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
      // Release the pane on success so the next queued waiter (e.g. a detached
      // watcher's response on the same pane) becomes head and can drive.
      this.releasePaneFor(ctx, tracker.paneKey)
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
  private buildTracker(
    paneKey: string,
    opts: { requiresWorkingFirst: boolean; selfOpenedPane: boolean }
  ): Tracker {
    const tracker: Tracker = {
      paneKey,
      openedAt: this.deps.now(),
      firstDoneAt: null,
      outputTail: null,
      workingSeen: false,
      requiresWorkingFirst: opts.requiresWorkingFirst,
      selfOpenedPane: opts.selfOpenedPane,
      waitStartedAt: null,
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
    for (const [stepId, tracker] of runTrackers) {
      this.cleanup(tracker)
      // Free the pane for every tracked step so a cancelled run never leaves a
      // dead holder blocking the FIFO.
      this.deps.releasePane(tracker.paneKey, `${runId}:${stepId}`)
    }
    this.trackers.delete(runId)
  }

  /** Drop a single step's tracker — used on retry-from-step so the retried
   *  step starts fresh while sibling completed steps' downstream context is
   *  preserved. When the tracker self-opened its pane (no paneRef reuse),
   *  also ask the renderer to close that pane so the retry doesn't leave
   *  the previous agent tab hanging next to a freshly-launched one. */
  dropStep(runId: string, stepId: string): void {
    const runTrackers = this.trackers.get(runId)
    const tracker = runTrackers?.get(stepId)
    if (!tracker) {
      return
    }
    this.cleanup(tracker)
    // Free the dropped step's pane so a retry-from-step (or any waiter behind
    // it) isn't blocked by a holder that no longer exists.
    this.deps.releasePane(tracker.paneKey, `${runId}:${stepId}`)
    if (tracker.selfOpenedPane) {
      this.deps.closePane?.(tracker.paneKey)
    }
    runTrackers!.delete(stepId)
    if (runTrackers!.size === 0) {
      this.trackers.delete(runId)
    }
  }
}
