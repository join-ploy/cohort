import type { TerminalTab, Worktree } from '../../../shared/types'

export function getUnreadBadgeCount({
  worktreesByRepo,
  tabsByWorktree,
  unreadTerminalTabs
}: {
  worktreesByRepo: Record<string, Worktree[]>
  tabsByWorktree: Record<string, TerminalTab[]>
  unreadTerminalTabs: Record<string, true>
}): number {
  const unreadWorktreeIds = new Set<string>()
  // Why: archived worktrees are hidden from every selectable surface, so their
  // unread state must not contribute to the Dock badge — the user has no way
  // to navigate to them and clear the count.
  const archivedWorktreeIds = new Set<string>()

  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      if (worktree.isArchived) {
        archivedWorktreeIds.add(worktree.id)
        continue
      }
      if (worktree.isUnread) {
        unreadWorktreeIds.add(worktree.id)
      }
    }
  }

  const unreadTabIds = new Set(Object.keys(unreadTerminalTabs))
  if (unreadTabIds.size === 0) {
    return unreadWorktreeIds.size
  }

  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    const archived = archivedWorktreeIds.has(worktreeId)
    for (const tab of tabs) {
      if (!unreadTabIds.delete(tab.id)) {
        continue
      }
      // Why: archived worktrees' tabs are deleted from unreadTabIds so they
      // don't survive into the trailing "unmatched entries" tally, but their
      // worktreeId is not added to unreadWorktreeIds — the archived view is
      // not selectable so the dock badge must ignore it.
      if (archived) {
        continue
      }
      unreadWorktreeIds.add(worktreeId)
    }
  }

  // Why: tab unread state should normally map to a live worktree, but counting
  // unmatched entries keeps the Dock badge honest during hydration races.
  return unreadWorktreeIds.size + unreadTabIds.size
}
