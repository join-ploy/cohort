import { describe, it, expect } from 'vitest'
import { validateGroupName, type NamespaceContext } from './workspace-group-namespace'

const ctx: NamespaceContext = {
  repoFolderNames: ['orca', 'ploy-client', 'ploy-server'],
  existingGroupNames: ['cozy_leopard']
}

describe('validateGroupName', () => {
  it('rejects collision with a repo name', () => {
    expect(validateGroupName('orca', ctx)).toEqual({ ok: false, reason: 'collides-with-repo' })
  })
  it('rejects collision with another group', () => {
    expect(validateGroupName('cozy_leopard', ctx)).toEqual({
      ok: false,
      reason: 'collides-with-group'
    })
  })
  it('rejects empty / invalid characters', () => {
    expect(validateGroupName('', ctx).ok).toBe(false)
    expect(validateGroupName('has space', ctx).ok).toBe(false)
  })
  it('accepts a clean name', () => {
    expect(validateGroupName('daring_tiger', ctx)).toEqual({ ok: true })
  })
})
