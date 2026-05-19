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

type Tracker = { paneKey: string; firstDoneAt: number | null }

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
      tracker = { paneKey, firstDoneAt: null }
      if (!runTrackers) {
        runTrackers = new Map()
        this.trackers.set(ctx.runId, runTrackers)
      }
      runTrackers.set(ctx.step.id, tracker)
      return { outcome: 'needs-more-time', status: 'running' }
    }
    return { outcome: 'needs-more-time', status: 'running' }
  }
}
