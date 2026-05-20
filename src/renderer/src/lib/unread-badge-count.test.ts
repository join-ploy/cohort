import { describe, expect, it } from 'vitest'
import type { TerminalTab, Worktree } from '../../../shared/types'
import { getUnreadBadgeCount } from './unread-badge-count'

function worktree(id: string, isUnread: boolean, isArchived = false): Worktree {
  return { id, isUnread, isArchived } as Worktree
}

function tab(id: string): TerminalTab {
  return { id } as TerminalTab
}

describe('getUnreadBadgeCount', () => {
  it('counts unread worktrees', () => {
    expect(
      getUnreadBadgeCount({
        worktreesByRepo: { repo: [worktree('wt-1', true), worktree('wt-2', false)] },
        tabsByWorktree: {},
        unreadTerminalTabs: {}
      })
    ).toBe(1)
  })

  it('dedupes unread terminal tabs against their worktree', () => {
    expect(
      getUnreadBadgeCount({
        worktreesByRepo: { repo: [worktree('wt-1', true)] },
        tabsByWorktree: { 'wt-1': [tab('tab-1'), tab('tab-2')] },
        unreadTerminalTabs: { 'tab-1': true, 'tab-2': true }
      })
    ).toBe(1)
  })

  it('counts tab-only unread activity by owning worktree', () => {
    expect(
      getUnreadBadgeCount({
        worktreesByRepo: { repo: [worktree('wt-1', false), worktree('wt-2', false)] },
        tabsByWorktree: { 'wt-1': [tab('tab-1')], 'wt-2': [tab('tab-2')] },
        unreadTerminalTabs: { 'tab-1': true, 'tab-2': true }
      })
    ).toBe(2)
  })

  it('ignores unread worktrees and tabs from archived worktrees', () => {
    expect(
      getUnreadBadgeCount({
        worktreesByRepo: {
          repo: [worktree('wt-archived', true, true), worktree('wt-live', true)]
        },
        tabsByWorktree: { 'wt-archived': [tab('tab-archived')], 'wt-live': [tab('tab-live')] },
        unreadTerminalTabs: { 'tab-archived': true, 'tab-live': true }
      })
    ).toBe(1)
  })
})
