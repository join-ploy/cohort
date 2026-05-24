import { useAppStore } from '@/store'
import { partitionSelectionIds } from './worktree-multi-selection'
import { runWorktreeBatchArchive } from './archive-worktree-flow'
import { runGroupArchive } from './archive-group-flow'

/**
 * Batch-archive dispatcher for a mixed selection of worktree ids and group
 * selection ids. Worktree ids route to the existing per-worktree archive
 * flow (which is itself batch-aware); group ids route to the group archive
 * IPC. The two paths fire concurrently — a partial failure on one does not
 * block the other, matching the existing batch semantics.
 *
 * Why a separate flow file: the multi-selection model is repo-agnostic and
 * shouldn't import either archive flow directly, and the existing
 * `runWorktreeBatchArchive` would need to grow group awareness to do this
 * itself. Keeping the dispatch in its own file leaves both flows pure and
 * gives the sidebar context-menu / GroupCard one shared entry point.
 */
export function runBatchSelectionArchive(selectionIds: ReadonlySet<string>): void {
  if (selectionIds.size === 0) {
    return
  }

  const { groupIds, worktreeIds } = partitionSelectionIds(selectionIds)

  if (groupIds.size > 0) {
    // Why: fetch the latest displayName from the live workspaceGroups cache
    // so the toast matches what the sidebar card shows. The cache lookup is
    // best-effort — see the id-fallback in the runGroupArchive call below.
    const groups = useAppStore.getState().workspaceGroups
    const groupById = new Map(groups.map((g) => [g.id, g]))
    for (const groupId of groupIds) {
      const displayName = groupById.get(groupId)?.displayName ?? groupId
      runGroupArchive(groupId, displayName)
    }
  }

  if (worktreeIds.size > 0) {
    runWorktreeBatchArchive([...worktreeIds])
  }
}
