import type { OutputSchema } from '../../../shared/automation-step-schemas'

export type AvailableVariables = {
  automation: OutputSchema
  trigger: OutputSchema
  steps: Record<string, OutputSchema>
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
    return walkLeaf(parts.slice(1), available.trigger, path)
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
