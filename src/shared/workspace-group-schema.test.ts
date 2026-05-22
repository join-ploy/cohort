// src/shared/workspace-group-schema.test.ts
import { describe, it, expect } from 'vitest'
import { parseWorkspaceGroups } from './workspace-group-schema'

describe('parseWorkspaceGroups', () => {
  it('returns [] for non-array input', () => {
    expect(parseWorkspaceGroups(null)).toEqual([])
    expect(parseWorkspaceGroups(undefined)).toEqual([])
    expect(parseWorkspaceGroups('nope')).toEqual([])
  })

  it('keeps valid entries and drops malformed ones', () => {
    const input = [
      {
        id: 'group:abc',
        workspaceName: 'daring_tiger',
        displayName: 'daring_tiger',
        parentPath: '/x/daring_tiger',
        memberWorktreeIds: ['orca::/a', 'pc::/b'],
        branchName: 'daring_tiger',
        isArchived: false,
        archivedAt: null,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        isUnread: false,
        comment: '',
        createdAt: 1000,
        linkedIssue: null,
        linkedLinearIssue: null
      },
      { id: 'group:bad', memberWorktreeIds: 'not-an-array' }
    ]
    const result = parseWorkspaceGroups(input)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('group:abc')
  })

  it('tolerates extra fields', () => {
    const input = [
      {
        id: 'group:abc',
        workspaceName: 'x',
        displayName: 'x',
        parentPath: '/x',
        memberWorktreeIds: [],
        branchName: 'x',
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
        futureField: 'ignored'
      }
    ]
    expect(parseWorkspaceGroups(input)).toHaveLength(1)
  })
})
