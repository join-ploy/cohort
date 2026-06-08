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
  statusMessage?: string | null
  nextPollAt?: number | null
  /** Persists the paneKey this step opened (or attached to via paneRef) onto
   *  state.openedPane. The chain executor applies it on every tick regardless
   *  of outcome, so the field is available to the retry-cleanup path even
   *  after a restart wipes the runner's in-memory tracker map. */
  openedPane?: { paneKey: string; selfOpenedPane: boolean } | null
  /** When true with outcome 'done', the executor finalizes the run as
   *  'completed' immediately and does NOT advance to downstream steps. Used
   *  for a clean early exit (e.g. watch-pr when the PR is closed). */
  endChain?: boolean
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
