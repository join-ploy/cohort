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
import type { Repo } from '../../../../../shared/types'
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
// down by removing `create-workspace-group` when settings.experimentalGroupedWorkspaces
// is false.
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
 *
 * Why `repos`: a `create-workspace-group` step in scope publishes the
 * `group.members.<repoFolderName>.*` namespace at runtime, keyed by the
 * basename of each member repo's path. We thread the store's repos through
 * so the discoverable schema lists real folder names (not just placeholders).
 * Defaulted to `[]` so call sites that don't yet plumb repos still typecheck
 * and fall back to a member-less namespace.
 */
export function getAvailableVariablesAtStep(
  draft: ChainDraft,
  stepIndex: number,
  repos: Repo[] = []
): AvailableVariables {
  const steps: Record<string, ReturnType<typeof getOutputSchemaForKind>> = {}
  let groupSchema: NestedSchema | undefined = undefined
  for (let i = 0; i < stepIndex && i < draft.steps.length; i++) {
    const s = draft.steps[i]
    steps[s.id] = getOutputSchemaForKind(s.kind)
    // Why: any earlier create-workspace-group step injects the top-level
    // `group.*` namespace. If multiple exist (rare), the latest wins —
    // mirrors runtime, where each step's contextPatch overwrites `group`.
    if (s.kind === 'create-workspace-group') {
      groupSchema = buildGroupSchema(s.config as CreateWorkspaceGroupConfig, repos)
    }
  }
  return {
    automation: { projectId: 'string', workspaceId: 'string' },
    trigger: buildTriggerSchema(draft.trigger),
    steps,
    group: groupSchema
  }
}

// Per-member leaf shape, mirroring buildGroupTemplateContext in
// src/main/workspace-group-runtime.ts. The runner emits strings for all four.
const GROUP_MEMBER_SHAPE: NestedSchema = {
  worktreeId: 'string',
  path: 'string',
  repoId: 'string',
  scoped: 'string'
}

/**
 * Build the discoverable schema for `group.*` from a draft
 * `create-workspace-group` step. Members are keyed by `<repoFolderName>` —
 * derived from each repo's on-disk basename (stripping the `.git` suffix bare
 * repos carry) so the editor's schema matches the runtime keying in
 * `buildGroupTemplateContext`.
 *
 * Members whose repoId doesn't resolve in the supplied repos list are skipped
 * — better to under-list than to mislead with a stale name. When the step
 * has no resolvable members yet (empty config OR repos haven't loaded), the
 * namespace still exists with the top-level keys plus an empty `members`
 * record so authors at least see that `group.id` / `group.parentPath` are
 * available.
 */
function buildGroupSchema(config: CreateWorkspaceGroupConfig, repos: Repo[]): NestedSchema {
  const members: NestedSchema = {}
  const reposById = new Map(repos.map((r) => [r.id, r]))
  for (const member of config.members) {
    const repo = reposById.get(member.repoId)
    if (!repo) {
      continue
    }
    const folder = repoFolderName(repo.path)
    if (!folder) {
      continue
    }
    members[folder] = GROUP_MEMBER_SHAPE
  }
  return {
    id: 'string',
    parentPath: 'string',
    members
  }
}

// Why: matches `repoFolderName` in src/main/ipc/workspace-groups.ts — the
// dispatcher's runtime keying derives from the same basename-minus-`.git`
// rule, so the editor's schema must too.
function repoFolderName(repoPath: string): string {
  const slashIdx = Math.max(repoPath.lastIndexOf('/'), repoPath.lastIndexOf('\\'))
  const base = slashIdx >= 0 ? repoPath.slice(slashIdx + 1) : repoPath
  return base.replace(/\.git$/, '')
}

export function computeAllErrors(draft: ChainDraft, repos: Repo[] = []): ChainEditorError[] {
  const all: ChainEditorError[] = []
  for (let i = 0; i < draft.steps.length; i++) {
    const step = draft.steps[i]
    const available = getAvailableVariablesAtStep(draft, i, repos)
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

/**
 * When the user adds a new step that has a `worktreeRef` slot, pick a sensible
 * default by walking the chain in reverse and referencing the most recent
 * step whose output exposes a worktree-equivalent value:
 *
 * - `create-worktree` exports `worktreeId`
 * - `create-workspace-group` exports `groupId` (the runner accepts either)
 *
 * Returns null when no such prior step exists — the consumer leaves the field
 * blank in that case so the user knows to fill it in (referencing an existing
 * workspace, a member-scoped group child, etc.).
 *
 * Why: the most common chain shape is "create something → run prompt against
 * it"; making the user retype the same `{{steps.<id>.<output>}}` template on
 * every new run-prompt is friction with zero upside.
 */
export function pickDefaultWorktreeRef(steps: Step[]): string | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]
    if (s.kind === 'create-worktree') {
      return `{{steps.${s.id}.worktreeId}}`
    }
    if (s.kind === 'create-workspace-group') {
      return `{{steps.${s.id}.groupId}}`
    }
  }
  return null
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
