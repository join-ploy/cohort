import { describe, expect, it } from 'vitest'
import { searchGroups } from './group-palette-search'
import type { WorkspaceGroup } from '../../../shared/types'

function makeGroup(overrides: Partial<WorkspaceGroup> = {}): WorkspaceGroup {
  return {
    id: 'group:a',
    workspaceName: 'daring_tiger',
    displayName: 'daring_tiger',
    parentPath: '/tmp/daring_tiger',
    memberWorktreeIds: ['repoA::/wt'],
    branchName: 'daring_tiger',
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

describe('group-palette-search', () => {
  it('returns every group with null match metadata for an empty query', () => {
    const results = searchGroups([makeGroup()], '')

    expect(results).toEqual([
      {
        groupId: 'group:a',
        displayNameRange: null,
        branchRange: null
      }
    ])
  })

  it('matches a group by displayName substring', () => {
    const results = searchGroups([makeGroup({ displayName: 'daring_tiger' })], 'tiger')

    expect(results).toHaveLength(1)
    expect(results[0].displayNameRange).toEqual({ start: 7, end: 12 })
  })

  it('matches a group by branchName substring', () => {
    const results = searchGroups(
      [makeGroup({ displayName: 'unrelated', branchName: 'feature/auth' })],
      'auth'
    )

    expect(results).toHaveLength(1)
    expect(results[0].branchRange).toEqual({ start: 8, end: 12 })
  })

  it('drops groups that match neither displayName nor branchName', () => {
    const results = searchGroups(
      [makeGroup({ displayName: 'daring_tiger', branchName: 'daring_tiger' })],
      'nomatch'
    )

    expect(results).toEqual([])
  })

  it('skips archived groups', () => {
    const results = searchGroups(
      [
        makeGroup({ id: 'group:a', displayName: 'archived_a', isArchived: true }),
        makeGroup({ id: 'group:b', displayName: 'live_b' })
      ],
      ''
    )

    expect(results.map((r) => r.groupId)).toEqual(['group:b'])
  })
})
