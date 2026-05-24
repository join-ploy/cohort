import { describe, expect, it } from 'vitest'
import type { WorkspaceGroup, Worktree } from '../../../../shared/types'
import { groupHasUnread, groupIsRunning, groupLastActivityAt } from './group-aggregation'

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    displayName: 'wt-1',
    workspaceName: 'wise_panther',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    archivedAt: null,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    path: '/tmp/wt-1',
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    ...overrides
  }
}

function makeGroup(overrides: Partial<WorkspaceGroup> = {}): WorkspaceGroup {
  return {
    id: 'group:1',
    workspaceName: 'wise_panther',
    displayName: 'wise_panther',
    parentPath: '/tmp/workspaces/wise_panther',
    memberWorktreeIds: [],
    branchName: 'feature',
    isArchived: false,
    archivedAt: null,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    isUnread: false,
    comment: '',
    createdAt: 0,
    linkedIssue: null,
    linkedLinearIssue: null,
    ...overrides
  }
}

describe('groupLastActivityAt', () => {
  it('returns 0 for an empty member list', () => {
    expect(groupLastActivityAt([])).toBe(0)
  })

  it('returns the max lastActivityAt across members', () => {
    const members = [
      makeWorktree({ id: 'a', lastActivityAt: 100 }),
      makeWorktree({ id: 'b', lastActivityAt: 500 }),
      makeWorktree({ id: 'c', lastActivityAt: 300 })
    ]
    expect(groupLastActivityAt(members)).toBe(500)
  })

  it('returns the single member value when only one member exists', () => {
    expect(groupLastActivityAt([makeWorktree({ lastActivityAt: 42 })])).toBe(42)
  })
})

describe('groupIsRunning', () => {
  it('returns false for an empty member list', () => {
    expect(groupIsRunning([], new Set(['a']))).toBe(false)
  })

  it('returns true when any member id is in the running set', () => {
    const members = [
      makeWorktree({ id: 'a' }),
      makeWorktree({ id: 'b' }),
      makeWorktree({ id: 'c' })
    ]
    expect(groupIsRunning(members, new Set(['b']))).toBe(true)
  })

  it('returns false when no member id is in the running set', () => {
    const members = [makeWorktree({ id: 'a' }), makeWorktree({ id: 'b' })]
    expect(groupIsRunning(members, new Set(['x', 'y']))).toBe(false)
  })

  it('returns false when the running set is empty', () => {
    const members = [makeWorktree({ id: 'a' })]
    expect(groupIsRunning(members, new Set())).toBe(false)
  })
})

describe('groupHasUnread', () => {
  it('returns the group.isUnread value directly when true', () => {
    expect(groupHasUnread(makeGroup({ isUnread: true }))).toBe(true)
  })

  it('returns the group.isUnread value directly when false', () => {
    expect(groupHasUnread(makeGroup({ isUnread: false }))).toBe(false)
  })
})
