import { describe, expect, it } from 'vitest'
import {
  buildMemberScopedRef,
  isMemberScopedRef,
  parseMemberScopedRef
} from './automation-member-scoped-ref'

describe('automation-member-scoped-ref', () => {
  const GROUP = 'group:abc-uuid-1234'
  const WORKTREE = 'repo-a::/workspaces/feat-x/repo-a'

  it('builds and parses a member-scoped ref losslessly', () => {
    const ref = buildMemberScopedRef(GROUP, WORKTREE)
    expect(ref).toBe('member:group:abc-uuid-1234:repo-a::/workspaces/feat-x/repo-a')
    expect(isMemberScopedRef(ref)).toBe(true)
    expect(parseMemberScopedRef(ref)).toEqual({ groupId: GROUP, worktreeId: WORKTREE })
  })

  it('handles worktree paths with multiple colons in them', () => {
    // Why: Windows-style drive prefixes (e.g. C:\) and remote refs can both
    // introduce extra colons. Only the FIRST colon after `group:<uuid>`
    // delimits the worktreeId — everything after is taken verbatim.
    const wt = 'repo-z::C:/workspaces/feat-x/repo-z'
    const ref = buildMemberScopedRef(GROUP, wt)
    expect(parseMemberScopedRef(ref)).toEqual({ groupId: GROUP, worktreeId: wt })
  })

  it('rejects refs missing the prefix', () => {
    expect(isMemberScopedRef('group:abc:repo-a::/x')).toBe(false)
    expect(parseMemberScopedRef('group:abc:repo-a::/x')).toBeNull()
  })

  it('rejects refs missing the groupId portion', () => {
    expect(parseMemberScopedRef('member:notgroup:abc:repo-a::/x')).toBeNull()
    // Why: empty group uuid is malformed — refuse rather than silently emit
    // `groupId === 'group:'`.
    expect(parseMemberScopedRef('member:group::repo-a::/x')).toBeNull()
    expect(parseMemberScopedRef('member:group:abc')).toBeNull() // no boundary after group:uuid
  })

  it('rejects refs missing the worktreeId portion', () => {
    expect(parseMemberScopedRef('member:group:abc-uuid-1234:')).toBeNull()
  })

  it('does not match a plain worktreeId or groupId', () => {
    expect(isMemberScopedRef('repo-a::/some/path')).toBe(false)
    expect(isMemberScopedRef('group:abc')).toBe(false)
  })
})
