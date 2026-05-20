import type { StepRunner, StepRunnerCtx, StepRunnerResult } from '../step-runner'
import type { RunCommandConfig } from '../../../shared/automations-types'
import type { PtyExitEntry } from '../../pty/exit-registry'
import { OpenCommandPaneError } from '../open-command-pane'
import { resolveTemplate, TemplateResolutionError } from '../template'

export type RunCommandDeps = {
  openCommandPane: (params: {
    worktreeId: string
    source: 'review' | 'create-pr' | 'custom'
    commandId?: string
    customCommand?: string
  }) => Promise<{ ptyId: string; paneKey: string }>
  getPtyExit: (ptyId: string) => PtyExitEntry | undefined
  now: () => number
}

type Tracker = {
  ptyId: string
  paneKey: string
  /** Wall-clock when the pane was first opened — anchors the per-step timeout
   *  and is included in the success output so the executor can record run
   *  durations. Set once when the tracker is recorded; never re-stamped. */
  openedAt: number
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
      tracker = { ptyId, paneKey, openedAt: this.deps.now() }
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
      // will look again.
      return { outcome: 'needs-more-time', status: 'running' }
    }

    // Why: per the chain-engine plan §Step 4, a non-zero exit code is still
    // `done` (not `failed`) — operators decide via `onFailure` or downstream
    // prompts whether a non-zero exit halts the chain. The runner's job is to
    // surface the exit code in the step output, not to interpret it.
    //
    // `stdoutTail` from RunCommandConfig.captureStdout is intentionally NOT
    // implemented in this task per plan §Step 2 of P2.4. Output is the minimal
    // `{ exitCode, paneKey, durationMs }` triple.
    return {
      outcome: 'done',
      status: 'succeeded',
      output: {
        exitCode: exit.exitCode,
        paneKey: tracker.paneKey,
        durationMs: now - tracker.openedAt
      }
    }
  }
}
