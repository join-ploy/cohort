import type { StepRunner, StepRunnerCtx, StepRunnerResult } from '../step-runner'
import type { RunPromptConfig } from '../../../shared/automations-types'
import { resolveTemplate } from '../template'

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
  private readonly trackers = new Map<string, Tracker>()

  constructor(private readonly deps: RunPromptDeps) {}

  async tick(ctx: StepRunnerCtx): Promise<StepRunnerResult> {
    const config = ctx.step.config as RunPromptConfig
    const trackerKey = `${ctx.runId}:${ctx.step.id}`
    let tracker = this.trackers.get(trackerKey)
    if (!tracker) {
      const worktreeId = resolveTemplate(config.worktreeRef, ctx.context)
      const prompt = resolveTemplate(config.prompt, ctx.context)
      const { paneKey } = await this.deps.openPromptPane({
        worktreeId,
        agentId: config.agentId,
        prompt
      })
      tracker = { paneKey, firstDoneAt: null }
      this.trackers.set(trackerKey, tracker)
      return { outcome: 'needs-more-time', status: 'running' }
    }
    // Status polling lands in Task 6.
    return { outcome: 'needs-more-time', status: 'running' }
  }
}
