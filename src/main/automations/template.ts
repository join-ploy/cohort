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
const TOKEN = /\\\{\{|\{\{([^}]+)\}\}/g

export function resolveTemplate(input: string, context: Record<string, unknown>): string {
  return input.replace(TOKEN, (match, path: string | undefined) => {
    if (match === '\\{{') {
      return '{{'
    }
    const trimmed = (path ?? '').trim()
    const value = lookup(context, trimmed)
    if (value === undefined || value === null) {
      throw new TemplateResolutionError(
        `Template references unresolved path '${trimmed}'.`,
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
