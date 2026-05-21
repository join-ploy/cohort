import { describe, expect, it } from 'vitest'
import { mergeWorktree } from './worktree-logic'

describe('mergeWorktree automation attribution', () => {
  it('forwards createdByAutomationRunId from meta to the runtime worktree', () => {
    const result = mergeWorktree(
      'repo1',
      {
        path: '/workspaces/feature',
        head: 'abc123',
        branch: 'refs/heads/feature-x',
        isBare: false,
        isMainWorktree: false
      },
      {
        displayName: '',
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
        createdByAutomationRunId: 'run-abc-123'
      }
    )

    expect(result.createdByAutomationRunId).toBe('run-abc-123')
  })

  it('leaves createdByAutomationRunId undefined when meta does not set it', () => {
    const result = mergeWorktree(
      'repo1',
      {
        path: '/workspaces/manual',
        head: 'def456',
        branch: 'refs/heads/manual',
        isBare: false,
        isMainWorktree: false
      },
      {
        displayName: '',
        comment: '',
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        isArchived: false,
        archivedAt: null,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0
      }
    )

    expect(result.createdByAutomationRunId).toBeUndefined()
  })
})
