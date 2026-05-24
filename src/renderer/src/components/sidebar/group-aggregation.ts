import type { WorkspaceGroup, Worktree } from '../../../../shared/types'

/** max(member.lastActivityAt). Returns 0 when no members. */
export function groupLastActivityAt(members: Worktree[]): number {
  // Math.max() with no args returns -Infinity; explicit 0 keeps the empty
  // case sortable next to other epoch-0 records.
  if (members.length === 0) {
    return 0
  }
  let max = 0
  for (const m of members) {
    if (m.lastActivityAt > max) {
      max = m.lastActivityAt
    }
  }
  return max
}

/** True if any member's id appears in the runningWorktreeIds set. */
export function groupIsRunning(members: Worktree[], runningWorktreeIds: Set<string>): boolean {
  for (const m of members) {
    if (runningWorktreeIds.has(m.id)) {
      return true
    }
  }
  return false
}

/** Read directly off the group; members are noise (truth lives on the group). */
export function groupHasUnread(group: WorkspaceGroup): boolean {
  return group.isUnread
}
