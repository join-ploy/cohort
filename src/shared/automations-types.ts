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
  // Operator-initiated stop. Distinct from `failed` so the UI can label the
  // outcome accurately and the run can still be retried.
  | 'cancelled'
  | 'skipped_missed'
  | 'skipped_unavailable'
  | 'skipped_needs_interactive_auth'
  | 'dispatch_failed'
export type AutomationRunTrigger = 'scheduled' | 'manual' | 'auto'

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
  autoTriggers?: AutoTrigger[]
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
  // Auto-trigger provenance: populated when `trigger === 'auto'` so the UI
  // and dedup logic can attribute the run to a source/rule/entity. Optional
  // for backwards compat with scheduled/manual rows.
  triggerSource?: TriggerSourceId
  triggerAutoTriggerId?: string
  triggerRuleId?: string
  triggerEntityId?: string
  restartedFromRunId?: string
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
  // Chain-shape automations carry their trigger config and step list here so
  // the editor can save them on first create. Both are optional so legacy
  // (rrule-only) create call sites stay unchanged.
  trigger?: TriggerConfig
  steps?: Step[]
  autoTriggers?: AutoTrigger[]
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
    | 'trigger'
    | 'steps'
  >
>

export type AutomationDispatchRequest = {
  automation: Automation
  run: AutomationRun
}

// Why: optional payload supplied by the renderer when an operator manually
// triggers a chain-shape automation. Linear issue + worktree selection are
// materialized into `run.context.trigger` so steps can template against
// `{{trigger.linear.issue.title}}` and `{{trigger.worktreeBranch}}` etc.
export type RunNowPayload = {
  linear?: { issue: LinearIssuePayload }
  // Operator-picked project at manual-run time. When set, takes precedence
  // over the automation's stored projectId for that run.
  projectId?: string
}

export type AutomationDispatchResult = {
  runId: string
  status: AutomationRunStatus
  workspaceId?: string | null
  terminalSessionId?: string | null
  error?: string | null
}

// Phase 1 chain types. Coexist with the legacy fields above during migration.

export type TriggerConfig = {
  kind: 'manual'
  // Both flags are optional so legacy persisted rows still parse without
  // migration. When set, the editor surfaces extra trigger-time inputs and the
  // dry-run validator exposes the matching overlay paths.
  acceptsLinearTicket?: boolean
  // When true, the operator picks a project at Run Now time instead of the
  // automation carrying a fixed projectId — the picked project becomes the
  // run's automation.projectId for downstream steps (e.g. create-worktree).
  acceptsProjectSelection?: boolean
}

// Auto-trigger source identifiers. Each source has its own poller wiring;
// extra sources will be added here as they come online.
export type TriggerSourceId = 'linear-issue'

export type ConditionOp =
  | 'is'
  | 'is-not'
  | 'is-any-of'
  | 'is-none-of'
  | 'contains-any'
  | 'contains-all'
  | 'contains-none'
  | 'gte'
  | 'lte'
  | 'eq'

export type ConditionValue = string | number | string[] | number[]

export type Condition = {
  field: string
  op: ConditionOp
  value: ConditionValue
}

export type Rule = {
  id: string
  conditions: Condition[]
  projectId: string
}

export type AutoTrigger = {
  id: string
  source: TriggerSourceId
  enabled: boolean
  enabledAt: number
  rules: Rule[]
}

export type StepKind = 'run-prompt' | 'create-worktree' | 'wait-for-setup' | 'run-command'

export type RunPromptConfig = {
  worktreeRef: string
  agentId: TuiAgent
  prompt: string
  doneDebounceSeconds: number
  // Optional handle for reusing an existing pane instead of opening a new one.
  paneRef?: string
}

// Snapshot of the Linear issue selected at manual-trigger time. Materialized
// into the run context so steps can template against the fields below.
export type LinearIssuePayload = {
  id: string
  identifier: string
  title: string
  description: string
  url: string
  assigneeEmail: string
  stateName: string
  priority: number
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
  // Optional paneKey of an existing pane (template, e.g.
  // `{{steps.<id>.paneKey}}`). When set, the command text is written to that
  // pane's PTY with a trailing newline (Enter) instead of spawning a new
  // pane. Only supported for `source: 'custom'` today; review/create-pr
  // commands require renderer-side resolution that doesn't compose with
  // existing-pane reuse.
  paneRef?: string
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
