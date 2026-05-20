import type { TuiAgent } from './types'

export type AutomationWorkspaceMode = 'existing' | 'new_per_run'
export type AutomationExecutionTargetType = 'local' | 'ssh'
export type AutomationSchedulerOwner = 'local_host_service' | 'ssh_bridge' | 'remote_host_service'
export type AutomationMissedRunPolicy = 'run_once_within_grace'
export type AutomationRunStatus =
  | 'pending'
  | 'dispatching'
  | 'dispatched'
  // Chain executor states (Phase 1). `running` covers any in-progress chain
  // tick; `failed` is the terminal halt state when a step's onFailure='halt'
  // triggers, distinct from `dispatch_failed` which is the pre-tick dispatch
  // error from the legacy path.
  | 'running'
  | 'failed'
  | 'completed'
  | 'skipped_missed'
  | 'skipped_unavailable'
  | 'skipped_needs_interactive_auth'
  | 'dispatch_failed'
export type AutomationRunTrigger = 'scheduled' | 'manual'

export type AutomationSchedulePreset = 'hourly' | 'daily' | 'weekdays' | 'weekly'

export type Automation = {
  id: string
  name: string
  prompt: string
  agentId: TuiAgent
  projectId: string
  executionTargetType: AutomationExecutionTargetType
  executionTargetId: string
  schedulerOwner: AutomationSchedulerOwner
  workspaceMode: AutomationWorkspaceMode
  workspaceId: string | null
  baseBranch: string | null
  timezone: string
  rrule: string
  dtstart: number
  enabled: boolean
  nextRunAt: number
  lastRunAt?: number
  missedRunPolicy: AutomationMissedRunPolicy
  missedRunGraceMinutes: number
  createdAt: number
  updatedAt: number
  trigger?: TriggerConfig
  steps?: Step[]
  haltOnFailure?: boolean
  maxConcurrentRuns?: number
  deduplicationKey?: string | null
}

export type AutomationRun = {
  id: string
  automationId: string
  title: string
  scheduledFor: number
  status: AutomationRunStatus
  trigger: AutomationRunTrigger
  workspaceId: string | null
  sessionKind: 'terminal'
  chatSessionId: string | null
  terminalSessionId: string | null
  error: string | null
  startedAt: number | null
  dispatchedAt: number | null
  createdAt: number
  /** Set by the chain executor when the run reaches a terminal status
   *  (`completed` or `failed`). Optional for backwards compat with rows
   *  written before Phase 1. */
  finishedAt?: number
  stepStates?: StepRunState[]
  context?: Record<string, unknown>
}

export type AutomationCreateInput = {
  name: string
  prompt: string
  agentId: TuiAgent
  projectId: string
  workspaceMode: AutomationWorkspaceMode
  workspaceId?: string | null
  baseBranch?: string | null
  timezone: string
  rrule: string
  dtstart: number
  enabled?: boolean
  missedRunGraceMinutes?: number
}

export type AutomationUpdateInput = Partial<
  Pick<
    Automation,
    | 'name'
    | 'prompt'
    | 'agentId'
    | 'projectId'
    | 'workspaceMode'
    | 'workspaceId'
    | 'baseBranch'
    | 'timezone'
    | 'rrule'
    | 'dtstart'
    | 'enabled'
    | 'missedRunGraceMinutes'
  >
>

export type AutomationDispatchRequest = {
  automation: Automation
  run: AutomationRun
}

export type AutomationDispatchResult = {
  runId: string
  status: AutomationRunStatus
  workspaceId?: string | null
  terminalSessionId?: string | null
  error?: string | null
}

// Phase 1 chain types. Coexist with the legacy fields above during migration.

export type TriggerConfig = { kind: 'manual' }

export type StepKind = 'run-prompt' | 'create-worktree' | 'wait-for-setup' | 'run-command'

export type RunPromptConfig = {
  worktreeRef: string
  agentId: TuiAgent
  prompt: string
  doneDebounceSeconds: number
}

export type CreateWorktreeConfig = {
  baseBranch: string // template
  branchName: string // template
  displayName: string // template
  linkLinearIssue: boolean
}

export type WaitForSetupConfig = {
  worktreeRef: string // template
  requireSuccess: boolean
}

export type RunCommandConfig = {
  worktreeRef: string // template
  source: 'review' | 'create-pr' | 'custom'
  commandId?: string // when source is 'review' | 'create-pr'
  customCommand?: string // when source is 'custom'
  captureStdout: boolean
}

export type StepConfig =
  | RunPromptConfig
  | CreateWorktreeConfig
  | WaitForSetupConfig
  | RunCommandConfig

export type Step = {
  id: string
  kind: StepKind
  config: StepConfig
  onFailure: 'halt' | 'continue'
  timeoutSeconds: number | null
}

export type StepRunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'timed-out'

export type StepRunState = {
  stepId: string
  status: StepRunStatus
  startedAt: number | null
  finishedAt: number | null
  output: unknown // shape depends on kind; documented per-runner
  error: string | null
}
