export type NamespaceContext = {
  repoFolderNames: string[]
  existingGroupNames: string[]
}

export type ValidateResult =
  | { ok: true }
  | { ok: false; reason: 'empty' | 'invalid-chars' | 'collides-with-repo' | 'collides-with-group' }

const VALID_NAME = /^[a-z0-9_][a-z0-9_-]*$/i

export function validateGroupName(name: string, ctx: NamespaceContext): ValidateResult {
  if (!name) {
    return { ok: false, reason: 'empty' }
  }
  if (!VALID_NAME.test(name)) {
    return { ok: false, reason: 'invalid-chars' }
  }
  if (ctx.repoFolderNames.includes(name)) {
    return { ok: false, reason: 'collides-with-repo' }
  }
  if (ctx.existingGroupNames.includes(name)) {
    return { ok: false, reason: 'collides-with-group' }
  }
  return { ok: true }
}
