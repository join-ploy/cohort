import type {
  Step,
  StepKind,
  StepConfig,
  TriggerConfig,
  CreateWorktreeConfig,
  WaitForSetupConfig,
  RunPromptConfig,
  RunCommandConfig
} from '../../../shared/automations-types'

/**
 * ChainDraft mirrors the persisted Automation shape but with only the fields
 * the editor cares about (name, projectId, trigger, steps, enabled). It is the
 * in-memory state of the chain editor modal.
 */
export type ChainDraft = {
  id: string
  name: string
  projectId: string
  trigger: TriggerConfig
  enabled: boolean
  steps: Step[]
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
export function generateDefaultStepId(kind: StepKind, steps: Step[]): string {
  const counterRegex = new RegExp(`^${escapeRegex(kind)}-(\\d+)$`)
  let max = 0
  for (const step of steps) {
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
export function renameStepWithRewrites(steps: Step[], oldId: string, newId: string): Step[] {
  if (!isValidStepId(newId)) {
    throw new Error(`Step id '${newId}' is invalid; must be kebab-case (lowercase + digits + '-').`)
  }
  if (oldId === newId) {
    return steps.slice()
  }
  for (const step of steps) {
    if (step.id !== oldId && step.id === newId) {
      throw new Error(`Step id '${newId}' is already in use.`)
    }
  }

  // Trailing `.` ensures we do not match an id that simply has <oldId> as a
  // prefix (e.g. renaming `cw1` does not touch `{{steps.cw10.x}}`).
  const refPattern = new RegExp(`\\{\\{steps\\.${escapeRegex(oldId)}\\.`, 'g')
  const replacement = `{{steps.${newId}.`

  return steps.map((step) => {
    const nextId = step.id === oldId ? newId : step.id
    const nextConfig = rewriteConfigStrings(step.config, step.kind, (value) =>
      value.replace(refPattern, replacement)
    )
    return { ...step, id: nextId, config: nextConfig }
  })
}

/**
 * Returns a new array with the step at `fromIndex` moved to `toIndex`. Pure
 * splice — does not mutate the input array.
 */
export function reorderSteps(steps: Step[], fromIndex: number, toIndex: number): Step[] {
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
export function detectFutureReferences(steps: Step[]): FutureReferenceViolation[] {
  const violations: FutureReferenceViolation[] = []
  const indexById = new Map<string, number>()
  steps.forEach((step, i) => indexById.set(step.id, i))

  const refRegexSource = /\{\{steps\.([a-z0-9][a-z0-9-]*)\.[^}]+\}\}/.source

  steps.forEach((step, i) => {
    walkStepConfigStrings(step.config, step.kind, (field, value) => {
      if (!value) {
        return
      }
      // Local regex per call so lastIndex stays isolated.
      const re = new RegExp(refRegexSource, 'g')
      let match: RegExpExecArray | null
      while ((match = re.exec(value)) !== null) {
        const toStepId = match[1]
        const toIdx = indexById.get(toStepId)
        if (toIdx !== undefined && toIdx > i) {
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
        prompt: typeof c.prompt === 'string' ? transform(c.prompt) : c.prompt
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
  }
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
