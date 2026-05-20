import type { StepRunner, StepRunnerCtx, StepRunnerResult } from '../step-runner'
import type { RunCommandConfig } from '../../../shared/automations-types'
import type { PtyExitEntry } from '../../pty/exit-registry'
import { OpenCommandPaneError } from '../open-command-pane'
import { resolveTemplate, TemplateResolutionError } from '../template'
import { OutputTail } from '../output-tail'

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
  }) => Promise<{ ptyId: string; paneKey: string }>
  getPtyExit: (ptyId: string) => PtyExitEntry | undefined
  /** Subscribe to the main-process PTY data stream. Returns an unsubscribe
   *  fn. PTYs in this codebase emit a single merged stream — no stdout/stderr
   *  distinction at the PTY level — so the runner captures one tail. */
  subscribePtyData: (listener: (ptyId: string, data: string) => void) => () => void
  now: () => number
}

type Tracker = {
  ptyId: string
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
      try {
        worktreeId = resolveTemplate(config.worktreeRef, ctx.context)
        // Why: only the custom-source path carries a free-form command line;
        // for review / create-pr the commandId is a stable UUID into
        // settings.*Commands and does not need template resolution.
        customCommand =
          config.source === 'custom' && config.customCommand != null
            ? resolveTemplate(config.customCommand, ctx.context)
            : config.customCommand
      } catch (e) {
        // Template resolution errors can never succeed on retry (bad authoring
        // or missing context), so fail-fast instead of looping forever.
        if (e instanceof TemplateResolutionError) {
          return { outcome: 'failed', status: 'failed', error: e.message }
        }
        throw e
      }
      let ptyId: string
      let paneKey: string
      try {
        const result = await this.deps.openCommandPane({
          worktreeId,
          source: config.source,
          commandId: config.commandId,
          customCommand
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
        unsubscribe
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

    const exit = this.deps.getPtyExit(tracker.ptyId)

    if (!exit) {
      // PTY still running — no exit recorded yet. Keep ticking; the next tick
      // will look again. Subscription stays live so output accumulates.
      return { outcome: 'needs-more-time', status: 'running' }
    }

    // Why: per the chain-engine plan §Step 4, a non-zero exit code is still
    // `done` (not `failed`) — operators decide via `onFailure` or downstream
    // prompts whether a non-zero exit halts the chain. The runner's job is to
    // surface the exit code + outputTail in the step output, not to interpret
    // them. PTYs emit a single merged stream so this is one tail, not split
    // stdout/stderr.
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
}
