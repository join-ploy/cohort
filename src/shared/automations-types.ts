import type { SetupDecision, TuiAgent } from './types'

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
  | 'waiting'
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

// Grouped-workspaces discriminator: lets an automation address either a single
// repo (`single`) or a set of repos run together (`group`). Legacy automations
// have no `target`; readers should call `normalizeAutomationTarget` to inflate
// `projectId` into a `{ kind: 'single' }` value so downstream code can branch
// uniformly.
export type AutomationTarget =
  | { kind: 'single'; projectId: string }
  | { kind: 'group'; projectIds: string[]; groupBranchName?: string }

export type Automation = {
  id: string
  name: string
  prompt: string
  agentId: TuiAgent
  projectId: string
  // Optional discriminator added for grouped-workspaces. When absent, treat the
  // automation as `{ kind: 'single', projectId }` (see automation-target-migration).
  target?: AutomationTarget
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
  steps?: StepOrGroup[]
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
  // Optional at create time so legacy single-repo call sites stay unchanged;
  // grouped-workspace creators pass a `{ kind: 'group', ... }` value.
  target?: AutomationTarget
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
  steps?: StepOrGroup[]
  autoTriggers?: AutoTrigger[]
}

export type AutomationUpdateInput = Partial<
  Pick<
    Automation,
    | 'name'
    | 'prompt'
    | 'agentId'
    | 'projectId'
    | 'target'
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
    | 'autoTriggers'
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

// Renderer-facing projection of a FieldDescriptor. The main-process descriptor
// carries `fetchOptions: (ctx) => Promise<...>`, which cannot cross the IPC
// boundary; instead the renderer receives `hasFetchOptions` and calls the
// `triggerSources:fetchOptions` IPC when it needs the actual option list.
export type SerializableFieldDescriptor = {
  field: string
  label: string
  valueKind: 'user' | 'label' | 'state' | 'priority' | 'string' | 'number'
  ops: ConditionOp[]
  hasFetchOptions: boolean
}

export type SerializableTriggerSource = {
  id: TriggerSourceId
  displayName: string
  fieldCatalog: SerializableFieldDescriptor[]
}

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

// Persisted dedup record so a given (automation, autoTrigger, entity) only
// fires a run once across app restarts. Keyed on the tuple in `Store` ops.
export type AutoDedupEntry = {
  automationId: string
  autoTriggerId: string
  sourceId: TriggerSourceId
  entityId: string
  /** Optional human-readable id (e.g. 'ORC-123') for the dedup-management UI. */
  entityIdentifier?: string
  firedAt: number
  lastRunId?: string
}

export type StepKind =
  | 'run-prompt'
  | 'create-worktree'
  | 'create-workspace-group'
  | 'wait-for-setup'
  | 'run-command'
  | 'update-linear-issue'

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

// Why (grouped-workspaces L3): parallel to CreateWorktreeConfig but addresses N
// repos as members of a single WorkspaceGroup. `branchName` doubles as the
// group's workspaceName, parent folder name, and the per-member branch name —
// the IPC handler enforces that triple-purpose use, so we mirror it here so
// templates only need to resolve a single string.
export type CreateWorkspaceGroupConfig = {
  /** One per repo. Each becomes a member worktree under the group's parent
   *  folder. The IPC requires ≥2 members and rejects repo duplicates. */
  members: {
    repoId: string
    baseBranch: string // template
    setupDecision?: SetupDecision
  }[]
  /** Used as the group's workspaceName, parent folder name, and per-member
   *  branch name. Templated. */
  branchName: string
  /** Optional human-readable label for the group card. Templated. */
  displayName?: string
  linkLinearIssue?: boolean
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

// Mutates a Linear issue's assignee and/or stateId at run time. `issueRef` is
// almost always `{{trigger.linear.issue.id}}` from a Linear auto-trigger; the
// other two refs leave the existing value alone when unset/empty.
export type UpdateLinearIssueConfig = {
  issueRef: string // templated; usually {{trigger.linear.issue.id}}
  /** Linear team id — required to scope the assignee/state pickers in the
   *  editor. Optional because users can fall back to template-mode refs
   *  (e.g. echoing values from the trigger context) without picking a team.
   *  The runner ignores this field; it exists solely for editor UX. */
  teamId?: string
  /** Linear userId (literal, picker-selected) OR a templated string when the
   *  user toggles to template mode. Empty/unset = leave assignee alone. */
  assigneeRef?: string
  /** Linear stateId (literal) OR templated. Empty/unset = leave state alone. */
  stateRef?: string
}

export type StepConfig =
  | RunPromptConfig
  | CreateWorktreeConfig
  | CreateWorkspaceGroupConfig
  | WaitForSetupConfig
  | RunCommandConfig
  | UpdateLinearIssueConfig

export type Step = {
  id: string
  kind: StepKind
  config: StepConfig
  onFailure: 'halt' | 'continue'
  timeoutSeconds: number | null
}

export type StepOrGroup = Step | Step[]

export type StepRunStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'timed-out'

export type StepRunState = {
  stepId: string
  status: StepRunStatus
  startedAt: number | null
  finishedAt: number | null
  output: unknown // shape depends on kind; documented per-runner
  error: string | null
}
