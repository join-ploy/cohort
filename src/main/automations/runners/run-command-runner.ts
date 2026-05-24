import type { StepRunner, StepRunnerCtx, StepRunnerResult } from '../step-runner'
import type { RunCommandConfig } from '../../../shared/automations-types'
import type { AgentStatusEntry } from '../../agent-status/registry'
import type { PtyExitEntry } from '../../pty/exit-registry'
import { OpenCommandPaneError } from '../open-command-pane'
import { SendCommandToPaneError } from '../send-command-to-pane'
import { resolveTemplate, TemplateResolutionError } from '../template'
import { OutputTail } from '../output-tail'
import { parseMemberScopedRef } from '../../../shared/automation-member-scoped-ref'

/** Debounce window for the agent-done completion path. An agent that briefly
 *  flips done → working → done shouldn't satisfy the gate on its first idle
 *  blip; require the done state to hold for this many ms before we treat the
 *  step as succeeded. Matches the `doneDebounceSeconds` default used by
 *  run-prompt (5s) so command-launched agents feel symmetric. */
const AGENT_DONE_DEBOUNCE_MS = 5_000

/** Cap PTY output capture at 32 KiB. Big enough to show a debuggable error
 *  tail; small enough that hundreds of concurrent chain runs can't pile up
 *  unbounded memory in the trackers map. */
const OUTPUT_TAIL_MAX_BYTES = 32 * 1024

export type RunCommandDeps = {
  openCommandPane: (params: {
    worktreeId: string
    source: 'review' | 'create-pr' | 'custom'
    commandId?: string
    customCommand?: string
    /** When the runner unwrapped a `member:<groupId>:<worktreeId>` ref, this
     *  flag forwards to the renderer hook which threads `keepCwd: true` into
     *  pty.spawn so Phase J1's CWD override is skipped and the agent runs at
     *  the member's worktreePath. */
    memberScoped?: boolean
  }) => Promise<{ ptyId: string; paneKey: string }>
  getPtyExit: (ptyId: string) => PtyExitEntry | undefined
  /** Subscribe to the main-process PTY data stream. Returns an unsubscribe
   *  fn. PTYs in this codebase emit a single merged stream — no stdout/stderr
   *  distinction at the PTY level — so the runner captures one tail. */
  subscribePtyData: (listener: (ptyId: string, data: string) => void) => () => void
  /** Resolve a Review / Create PR / custom command and write it (with Enter)
   *  into an existing pane. Used by the `paneRef` branch so a chain step can
   *  fire a follow-up command into a pane an earlier step opened. */
  sendCommandToPane?: (params: {
    paneKey: string
    source: 'review' | 'create-pr' | 'custom'
    commandId?: string
    customCommand?: string
    worktreeId: string
  }) => Promise<void>
  /** Reads the agent-status registry by paneKey. When the launched command is
   *  an agent (Review / Create PR usually launches Claude/Codex/etc.), the
   *  PTY stays open after the agent finishes — but the agent-status hook
   *  flips to `done`, which is the same completion signal run-prompt uses.
   *  Optional so existing test harnesses that don't wire it keep working. */
  getAgentStatus?: (paneKey: string) => AgentStatusEntry | undefined
  /** Resolves a `group:<uuid>` ref (the output of CreateWorkspaceGroupRunner)
   *  to the group's first member worktreeId so the command pane has something
   *  real to bind to. Phase J1's pty:spawn override then redirects CWD to the
   *  group's parentPath automatically because the member has groupId set.
   *  Optional so the unit-test harness that never addresses groups can skip
   *  the wiring. */
  getGroupSummary?: (groupId: string) => { firstMemberWorktreeId: string } | undefined
  now: () => number
}

type Tracker = {
  /** PTY id when the step spawned its own pane via openCommandPane. Undefined
   *  in the paneRef branch — we wrote into an existing pane and never owned
   *  a PTY, so the runner only watches agent-status for completion. */
  ptyId: string | null
  paneKey: string
  /** Wall-clock when the pane was first opened — anchors the per-step timeout
   *  and is included in the success output so the executor can record run
   *  durations. Set once when the tracker is recorded; never re-stamped. */
  openedAt: number
  /** Ring buffer holding the latest 32 KiB of merged PTY output. Filled via
   *  the subscription set up on first tick; surfaced in step output on exit. */
  outputTail: OutputTail
  /** Tears down the PTY data subscription. Called from cleanup() on any
   *  terminal outcome (done / failed / timed-out). MUST NOT be called on
   *  needs-more-time. */
  unsubscribe: () => void
  /** True when the tracker was created by reusing an existing pane (paneRef
   *  branch). The agent was already idle when we wrote into it, so a fresh
   *  `working` transition is required before any subsequent `done` can
   *  satisfy the debounce — otherwise the previous turn's lingering `done`
   *  would let the step succeed before the new command produced any work. */
  requiresWorkingFirst: boolean
  /** First-seen `done` timestamp from the agent-status registry. Anchors the
   *  AGENT_DONE_DEBOUNCE_MS gate so a flicker done → working → done can't
   *  count as completion. Reset to null whenever the agent flips back to
   *  `working`. Only relevant when the launched command attaches an agent
   *  hook; pure-shell commands never populate agent-status and fall through
   *  to the PTY-exit path. */
  agentFirstDoneAt: number | null
  /** Set the first time we observe the agent in the `working` state. Marks
   *  the boundary where the outputTail is scoped to just the current turn:
   *  on first `working` we drop accumulated startup/render output so the
   *  tail surfaced on completion is the agent's response to the prompt. */
  workingSeen: boolean
}

export class RunCommandRunner implements StepRunner {
  // Nested map keyed by (runId, stepId) so a step.id containing ':' can't
  // collide with another run's tracker, and so a future run-level cleanup
  // can drop every tracker for a run with a single `trackers.delete(runId)`.
  // Why: tracker cleanup is deferred — the chain executor (Task 7) will call
  // a release hook on run completion, since runner instances are singletons
  // per AutomationService and outlive any individual run.
  private readonly trackers = new Map<string, Map<string, Tracker>>()

  constructor(private readonly deps: RunCommandDeps) {}

  async tick(ctx: StepRunnerCtx): Promise<StepRunnerResult> {
    const config = ctx.step.config as RunCommandConfig
    let runTrackers = this.trackers.get(ctx.runId)
    let tracker = runTrackers?.get(ctx.step.id)
    if (!tracker) {
      let worktreeId: string
      let customCommand: string | undefined
      let resolvedPaneRef = ''
      let memberScoped = false
      try {
        worktreeId = resolveTemplate(config.worktreeRef, ctx.context)
        // Why (grouped-workspaces parity with run-prompt-runner): a resolved
        // `group:<uuid>` ref must be redirected to a real member worktreeId
        // before we hand it to openCommandPane, which fails with "Worktree is
        // no longer available" because the registry is keyed by member
        // worktreeId. The Phase J1 pty:spawn override then plants the CWD at
        // the group's parentPath automatically because the member carries
        // groupId. Member-scoped refs (`member:<groupId>:<worktreeId>`) are
        // unwrapped to the inner worktreeId AND `memberScoped: true` is
        // forwarded to the openCommandPane payload — the renderer hook then
        // passes `keepCwd: true` to pty.spawn so Phase J1 skips the override
        // and the agent runs at the member's path (not the group's parent).
        const memberScopedRef = parseMemberScopedRef(worktreeId)
        if (memberScopedRef) {
          worktreeId = memberScopedRef.worktreeId
          memberScoped = true
        } else if (worktreeId.startsWith('group:')) {
          const groupSummary = this.deps.getGroupSummary?.(worktreeId)
          if (!groupSummary) {
            return {
              outcome: 'failed',
              status: 'failed',
              error: `Group not found for worktreeRef "${worktreeId}".`
            }
          }
          worktreeId = groupSummary.firstMemberWorktreeId
        }
        // Why: only the custom-source path carries a free-form command line;
        // for review / create-pr the commandId is a stable UUID into
        // settings.*Commands and does not need template resolution.
        customCommand =
          config.source === 'custom' && config.customCommand != null
            ? resolveTemplate(config.customCommand, ctx.context)
            : config.customCommand
        // Why: paneRef is optional; only resolve when present so chains
        // without it don't fail on a missing template input.
        resolvedPaneRef = config.paneRef ? resolveTemplate(config.paneRef, ctx.context) : ''
      } catch (e) {
        // Template resolution errors can never succeed on retry (bad authoring
        // or missing context), so fail-fast instead of looping forever.
        if (e instanceof TemplateResolutionError) {
          return { outcome: 'failed', status: 'failed', error: e.message }
        }
        throw e
      }

      // paneRef branch: write the command + Enter into an existing pane
      // instead of spawning a new PTY. Delegated to the renderer because
      // review/create-pr need the same settings + hooks-preferences
      // resolution that `openCommandPane` does, and custom commands likewise
      // run through the same code path for consistency.
      const paneRef = resolvedPaneRef.trim()
      if (paneRef.length > 0) {
        if (config.source === 'custom' && (customCommand ?? '').trim().length === 0) {
          return {
            outcome: 'failed',
            status: 'failed',
            error: 'run-command with paneRef requires a non-empty customCommand.'
          }
        }
        if (!this.deps.sendCommandToPane) {
          throw new Error('RunCommandRunner: sendCommandToPane dep not wired.')
        }
        // Why: pre-send wait gate — never write into a pane mid-turn. A
        // `working` agent is still composing/executing, so we hold off until
        // it returns to `done`. Returning `needs-more-time` (not `failed`)
        // lets the per-step timeout be the only escape valve. Mirrors the
        // run-prompt paneRef branch.
        const preStatus = this.deps.getAgentStatus?.(paneRef)
        if (preStatus?.state === 'working') {
          return { outcome: 'needs-more-time', status: 'running' }
        }
        if (preStatus?.state === 'blocked' || preStatus?.state === 'waiting') {
          return {
            outcome: 'failed',
            status: 'failed',
            error: `Agent needs human input (${preStatus.state}). Chain halted.`
          }
        }
        try {
          await this.deps.sendCommandToPane({
            paneKey: paneRef,
            source: config.source,
            commandId: config.commandId,
            customCommand,
            worktreeId
          })
        } catch (e) {
          // Deterministic renderer failure (pane gone, command id unknown,
          // write rejected) — fail fast. Transient errors re-throw so the
          // executor retries.
          if (e instanceof SendCommandToPaneError) {
            return { outcome: 'failed', status: 'failed', error: e.message }
          }
          throw e
        }
        // Why: the write delivered the prompt/command to the agent, but the
        // step isn't complete until the agent processes it and goes idle
        // again. Create a tracker that polls agent-status (same as the
        // openCommandPane branch + agent-status flow below) and wait. The
        // `requiresWorkingFirst` flag prevents the previous turn's `done`
        // from satisfying the debounce before the agent picks up the new
        // input.
        const outputTail = new OutputTail(OUTPUT_TAIL_MAX_BYTES)
        tracker = {
          ptyId: null,
          paneKey: paneRef,
          openedAt: this.deps.now(),
          outputTail,
          unsubscribe: () => {},
          agentFirstDoneAt: null,
          workingSeen: false,
          requiresWorkingFirst: true
        }
        if (!runTrackers) {
          runTrackers = new Map()
          this.trackers.set(ctx.runId, runTrackers)
        }
        runTrackers.set(ctx.step.id, tracker)
        return { outcome: 'needs-more-time', status: 'running' }
      }

      let ptyId: string
      let paneKey: string
      try {
        const result = await this.deps.openCommandPane({
          worktreeId,
          source: config.source,
          commandId: config.commandId,
          customCommand,
          ...(memberScoped ? { memberScoped: true } : {})
        })
        ptyId = result.ptyId
        paneKey = result.paneKey
      } catch (e) {
        // Why: OpenCommandPaneError signals a deterministic renderer-side
        // failure (missing command id, unknown worktree, prompt-write failure)
        // — same fail-fast semantics as TemplateResolutionError above. Plain
        // Errors here are transient (destroyed webContents, timeout) so they
        // re-throw and the executor retries on the next tick.
        if (e instanceof OpenCommandPaneError) {
          return { outcome: 'failed', status: 'failed', error: e.message }
        }
        throw e
      }
      // Subscribe BEFORE recording the tracker so we never miss data between
      // openCommandPane resolving and the first data event. The filter on
      // dataPtyId keeps the runner from buffering output from unrelated PTYs.
      const outputTail = new OutputTail(OUTPUT_TAIL_MAX_BYTES)
      const capturedPtyId = ptyId
      const unsubscribe = this.deps.subscribePtyData((dataPtyId, data) => {
        if (dataPtyId === capturedPtyId) {
          outputTail.append(data)
        }
      })
      tracker = {
        ptyId,
        paneKey,
        openedAt: this.deps.now(),
        outputTail,
        unsubscribe,
        agentFirstDoneAt: null,
        workingSeen: false,
        // Why: fresh-pane case — the agent boots into `working` on first
        // input, so the standard done-debounce already covers it. No need
        // for the requiresWorkingFirst gate that the paneRef branch uses.
        requiresWorkingFirst: false
      }
      if (!runTrackers) {
        runTrackers = new Map()
        this.trackers.set(ctx.runId, runTrackers)
      }
      runTrackers.set(ctx.step.id, tracker)
      return { outcome: 'needs-more-time', status: 'running' }
    }

    const now = this.deps.now()

    // Per design § "Agent step lifecycle": the step-level timeout is the only
    // hard escape valve when the command fails to exit. Check it BEFORE reading
    // the exit registry so a permanently-hung PTY can still time out cleanly.
    if (ctx.step.timeoutSeconds != null) {
      const elapsedMs = now - tracker.openedAt
      if (elapsedMs >= ctx.step.timeoutSeconds * 1000) {
        this.cleanup(tracker)
        return {
          outcome: 'failed',
          status: 'timed-out',
          error: `Step exceeded timeout of ${ctx.step.timeoutSeconds}s.`
        }
      }
    }

    // Why: paneRef trackers don't own a PTY (they wrote into someone else's
    // pane), so PTY exit is meaningless for them — they always rely on the
    // agent-status `done` path below.
    const exit = tracker.ptyId !== null ? this.deps.getPtyExit(tracker.ptyId) : undefined
    if (exit) {
      // Why: per the chain-engine plan §Step 4, a non-zero exit code is still
      // `done` (not `failed`) — operators decide via `onFailure` or
      // downstream prompts whether a non-zero exit halts the chain. The
      // runner's job is to surface the exit code + outputTail in the step
      // output, not to interpret them. PTYs emit a single merged stream so
      // this is one tail, not split stdout/stderr.
      const output = {
        exitCode: exit.exitCode,
        paneKey: tracker.paneKey,
        durationMs: now - tracker.openedAt,
        outputTail: tracker.outputTail.read()
      }
      this.cleanup(tracker)
      return {
        outcome: 'done',
        status: 'succeeded',
        output,
        contextPatch: { steps: { [ctx.step.id]: output } }
      }
    }

    // Why: agent-launching commands (Review / Create PR usually fire Claude,
    // Codex, etc.) finish their turn but keep the PTY alive — so polling
    // `getPtyExit` would wait until the step timeout. The agent-status hook
    // flips to `done` when the agent is idle, mirroring run-prompt's
    // completion signal. If the registry sees `done` AND a debounce window
    // has elapsed (so a flicker can't satisfy the gate), succeed the step.
    // Pure-shell commands never populate agent-status, so this branch is a
    // no-op for them and PTY exit above remains the only completion path.
    const agentStatus = this.deps.getAgentStatus?.(tracker.paneKey)
    if (agentStatus?.state === 'blocked' || agentStatus?.state === 'waiting') {
      // Same halt semantics as run-prompt's polling branch: can't make
      // progress when the agent is asking for human input.
      this.cleanup(tracker)
      return {
        outcome: 'failed',
        status: 'failed',
        error: `Agent needs human input (${agentStatus.state}). Chain halted.`
      }
    }
    if (agentStatus?.state === 'working') {
      // Any work flip after a done ping invalidates the debounce window.
      tracker.agentFirstDoneAt = null
      // Why: scope the outputTail to a single agent turn. Without this the
      // tail accumulates the full pane history (warm-up render, prior
      // prompts the agent answered, etc.). Clearing on the working
      // transition means whatever lands in the tail by the time we read it
      // on `done` is the agent's response to the current prompt.
      if (!tracker.workingSeen) {
        tracker.workingSeen = true
        tracker.outputTail.reset()
      }
    } else if (agentStatus?.state === 'done') {
      // Why: paneRef reuse — the previous turn's `done` was the state when
      // we wrote into the pane. Wait until the agent picks up the input
      // (working) at least once before allowing `done` to advance the gate.
      if (tracker.requiresWorkingFirst && !tracker.workingSeen) {
        return { outcome: 'needs-more-time', status: 'running' }
      }
      if (tracker.agentFirstDoneAt == null) {
        tracker.agentFirstDoneAt = now
      } else if (now - tracker.agentFirstDoneAt >= AGENT_DONE_DEBOUNCE_MS) {
        // Prefer the hook-reported assistant reply (Claude Code's Stop hook,
        // Codex's prompt_response, OpenCode's message.parts[role=assistant],
        // …) over the PTY tail — it's the agent's actual response text with
        // no ANSI/box-drawing noise. Fall back to the captured PTY tail when
        // no hook carried the field. See run-prompt-runner for the same
        // pattern.
        const output = {
          // Why: no real exit code from a still-open PTY — surface 0 so
          // downstream templating against `steps.<id>.exitCode` stays
          // typeable. The agent-status `done` path implies a successful
          // turn from the agent's perspective.
          exitCode: 0,
          paneKey: tracker.paneKey,
          durationMs: now - tracker.openedAt,
          outputTail: agentStatus.lastAssistantMessage ?? tracker.outputTail.read()
        }
        this.cleanup(tracker)
        return {
          outcome: 'done',
          status: 'succeeded',
          output,
          contextPatch: { steps: { [ctx.step.id]: output } }
        }
      }
    }

    // No terminal signal yet (PTY still running, agent still working or no
    // agent attached). Keep ticking; the next tick will look again.
    // Subscription stays live so output accumulates.
    return { outcome: 'needs-more-time', status: 'running' }
  }

  /** Tear down the PTY data subscription on a terminal outcome. MUST only be
   *  called on done/failed/timed-out — calling on needs-more-time would drop
   *  output between ticks. The subscription's filter ensures a fresh tracker
   *  for the same step (if such a retry ever existed) wouldn't see stale data
   *  via the old listener. */
  private cleanup(tracker: Tracker): void {
    try {
      tracker.unsubscribe()
    } catch (err) {
      // Why: an unsubscribe that throws would otherwise leak — but it also
      // shouldn't break the step's terminal outcome. Log and move on; the
      // tracker is about to be GC'd anyway.
      console.error('[run-command-runner] unsubscribe threw:', err)
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
