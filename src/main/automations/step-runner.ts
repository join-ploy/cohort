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
  /** Drop any per-run state the runner has accumulated for `runId` — pane
   *  trackers, subscriptions, debounce counters. Called when a run is
   *  cancelled or retried so a re-tick doesn't pick up the previous
   *  attempt's tracker. Optional: runners that hold no per-run state can
   *  omit it. */
  dropRun?(runId: string): void
  /** Drop a single step's tracker without touching its sibling steps. Used
   *  by retry-from-step so completed steps' downstream context is preserved
   *  while the retried step starts fresh. */
  dropStep?(runId: string, stepId: string): void
}
