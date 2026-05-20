import type { Step, StepRunState } from '../../shared/automations-types'

export type StepRunnerCtx = {
  runId: string
  step: Step
  state: StepRunState
  context: Record<string, unknown>
}

export type StepRunnerOutcome = 'done' | 'failed' | 'needs-more-time'

export type StepRunnerResult = {
  outcome: StepRunnerOutcome
  status: StepRunState['status']
  output?: unknown
  error?: string | null
  contextPatch?: Record<string, unknown>
}

export type StepRunner = {
  tick(ctx: StepRunnerCtx): Promise<StepRunnerResult>
}
