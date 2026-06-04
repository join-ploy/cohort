import type {
  NestedSchema,
  OutputSchema,
  SchemaLeafType
} from '../../../shared/automation-step-schemas'
import type { StepKind } from '../../../shared/automations-types'

export type AvailableVariables = {
  automation: OutputSchema
  // Trigger paths can nest (e.g. `trigger.linear.issue.title`) so this is the
  // recursive shape; step outputs stay flat.
  trigger: NestedSchema
  steps: Record<string, OutputSchema>
  // Maps each in-scope step id to its kind. UI-only: the picker keys a step
  // output's description off its kind (a leaf like `outputTail` means something
  // different for run-prompt vs run-command). Optional so validation and
  // existing producers are unaffected.
  stepKinds?: Record<string, StepKind>
  // Why: the dispatcher publishes a top-level `group.*` shape after a
  // `create-workspace-group` step succeeds (see
  // src/main/workspace-group-runtime.ts → buildGroupTemplateContext). When
  // omitted, any `{{group.*}}` reference is invalid in scope. The shape nests
  // per-member, so we reuse NestedSchema rather than the flat OutputSchema.
  group?: NestedSchema
}

export type TemplateErrorCode = 'unknown-path' | 'unknown-step' | 'empty-token'

export type TemplateError = {
  path: string
  code: TemplateErrorCode
  message: string
}

// Mirrors the runtime regex in src/main/automations/template.ts: try the
// escape sequence first, then the open token. `[^}\n]*` allows the empty
// capture so `{{}}` reaches the empty-token guard below.
const TOKEN_RE = /\\\{\{|\{\{([^}\n]*)\}\}/g

export function dryRunTemplate(input: string, available: AvailableVariables): TemplateError[] {
  const errors: TemplateError[] = []
  const re = new RegExp(TOKEN_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(input)) !== null) {
    if (match[0] === '\\{{') {
      continue
    }
    const raw = match[1] ?? ''
    const trimmed = raw.trim()
    if (trimmed === '') {
      errors.push({
        path: '',
        code: 'empty-token',
        message: 'Empty template token.'
      })
      continue
    }
    const err = validatePath(trimmed, available)
    if (err) {
      errors.push(err)
    }
  }
  return errors
}

function validatePath(path: string, available: AvailableVariables): TemplateError | null {
  const parts = path.split('.')
  const head = parts[0]
  if (head === 'automation') {
    return walkLeaf(parts.slice(1), available.automation, path)
  }
  if (head === 'trigger') {
    return walkNested(parts.slice(1), available.trigger, path)
  }
  if (head === 'steps') {
    if (parts.length < 2) {
      return { path, code: 'unknown-path', message: `${path} is incomplete.` }
    }
    const stepId = parts[1]
    const stepSchema = available.steps[stepId]
    if (!stepSchema) {
      return { path, code: 'unknown-step', message: `Step '${stepId}' is not in scope.` }
    }
    return walkLeaf(parts.slice(2), stepSchema, path)
  }
  if (head === 'group') {
    // Why: with no earlier `create-workspace-group` step in scope, the
    // dispatcher never publishes the namespace — treat the whole path as
    // unknown so authors see the same error shape as any other off-scope ref.
    if (available.group === undefined) {
      return {
        path,
        code: 'unknown-path',
        message: `${path} is not in scope (no create-workspace-group step earlier).`
      }
    }
    return walkNested(parts.slice(1), available.group, path)
  }
  return {
    path,
    code: 'unknown-path',
    message: `Unknown top-level path '${head}'.`
  }
}

function walkLeaf(
  parts: string[],
  schema: OutputSchema,
  originalPath: string
): TemplateError | null {
  if (parts.length !== 1) {
    return {
      path: originalPath,
      code: 'unknown-path',
      message: `${originalPath} is not a leaf path.`
    }
  }
  const key = parts[0]
  if (!(key in schema)) {
    return {
      path: originalPath,
      code: 'unknown-path',
      message: `${originalPath} is not a known field.`
    }
  }
  return null
}

// Recursive variant of walkLeaf used only by the trigger namespace, which
// supports nested shapes like `trigger.linear.issue.title`.
function walkNested(
  parts: string[],
  schema: NestedSchema | SchemaLeafType,
  originalPath: string
): TemplateError | null {
  if (typeof schema === 'string') {
    // Hit a leaf — any remaining segments mean the template traverses past it.
    if (parts.length !== 0) {
      return {
        path: originalPath,
        code: 'unknown-path',
        message: `${originalPath} traverses past a leaf.`
      }
    }
    return null
  }
  if (parts.length === 0) {
    return {
      path: originalPath,
      code: 'unknown-path',
      message: `${originalPath} is not a leaf path.`
    }
  }
  const key = parts[0]
  const next = schema[key]
  if (next === undefined) {
    return {
      path: originalPath,
      code: 'unknown-path',
      message: `${originalPath} is not a known field.`
    }
  }
  return walkNested(parts.slice(1), next, originalPath)
}
