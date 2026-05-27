import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { runSleepWorktrees } from './sleep-worktree-flow'

/**
 * Group archive entrypoint shared by the GroupCard context menu. Mirrors
 * `runWorktreeArchive` in archive-worktree-flow.ts but speaks to the
 * group-level IPC which fans cleanup out across every member in parallel.
 *
 * No undo affordance in v1: the design doc explicitly defers a "Restore
 * archived group" flow (see docs/plans/2026-05-22-grouped-workspaces-design.md
 * § "Out of scope for v1"). Failure surfaces a destructive toast — the
 * main-process handler has already stamped `archiveCleanupError` on the
 * group so the user can hover the "Cleanup blocked" badge in the visible
 * card to see which member(s) refused.
 */
export function runGroupArchive(groupId: string, displayName: string): void {
  // Why: group archive awaits cleanup scripts in parallel across every member
  // (see main/ipc/workspace-groups.ts), which can take real seconds — unlike
  // worktree archive, which is a metadata flip with deferred cleanup. A
  // promise toast gives the user immediate feedback that the action is in
  // flight and auto-transitions to success/error on completion.
  async function archiveWithTerminalShutdown() {
    // Why: mirror the single-worktree archive path — sleep member worktrees
    // before the IPC so terminals and browsers are cleanly torn down from the
    // renderer side. Without this the PTYs keep running until the main-process
    // runWorktreeRemoval defensively kills them, leaving visible zombie
    // terminals in the UI during the archive window.
    const group = useAppStore.getState().workspaceGroups.find((g) => g.id === groupId)
    if (group) {
      await runSleepWorktrees(group.memberWorktreeIds)
    }
    return useAppStore.getState().archiveGroup(groupId)
  }

  toast.promise(archiveWithTerminalShutdown(), {
    loading: `Archiving group "${displayName}"…`,
    success: `Archived group "${displayName}"`,
    error: (err: unknown) =>
      `Failed to archive group "${displayName}": ${err instanceof Error ? err.message : String(err)}`
  })
}
