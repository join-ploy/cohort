import type {
  Step,
  StepOrGroup,
  StepKind,
  StepConfig,
  TriggerConfig,
  AutoTrigger,
  CreateWorkspaceGroupConfig,
  CreateWorktreeConfig,
  WaitForSetupConfig,
  RunPromptConfig,
  RunCommandConfig,
  CollectCiResultsConfig,
  UpdateLinearIssueConfig
} from '../../../shared/automations-types'

/**
 * ChainDraft mirrors the persisted Automation shape but with only the fields
 * the editor cares about (name, projectId, trigger, steps, enabled,
 * autoTriggers). It is the in-memory state of the chain editor modal.
 */
export type ChainDraft = {
  id: string
  name: string
  projectId: string
  trigger: TriggerConfig
  enabled: boolean
  steps: StepOrGroup[]
  autoTriggers: AutoTrigger[]
}

export type FutureReferenceViolation = {
  fromStepId: string
  toStepId: string
  atField: string
}

const STEP_ID_REGEX = /^[a-z0-9][a-z0-9-]*$/

/**
 * Validates a step id. The chain executor uses step ids inside template paths
 * (`{{steps.<id>.<key>}}`), so we require kebab-case to avoid the parser having
 * to handle quoted or escaped segments.
 */
export function isValidStepId(id: string): boolean {
  if (!id) {
    return false
  }
  return STEP_ID_REGEX.test(id)
}

/**
 * Returns a default step id of the form `<kind>-<n>` where <n> is one greater
 * than the largest existing counter across all steps with the same kind prefix.
 * Scans only ids that match the exact pattern so renamed/custom ids do not
 * cause collisions.
 */
export function generateDefaultStepId(kind: StepKind, steps: StepOrGroup[]): string {
  const counterRegex = new RegExp(`^${escapeRegex(kind)}-(\\d+)$`)
  let max = 0
  for (const step of flattenSteps(steps)) {
    const match = counterRegex.exec(step.id)
    if (!match) {
      continue
    }
    const n = Number.parseInt(match[1], 10)
    if (Number.isFinite(n) && n > max) {
      max = n
    }
  }
  return `${kind}-${max + 1}`
}

/**
 * Renames a step and rewrites every `{{steps.<oldId>.x}}` reference inside the
 * remaining steps' template-string fields. Throws if the new id is invalid or
 * collides with another step's id. Returns a new array (steps are not mutated).
 */
export function renameStepWithRewrites(
  steps: StepOrGroup[],
  oldId: string,
  newId: string
): StepOrGroup[] {
  if (!isValidStepId(newId)) {
    throw new Error(`Step id '${newId}' is invalid; must be kebab-case (lowercase + digits + '-').`)
  }
  if (oldId === newId) {
    return steps.slice()
  }
  for (const step of flattenSteps(steps)) {
    if (step.id !== oldId && step.id === newId) {
      throw new Error(`Step id '${newId}' is already in use.`)
    }
  }

  // Trailing `.` ensures we do not match an id that simply has <oldId> as a
  // prefix (e.g. renaming `cw1` does not touch `{{steps.cw10.x}}`).
  const refPattern = new RegExp(`\\{\\{steps\\.${escapeRegex(oldId)}\\.`, 'g')
  const replacement = `{{steps.${newId}.`

  const rewriteStep = (step: Step): Step => {
    const nextId = step.id === oldId ? newId : step.id
    const nextConfig = rewriteConfigStrings(step.config, step.kind, (value) =>
      value.replace(refPattern, replacement)
    )
    return { ...step, id: nextId, config: nextConfig }
  }

  return steps.map((item) => {
    if (Array.isArray(item)) {
      return item.map(rewriteStep)
    }
    return rewriteStep(item)
  })
}

/**
 * Returns a new array with the step at `fromIndex` moved to `toIndex`. Pure
 * splice — does not mutate the input array.
 */
export function reorderSteps(
  steps: StepOrGroup[],
  fromIndex: number,
  toIndex: number
): StepOrGroup[] {
  const next = steps.slice()
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next
}

/**
 * Finds every place a step references another step that appears later in the
 * chain. A chain with future references cannot execute correctly because the
 * referenced step has not yet produced output when the referring step runs.
 */
export function detectFutureReferences(steps: StepOrGroup[]): FutureReferenceViolation[] {
  const violations: FutureReferenceViolation[] = []
  const indexById = new Map<string, number>()
  // Group members share the group's top-level position so they're "concurrent".
  const groupById = new Map<string, Set<string>>()

  steps.forEach((item, i) => {
    if (Array.isArray(item)) {
      const siblingIds = new Set(item.map((s) => s.id))
      for (const s of item) {
        indexById.set(s.id, i)
        groupById.set(s.id, siblingIds)
      }
    } else {
      indexById.set(item.id, i)
    }
  })

  const refRegexSource = /\{\{steps\.([a-z0-9][a-z0-9-]*)\.[^}]+\}\}/.source
  const flat = flattenSteps(steps)

  flat.forEach((step) => {
    const myPos = indexById.get(step.id)!
    const mySiblings = groupById.get(step.id)
    walkStepConfigStrings(step.config, step.kind, (field, value) => {
      if (!value) {
        return
      }
      // Local regex per call so lastIndex stays isolated.
      const re = new RegExp(refRegexSource, 'g')
      let match: RegExpExecArray | null
      while ((match = re.exec(value)) !== null) {
        const toStepId = match[1]
        const toPos = indexById.get(toStepId)
        if (toPos === undefined) {
          continue
        }
        // Future reference: target is at a later top-level position.
        if (toPos > myPos) {
          violations.push({ fromStepId: step.id, toStepId, atField: field })
        }
        // Sibling reference within same parallel group: also a violation
        // because siblings run concurrently and outputs are unavailable.
        else if (toPos === myPos && mySiblings?.has(toStepId) && toStepId !== step.id) {
          violations.push({ fromStepId: step.id, toStepId, atField: field })
        }
      }
    })
  })

  return violations
}

/**
 * Calls `visit(field, value)` for each template-string field in a step config.
 * Each step kind owns its own set of template fields; this helper centralizes
 * that knowledge so callers (rename, future-ref detection) do not duplicate it.
 */
export function walkStepConfigStrings(
  config: StepConfig,
  kind: StepKind,
  visit: (field: string, value: string) => void
): void {
  switch (kind) {
    case 'create-worktree': {
      const c = config as CreateWorktreeConfig
      if (typeof c.baseBranch === 'string') {
        visit('baseBranch', c.baseBranch)
      }
      if (typeof c.branchName === 'string') {
        visit('branchName', c.branchName)
      }
      if (typeof c.displayName === 'string') {
        visit('displayName', c.displayName)
      }
      break
    }
    case 'create-workspace-group': {
      const c = config as CreateWorkspaceGroupConfig
      if (typeof c.branchName === 'string') {
        visit('branchName', c.branchName)
      }
      if (typeof c.displayName === 'string') {
        visit('displayName', c.displayName)
      }
      // Why: per-member baseBranch is template-resolved at run time; surface
      // each as `members[<i>].baseBranch` so dry-run errors point at the row.
      c.members.forEach((member, idx) => {
        if (typeof member.baseBranch === 'string') {
          visit(`members[${idx}].baseBranch`, member.baseBranch)
        }
      })
      break
    }
    case 'wait-for-setup': {
      const c = config as WaitForSetupConfig
      if (typeof c.worktreeRef === 'string') {
        visit('worktreeRef', c.worktreeRef)
      }
      break
    }
    case 'run-prompt': {
      const c = config as RunPromptConfig
      if (typeof c.worktreeRef === 'string') {
        visit('worktreeRef', c.worktreeRef)
      }
      if (typeof c.prompt === 'string') {
        visit('prompt', c.prompt)
      }
      if (typeof c.promptOverride === 'string') {
        visit('promptOverride', c.promptOverride)
      }
      if (typeof c.paneRef === 'string') {
        visit('paneRef', c.paneRef)
      }
      break
    }
    case 'run-command': {
      const c = config as RunCommandConfig
      if (typeof c.worktreeRef === 'string') {
        visit('worktreeRef', c.worktreeRef)
      }
      if (c.source === 'custom' && typeof c.customCommand === 'string') {
        visit('customCommand', c.customCommand)
      }
      if (typeof c.paneRef === 'string') {
        visit('paneRef', c.paneRef)
      }
      break
    }
    case 'update-linear-issue': {
      const c = config as UpdateLinearIssueConfig
      if (typeof c.issueRef === 'string') {
        visit('issueRef', c.issueRef)
      }
      if (typeof c.assigneeRef === 'string') {
        visit('assigneeRef', c.assigneeRef)
      }
      if (typeof c.stateRef === 'string') {
        visit('stateRef', c.stateRef)
      }
      break
    }
    case 'collect-ci-results': {
      const c = config as CollectCiResultsConfig
      if (typeof c.worktreeRef === 'string') {
        visit('worktreeRef', c.worktreeRef)
      }
      break
    }
    // Deferred no-op (mirrors rewriteConfigStrings): visiting the request step's
    // url/headers[].value/query[].value/body would let dry-run + id-rename see its
    // templates. Safe to defer — the editor has no template autocomplete for these
    // fields yet, and the runner resolves them loudly at run time (a bad ref fails
    // the step). Wire both visitors when step-request template autocomplete lands.
    case 'http-request':
      break
  }
}

/**
 * Returns a copy of `config` with each template-string field mapped through
 * `transform`. Mirrors the field set of `walkStepConfigStrings`.
 */
function rewriteConfigStrings(
  config: StepConfig,
  kind: StepKind,
  transform: (value: string) => string
): StepConfig {
  switch (kind) {
    case 'create-worktree': {
      const c = config as CreateWorktreeConfig
      return {
        ...c,
        baseBranch: typeof c.baseBranch === 'string' ? transform(c.baseBranch) : c.baseBranch,
        branchName: typeof c.branchName === 'string' ? transform(c.branchName) : c.branchName,
        displayName: typeof c.displayName === 'string' ? transform(c.displayName) : c.displayName
      }
    }
    case 'create-workspace-group': {
      const c = config as CreateWorkspaceGroupConfig
      return {
        ...c,
        branchName: typeof c.branchName === 'string' ? transform(c.branchName) : c.branchName,
        displayName: typeof c.displayName === 'string' ? transform(c.displayName) : c.displayName,
        members: c.members.map((m) => ({
          ...m,
          baseBranch: typeof m.baseBranch === 'string' ? transform(m.baseBranch) : m.baseBranch
        }))
      }
    }
    case 'wait-for-setup': {
      const c = config as WaitForSetupConfig
      return {
        ...c,
        worktreeRef: typeof c.worktreeRef === 'string' ? transform(c.worktreeRef) : c.worktreeRef
      }
    }
    case 'run-prompt': {
      const c = config as RunPromptConfig
      return {
        ...c,
        worktreeRef: typeof c.worktreeRef === 'string' ? transform(c.worktreeRef) : c.worktreeRef,
        prompt: typeof c.prompt === 'string' ? transform(c.prompt) : c.prompt,
        promptOverride:
          typeof c.promptOverride === 'string' ? transform(c.promptOverride) : c.promptOverride,
        paneRef: typeof c.paneRef === 'string' ? transform(c.paneRef) : c.paneRef
      }
    }
    case 'run-command': {
      const c = config as RunCommandConfig
      return {
        ...c,
        worktreeRef: typeof c.worktreeRef === 'string' ? transform(c.worktreeRef) : c.worktreeRef,
        customCommand:
          c.source === 'custom' && typeof c.customCommand === 'string'
            ? transform(c.customCommand)
            : c.customCommand,
        paneRef: typeof c.paneRef === 'string' ? transform(c.paneRef) : c.paneRef
      }
    }
    case 'update-linear-issue': {
      const c = config as UpdateLinearIssueConfig
      return {
        ...c,
        issueRef: typeof c.issueRef === 'string' ? transform(c.issueRef) : c.issueRef,
        assigneeRef: typeof c.assigneeRef === 'string' ? transform(c.assigneeRef) : c.assigneeRef,
        stateRef: typeof c.stateRef === 'string' ? transform(c.stateRef) : c.stateRef
      }
    }
    case 'collect-ci-results': {
      const c = config as CollectCiResultsConfig
      return {
        ...c,
        worktreeRef: typeof c.worktreeRef === 'string' ? transform(c.worktreeRef) : c.worktreeRef
      }
    }
    case 'http-request':
      // Deferred (mirrors walkStepConfigStrings): id-rename rewriting of the
      // request step's template fields lands when step-request template
      // autocomplete does. Returned untouched for now.
      return config
  }
}

/**
 * Wraps the step at `index` into a parallel group with `newStep`, or appends
 * `newStep` to the group if the slot is already a parallel group.
 */
export function groupStepAt(steps: StepOrGroup[], index: number, newStep: Step): StepOrGroup[] {
  const next = steps.slice()
  const existing = next[index]
  next[index] = Array.isArray(existing) ? [...existing, newStep] : [existing, newStep]
  return next
}

/**
 * Removes the step at `innerIndex` from the parallel group at `groupIndex`.
 * Auto-unwraps the group to a solo step when only one sibling remains.
 * No-op when the target slot is not a group.
 */
export function ungroupStep(
  steps: StepOrGroup[],
  groupIndex: number,
  innerIndex: number
): StepOrGroup[] {
  const next = steps.slice()
  const group = next[groupIndex]
  if (!Array.isArray(group)) {
    return next
  }
  const remaining = group.filter((_, i) => i !== innerIndex)
  next[groupIndex] = remaining.length <= 1 ? remaining[0] : remaining
  return next
}

/**
 * Moves a step within a parallel group from `fromInner` to `toInner`.
 * No-op when the target slot is not a group.
 */
export function reorderWithinGroup(
  steps: StepOrGroup[],
  groupIndex: number,
  fromInner: number,
  toInner: number
): StepOrGroup[] {
  const next = steps.slice()
  const group = next[groupIndex]
  if (!Array.isArray(group)) {
    return next
  }
  const children = group.slice()
  const [moved] = children.splice(fromInner, 1)
  children.splice(toInner, 0, moved)
  next[groupIndex] = children
  return next
}

/**
 * Removes the top-level item at `fromIndex` and merges it into the
 * step/group at `targetIndex`. If the target is a solo step, wraps both
 * into a new parallel group. If already a group, appends the moved step(s).
 */
export function moveStepIntoGroup(
  steps: StepOrGroup[],
  fromIndex: number,
  targetIndex: number
): StepOrGroup[] {
  const next = steps.slice()
  const [moved] = next.splice(fromIndex, 1)
  const adjustedTarget = fromIndex < targetIndex ? targetIndex - 1 : targetIndex
  const movedSteps = Array.isArray(moved) ? moved : [moved]
  const existing = next[adjustedTarget]
  next[adjustedTarget] = Array.isArray(existing)
    ? [...existing, ...movedSteps]
    : [existing, ...movedSteps]
  return next
}

export function flattenSteps(steps: StepOrGroup[]): Step[] {
  const result: Step[] = []
  for (const item of steps) {
    if (Array.isArray(item)) {
      result.push(...item)
    } else {
      result.push(item)
    }
  }
  return result
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export type { Step, StepConfig, StepKind, StepOrGroup }
