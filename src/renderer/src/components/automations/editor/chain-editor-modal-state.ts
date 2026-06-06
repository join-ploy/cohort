import type {
  Automation,
  AutoTrigger,
  CollectCiResultsConfig,
  CreateWorkspaceGroupConfig,
  CreateWorktreeConfig,
  RunCommandConfig,
  RunPromptConfig,
  Step,
  StepConfig,
  StepKind,
  StepOrGroup,
  TriggerConfig,
  UpdateLinearIssueConfig,
  WaitForSetupConfig
} from '../../../../../shared/automations-types'
import type { Repo } from '../../../../../shared/types'
import {
  type ChainDraft,
  detectFutureReferences,
  flattenSteps,
  walkStepConfigStrings
} from '../../../lib/chain-editor-state'
import {
  dryRunTemplate,
  type AvailableVariables,
  type TemplateError
} from '../../../lib/template-dry-run'
import {
  GITHUB_PR_TRIGGER_OVERLAY,
  getOutputSchemaForKind,
  LINEAR_TICKET_TRIGGER_OVERLAY,
  MANUAL_TRIGGER_SCHEMA,
  type NestedSchema,
  type OutputSchema
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
  'run-command': 'Run command',
  'update-linear-issue': 'Update Linear issue',
  'collect-ci-results': 'Collect CI results'
}

// Why: `create-workspace-group` slots in next to `create-worktree` so the picker
// groups "creation" kinds together visually. `update-linear-issue` slots next
// to `run-prompt` — it's an effect step, not a creation step. `run-command`
// remains renderable for legacy chains but is no longer addable from the editor.
export const STEP_KIND_ORDER: StepKind[] = [
  'create-worktree',
  'create-workspace-group',
  'wait-for-setup',
  'run-prompt',
  'collect-ci-results',
  'update-linear-issue'
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
export function buildTriggerSchema(
  trigger: TriggerConfig,
  autoTriggers: AutoTrigger[] = []
): NestedSchema {
  const base: NestedSchema = { ...MANUAL_TRIGGER_SCHEMA }
  if (trigger.acceptsLinearTicket) {
    base.linear = LINEAR_TICKET_TRIGGER_OVERLAY.linear
  }
  // A configured + enabled auto-trigger publishes its payload shape at runtime,
  // so surface its variables in the picker too.
  if (autoTriggers.some((t) => t.enabled && t.source === 'github-pr')) {
    base.github = GITHUB_PR_TRIGGER_OVERLAY.github
  }
  // The http-endpoint source has no static overlay — its variables come from the
  // saved Test mapping, so build a flat `trigger.http.*` schema from enabled fields.
  // Only an enabled trigger contributes its overlay, mirroring the github-pr guard.
  const httpTrigger = autoTriggers.find((t) => t.enabled && t.source === 'http-endpoint' && t.http)
  if (httpTrigger?.http) {
    const httpSchema: OutputSchema = {}
    for (const f of httpTrigger.http.fields) {
      if (f.enabled) {
        httpSchema[f.variableName] = f.type === 'number' ? 'number' : 'string'
      }
    }
    base.http = httpSchema
  }
  return base
}

/**
 * Locates a flat step index within the `StepOrGroup[]` structure. Returns the
 * top-level position and, when the step lives inside a parallel group, the
 * set of sibling ids so callers can exclude concurrent outputs.
 */
function findStepPosition(
  steps: StepOrGroup[],
  flatIndex: number
): { topIndex: number; isInGroup: boolean; groupSiblingIds: Set<string> | null } {
  let count = 0
  for (let i = 0; i < steps.length; i++) {
    const item = steps[i]
    const size = Array.isArray(item) ? item.length : 1
    if (flatIndex < count + size) {
      if (Array.isArray(item)) {
        return { topIndex: i, isInGroup: true, groupSiblingIds: new Set(item.map((s) => s.id)) }
      }
      return { topIndex: i, isInGroup: false, groupSiblingIds: null }
    }
    count += size
  }
  return { topIndex: steps.length, isInGroup: false, groupSiblingIds: null }
}

/**
 * Builds the AvailableVariables snapshot for the step at `stepIndex` (a flat
 * index into the flattened step list). Only steps at strictly earlier
 * top-level positions are visible — a step cannot reference itself, any later
 * step, or a sibling within the same parallel group (concurrent outputs are
 * unavailable).
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
  const stepsSchema: Record<string, ReturnType<typeof getOutputSchemaForKind>> = {}
  // Why: the picker keys a step output's description off the step's kind, so we
  // carry the id→kind map alongside the schemas.
  const stepKinds: Record<string, StepKind> = {}
  let groupSchema: NestedSchema | undefined = undefined

  const { topIndex } = findStepPosition(draft.steps, stepIndex)

  for (let i = 0; i < topIndex && i < draft.steps.length; i++) {
    const item = draft.steps[i]
    const members = Array.isArray(item) ? item : [item]
    for (const s of members) {
      stepsSchema[s.id] = getOutputSchemaForKind(s.kind)
      stepKinds[s.id] = s.kind
      // Why: any earlier create-workspace-group step injects the top-level
      // `group.*` namespace. If multiple exist (rare), the latest wins —
      // mirrors runtime, where each step's contextPatch overwrites `group`.
      if (s.kind === 'create-workspace-group') {
        groupSchema = buildGroupSchema(s.config as CreateWorkspaceGroupConfig, repos)
      }
    }
  }

  return {
    automation: { projectId: 'string', workspaceId: 'string' },
    trigger: buildTriggerSchema(draft.trigger, draft.autoTriggers ?? []),
    steps: stepsSchema,
    stepKinds,
    group: groupSchema
  }
}

// Per-member leaf shape, mirroring buildGroupTemplateContext in
// src/main/workspace-group-runtime.ts. The runner emits strings for all keys
// — `description` is always present (empty string when the repo has no
// user-authored description) so a template referencing it never resolves
// against `undefined`.
const GROUP_MEMBER_SHAPE: NestedSchema = {
  worktreeId: 'string',
  path: 'string',
  repoId: 'string',
  scoped: 'string',
  description: 'string'
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
  const flat = flattenSteps(draft.steps)
  const seenStepIds = new Set<string>()
  for (let i = 0; i < flat.length; i++) {
    const step = flat[i]
    if (seenStepIds.has(step.id)) {
      all.push({
        path: step.id,
        code: 'unknown-path',
        message: `Step id '${step.id}' is used more than once. Parallel automation steps must have unique ids.`,
        stepId: step.id,
        field: 'id'
      })
    } else {
      seenStepIds.add(step.id)
    }
    const available = getAvailableVariablesAtStep(draft, i, repos)
    walkStepConfigStrings(step.config, step.kind, (field, value) => {
      const errs = dryRunTemplate(value, available)
      for (const err of errs) {
        all.push({ ...err, stepId: step.id, field })
      }
    })
  }
  // Parallel pane conflict: within a group, multiple steps targeting the same
  // paneRef would thrash a single pane with concurrent writes.
  for (const item of draft.steps) {
    if (!Array.isArray(item)) {
      continue
    }
    const paneRefs = new Map<string, string>()
    for (const step of item) {
      const config = step.config as { paneRef?: string }
      const ref = config.paneRef?.trim()
      if (!ref) {
        continue
      }
      const existing = paneRefs.get(ref)
      if (existing) {
        all.push({
          path: ref,
          code: 'unknown-path',
          message: `Parallel steps '${existing}' and '${step.id}' share the same paneRef — they would thrash one pane.`,
          stepId: step.id,
          field: 'paneRef'
        })
      } else {
        paneRefs.set(ref, step.id)
      }
    }
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
  // Why: a chain needs an upfront `automation.projectId` only when something
  // downstream actually consumes it — a create-worktree step, or any template
  // that references `{{automation.projectId}}`. Chains built around a
  // create-workspace-group step supply their repo context via the group's
  // `members[*].repoId` instead, so the upfront project is genuinely moot.
  if (!draft.projectId && isProjectRequired(draft)) {
    all.push({
      path: 'projectId',
      code: 'unknown-path',
      message: projectRequirementReason(draft),
      stepId: '',
      field: 'projectId'
    })
  }
  return all
}

/**
 * True when the chain has at least one step of the given kind. Pure helper
 * so the project-requirement rule can be unit-tested without ChainEditorModal.
 */
export function chainHasStep(draft: ChainDraft, kind: StepKind): boolean {
  return flattenSteps(draft.steps).some((s) => s.kind === kind)
}

/**
 * True when any step config template references `{{automation.projectId}}`.
 * Cheap string-scan over the template-string fields surfaced by
 * walkStepConfigStrings — exact enough for the editor's gate.
 */
export function chainReferencesAutomationProjectId(draft: ChainDraft): boolean {
  const pattern = /\{\{\s*automation\.projectId\s*\}\}/
  let found = false
  for (const step of flattenSteps(draft.steps)) {
    walkStepConfigStrings(step.config, step.kind, (_field, value) => {
      if (pattern.test(value)) {
        found = true
      }
    })
    if (found) {
      return true
    }
  }
  return false
}

/**
 * Project is required iff downstream code consumes it: a create-worktree step
 * (which reads `context.automation.projectId` to pick the repo) OR any
 * template that explicitly references `{{automation.projectId}}`. When the
 * trigger picks a project at Run Now time we already skip the check upstream.
 */
export function isProjectRequired(draft: ChainDraft): boolean {
  if (draft.trigger?.acceptsProjectSelection) {
    return false
  }
  return chainHasStep(draft, 'create-worktree') || chainReferencesAutomationProjectId(draft)
}

/**
 * Human-readable reason the project is required, so the modal can surface a
 * specific message rather than a generic "Project is required". Lets the
 * editor explain *why* the field gates Save in the group-chain case where a
 * template was responsible.
 */
function projectRequirementReason(draft: ChainDraft): string {
  if (chainReferencesAutomationProjectId(draft)) {
    return 'Project is required: a step references {{automation.projectId}}.'
  }
  if (chainHasStep(draft, 'create-worktree')) {
    return 'Project is required: the create-worktree step picks the repo from it.'
  }
  return 'Project is required'
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
export function pickDefaultWorktreeRef(steps: StepOrGroup[]): string | null {
  const flat = flattenSteps(steps)
  for (let i = flat.length - 1; i >= 0; i--) {
    const s = flat[i]
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
        source: 'custom',
        agentId: 'claude',
        prompt: '',
        doneDebounceSeconds: 5,
        skipIfNoChangesFromMain: false
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
    case 'update-linear-issue': {
      const cfg: UpdateLinearIssueConfig = {
        issueRef: '',
        assigneeRef: '',
        stateRef: ''
      }
      return cfg
    }
    case 'collect-ci-results': {
      const cfg: CollectCiResultsConfig = {
        worktreeRef: '',
        pollIntervalSeconds: 30,
        includeComments: true
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
export type { Step, StepConfig, StepKind, StepOrGroup }
