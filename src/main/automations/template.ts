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
    const result = lookup(context, trimmed)
    if (result.value === undefined || result.value === null) {
      // The path walked through every intermediate object but the final
      // leaf is absent — e.g. a skipped step whose output fields were
      // never populated.  Resolve to "" so downstream steps degrade
      // gracefully instead of crashing the run.
      if (result.reachedEnd) {
        return ''
      }
      throw new TemplateResolutionError(
        `Template references unresolved path '${trimmed}'.`,
        trimmed
      )
    }
    if (typeof result.value === 'object' || typeof result.value === 'function') {
      throw new TemplateResolutionError(
        `Template path '${trimmed}' resolved to ${Array.isArray(result.value) ? 'an array' : typeof result.value}; only string, number, and boolean values are allowed.`,
        trimmed
      )
    }
    return String(result.value)
  })
}

function lookup(
  ctx: Record<string, unknown>,
  path: string
): { value: unknown; reachedEnd: boolean } {
  const parts = path.split('.')
  let cursor: unknown = ctx
  for (const part of parts) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') {
      return { value: undefined, reachedEnd: false }
    }
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return { value: cursor, reachedEnd: true }
}
