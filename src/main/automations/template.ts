export class TemplateResolutionError extends Error {
  constructor(
    message: string,
    public readonly path: string
  ) {
    super(message)
    this.name = 'TemplateResolutionError'
  }
}

// Single pass matches either the escape sequence `\{{` or a token `{{path}}`.
// The alternation ordering matters: escape must be tried before the open token.
// `[^}\n]*` allows empty captures (so `{{}}` reaches the empty-path guard below)
// while rejecting newlines inside tokens — a newline almost always means a missing closer.
const TOKEN = /\\\{\{|\{\{([^}\n]*)\}\}/g

export function resolveTemplate(input: string, context: Record<string, unknown>): string {
  return input.replace(TOKEN, (match, path: string | undefined) => {
    if (match === '\\{{') {
      return '{{'
    }
    const trimmed = (path ?? '').trim()
    if (trimmed === '') {
      // `{{}}` and `{{   }}` are authoring mistakes — fail loudly instead of
      // producing a confusing "unresolved path ''" error or silent passthrough.
      throw new TemplateResolutionError(
        `Template contains an empty token '{{${path ?? ''}}}'. Provide a path like '{{trigger.x}}'.`,
        ''
      )
    }
    const value = lookup(context, trimmed)
    if (value === undefined || value === null) {
      throw new TemplateResolutionError(
        `Template references unresolved path '${trimmed}'.`,
        trimmed
      )
    }
    // Only primitive leaves are substitutable. Objects/arrays/dates/functions
    // would either corrupt the prompt (`[object Object]`) or produce
    // non-reproducible output (locale-dependent Date strings); flag them as
    // authoring mistakes for step runners to surface.
    if (typeof value === 'object' || typeof value === 'function') {
      throw new TemplateResolutionError(
        `Template path '${trimmed}' resolved to ${Array.isArray(value) ? 'an array' : typeof value}; only string, number, and boolean values are allowed.`,
        trimmed
      )
    }
    return String(value)
  })
}

function lookup(ctx: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let cursor: unknown = ctx
  for (const part of parts) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') {
      return undefined
    }
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}
