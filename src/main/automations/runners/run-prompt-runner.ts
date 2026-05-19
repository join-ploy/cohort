import type { StepRunner, StepRunnerCtx, StepRunnerResult } from '../step-runner'
import type { RunPromptConfig } from '../../../shared/automations-types'
import { OpenPromptPaneError } from '../open-prompt-pane'
import { resolveTemplate, TemplateResolutionError } from '../template'

export type AgentStatusEntry = {
  state: 'done' | 'working' | 'blocked' | 'waiting'
  updatedAt: number
}

export type RunPromptDeps = {
  openPromptPane: (params: {
    worktreeId: string
    agentId: string
    prompt: string
  }) => Promise<{ paneKey: string }>
  getAgentStatus: (paneKey: string) => AgentStatusEntry | undefined
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
}

export class RunPromptRunner implements StepRunner {
  // Nested map keyed by (runId, stepId) so a step.id containing ':' can't
  // collide with another run's tracker, and so a future run-level cleanup
  // can drop every tracker for a run with a single `trackers.delete(runId)`.
  private readonly trackers = new Map<string, Map<string, Tracker>>()

  constructor(private readonly deps: RunPromptDeps) {}

  async tick(ctx: StepRunnerCtx): Promise<StepRunnerResult> {
    const config = ctx.step.config as RunPromptConfig
    let runTrackers = this.trackers.get(ctx.runId)
    let tracker = runTrackers?.get(ctx.step.id)
    if (!tracker) {
      let worktreeId: string
      let prompt: string
      try {
        worktreeId = resolveTemplate(config.worktreeRef, ctx.context)
        prompt = resolveTemplate(config.prompt, ctx.context)
      } catch (e) {
        // Template resolution errors can never succeed on retry (bad authoring
        // or missing context), so fail-fast instead of looping forever.
        if (e instanceof TemplateResolutionError) {
          return { outcome: 'failed', status: 'failed', error: e.message }
        }
        throw e
      }
      let paneKey: string
      try {
        const result = await this.deps.openPromptPane({
          worktreeId,
          agentId: config.agentId,
          prompt
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
      tracker = { paneKey, openedAt: this.deps.now(), firstDoneAt: null }
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
      return { outcome: 'needs-more-time', status: 'running' }
    }

    // status.state === 'done'
    if (tracker.firstDoneAt == null) {
      tracker.firstDoneAt = now
      return { outcome: 'needs-more-time', status: 'running' }
    }
    const debounceMs = config.doneDebounceSeconds * 1000
    if (now - tracker.firstDoneAt >= debounceMs) {
      return {
        outcome: 'done',
        status: 'succeeded',
        output: { paneKey: tracker.paneKey, durationMs: now - tracker.openedAt }
      }
    }
    return { outcome: 'needs-more-time', status: 'running' }
  }
}
