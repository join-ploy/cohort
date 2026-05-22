import type {
  Automation,
  CreateWorkspaceGroupConfig,
  CreateWorktreeConfig,
  RunCommandConfig,
  RunPromptConfig,
  Step,
  StepConfig,
  StepKind,
  TriggerConfig,
  WaitForSetupConfig
} from '../../../../../shared/automations-types'
import {
  type ChainDraft,
  detectFutureReferences,
  walkStepConfigStrings
} from '../../../lib/chain-editor-state'
import {
  dryRunTemplate,
  type AvailableVariables,
  type TemplateError
} from '../../../lib/template-dry-run'
import {
  getOutputSchemaForKind,
  LINEAR_TICKET_TRIGGER_OVERLAY,
  MANUAL_TRIGGER_SCHEMA,
  type NestedSchema
} from '../../../../../shared/automation-step-schemas'

export type ChainEditorError = TemplateError & {
  stepId: string
  field: string
}

export const STEP_KIND_LABELS: Record<StepKind, string> = {
  'create-worktree': 'Create worktree',
  'create-workspace-group': 'Create workspace group',
  'wait-for-setup': 'Wait for setup',
  'run-prompt': 'Run prompt',
  'run-command': 'Run command'
}

// Why: `create-workspace-group` slots in next to `create-worktree` so the picker
// groups "creation" kinds together visually. ChainEditorModal filters this list
// further when the experimentalGroupedWorkspaces flag is off.
export const STEP_KIND_ORDER: StepKind[] = [
  'create-worktree',
  'create-workspace-group',
  'wait-for-setup',
  'run-prompt',
  'run-command'
]

// Why: legacy schedule/dispatch fields are dormant in v2 (manual trigger only)
// but must be preserved verbatim when editing an existing row so we don't
// regress scheduled rows back to defaults.
export const LEGACY_AUTOMATION_FIELDS = [
  'rrule',
  'dtstart',
  'timezone',
  'workspaceMode',
  'workspaceId',
  'baseBranch',
  'schedulerOwner',
  'missedRunPolicy',
  'missedRunGraceMinutes',
  'nextRunAt',
  'lastRunAt',
  'prompt',
  'agentId',
  'executionTargetType',
  'executionTargetId'
] as const

// Compose the trigger namespace shape by layering optional overlays onto the
// MANUAL_TRIGGER_SCHEMA base. Each overlay corresponds to a trigger-time input
// the user opted into on the draft.
//
// `acceptsProjectSelection` does not contribute an overlay: the picked project
// is materialized into `automation.projectId` at dispatch time so existing
// `{{automation.projectId}}` templates resolve unchanged.
export function buildTriggerSchema(trigger: TriggerConfig): NestedSchema {
  const base: NestedSchema = { ...MANUAL_TRIGGER_SCHEMA }
  if (trigger.acceptsLinearTicket) {
    base.linear = LINEAR_TICKET_TRIGGER_OVERLAY.linear
  }
  return base
}

/**
 * Builds the AvailableVariables snapshot for the step at `stepIndex`. Only
 * steps strictly before `stepIndex` are visible — a step cannot reference
 * itself or any later step.
 */
export function getAvailableVariablesAtStep(
  draft: ChainDraft,
  stepIndex: number
): AvailableVariables {
  const steps: Record<string, ReturnType<typeof getOutputSchemaForKind>> = {}
  for (let i = 0; i < stepIndex && i < draft.steps.length; i++) {
    const s = draft.steps[i]
    steps[s.id] = getOutputSchemaForKind(s.kind)
  }
  return {
    automation: { projectId: 'string', workspaceId: 'string' },
    trigger: buildTriggerSchema(draft.trigger),
    steps
  }
}

export function computeAllErrors(draft: ChainDraft): ChainEditorError[] {
  const all: ChainEditorError[] = []
  for (let i = 0; i < draft.steps.length; i++) {
    const step = draft.steps[i]
    const available = getAvailableVariablesAtStep(draft, i)
    walkStepConfigStrings(step.config, step.kind, (field, value) => {
      const errs = dryRunTemplate(value, available)
      for (const err of errs) {
        all.push({ ...err, stepId: step.id, field })
      }
    })
  }
  // Future-reference violations: same error list, different code so callers
  // can distinguish if they later want to render them separately.
  for (const v of detectFutureReferences(draft.steps)) {
    all.push({
      path: `steps.${v.toStepId}`,
      code: 'unknown-step',
      message: `Step '${v.fromStepId}' references future step '${v.toStepId}'.`,
      stepId: v.fromStepId,
      field: v.atField
    })
  }
  return all
}

export function seedDraft(automation: Automation | null): ChainDraft {
  if (!automation) {
    return {
      id: '',
      name: '',
      projectId: '',
      trigger: { kind: 'manual' },
      enabled: true,
      steps: [],
      autoTriggers: []
    }
  }
  return {
    id: automation.id,
    name: automation.name,
    projectId: automation.projectId,
    trigger: automation.trigger ?? { kind: 'manual' },
    enabled: automation.enabled,
    steps: automation.steps ?? [],
    autoTriggers: automation.autoTriggers ?? []
  }
}

export function defaultConfigForKind(kind: StepKind): StepConfig {
  switch (kind) {
    case 'create-worktree': {
      const cfg: CreateWorktreeConfig = {
        baseBranch: 'main',
        branchName: '',
        displayName: '',
        linkLinearIssue: false
      }
      return cfg
    }
    case 'create-workspace-group': {
      // Why: members start empty — the editor surfaces the multi-select so the
      // user picks ≥2 repos; the IPC handler validates that minimum at run time.
      const cfg: CreateWorkspaceGroupConfig = {
        members: [],
        branchName: '',
        displayName: '',
        linkLinearIssue: false
      }
      return cfg
    }
    case 'wait-for-setup': {
      const cfg: WaitForSetupConfig = {
        worktreeRef: '',
        requireSuccess: true
      }
      return cfg
    }
    case 'run-prompt': {
      const cfg: RunPromptConfig = {
        worktreeRef: '',
        agentId: 'claude',
        prompt: '',
        doneDebounceSeconds: 5
      }
      return cfg
    }
    case 'run-command': {
      const cfg: RunCommandConfig = {
        worktreeRef: '',
        source: 'review',
        captureStdout: false
      }
      return cfg
    }
  }
}

/**
 * Synthesizes a brand-new Automation skeleton for the "New" save path. The
 * parent is expected to assign the real id and persist; this just gives us a
 * full shape to spread into so the call site stays type-safe.
 */
export function createBlankAutomation(id: string, now: number): Automation {
  return {
    id,
    name: '',
    prompt: '',
    agentId: 'claude',
    projectId: '',
    executionTargetType: 'local',
    executionTargetId: '',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'existing',
    workspaceId: null,
    baseBranch: null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    rrule: '',
    dtstart: now,
    enabled: true,
    nextRunAt: 0,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 0,
    createdAt: now,
    updatedAt: now,
    trigger: { kind: 'manual' },
    steps: []
  }
}

// Re-export so the modal needs only one import for step types.
export type { Step, StepConfig, StepKind }
