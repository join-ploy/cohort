import React, { useEffect, useState } from 'react'
import type { Worktree } from '../../../../shared/types'
import SegmentedRepoTabs, { type RepoSegment, type RepoSegmentStatus } from './SegmentedRepoTabs'
import { FileExplorerInner } from './FileExplorer'

// Why: grouped-workspaces shell for the right-sidebar Explorer / Diff tab.
// Splits the file tree across one segment per member repo so each member's
// changed-files view (git status colors, badges, open-file actions) is
// scoped to that worktree. Lives alongside FileExplorer instead of nested
// inside it so the file-size lint cap stays comfortable as the Explorer
// component already pushes 400 lines.

// Why: changed-file count → segment status. The diff view's natural states
// are "clean" (no changes, dim) vs "dirty" (has changes, ready for review).
// We reuse `done` (green) for "has changes" because the user landing on the
// Diff tab is looking for repos with something to commit; an actively-clean
// segment is just out of the way. Setup/Run remain unaffected because they
// derive segment status from script lifecycle, not file counts.
export function changedCountToSegmentStatus(count: number): RepoSegmentStatus {
  return count > 0 ? 'done' : 'idle'
}

// Why: aggregation rule for a future activity-bar badge — total number of
// changed files across all members. Exported so the right-sidebar parent tab
// can surface a single number (mirrors Phase G's aggregateGroupSetupStatus).
// Deferred plumbing into activity-bar; this is the pure helper.
export function aggregateGroupChangedCount(counts: number[]): number {
  let total = 0
  for (const c of counts) {
    total += c
  }
  return total
}

export type FileExplorerGroupViewProps = {
  members: Worktree[]
  memberChangedCounts: number[]
  repoMap: Map<string, { id: string; displayName: string }>
  activeRepoId: string
  onSelectRepo: (repoId: string) => void
}

export function FileExplorerGroupView({
  members,
  memberChangedCounts,
  repoMap,
  activeRepoId,
  onSelectRepo
}: FileExplorerGroupViewProps): React.JSX.Element {
  // Why: fall back to the first member if the externally-tracked activeRepoId
  // no longer matches any member (e.g. a member got removed). Without this
  // guard the inner FileExplorerInner would render with a stale worktreeId.
  const activeMember = members.find((m) => m.repoId === activeRepoId) ?? members[0] ?? null

  const segments: RepoSegment[] = members.map((m, idx) => {
    const count = memberChangedCounts[idx] ?? 0
    return {
      repoId: m.repoId,
      repoName: repoMap.get(m.repoId)?.displayName ?? m.repoId,
      status: changedCountToSegmentStatus(count),
      badge: count
    }
  })

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <SegmentedRepoTabs
        segments={segments}
        activeRepoId={activeMember?.repoId ?? ''}
        onSelect={onSelectRepo}
      />
      {activeMember ? (
        // Why: keyed by the member's worktreeId so React mounts a fresh
        // FileExplorerInner on segment switch — the inner component's tree
        // cache, expanded-dir set, and reveal effects are all keyed off the
        // active worktree and would otherwise leak across segments.
        <FileExplorerInner key={activeMember.id} worktreeId={activeMember.id} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          No members in this workspace group.
        </div>
      )}
    </div>
  )
}

// Why: container that owns the selected-segment state. Mounted only when the
// active worktree belongs to a group so it doesn't affect the single-worktree
// code path's render.
export type FileExplorerGroupContainerProps = {
  members: Worktree[]
  memberChangedCounts: number[]
  repoMap: Map<string, { id: string; displayName: string }>
  defaultActiveWorktreeId: string | null
}

export function FileExplorerGroupContainer({
  members,
  memberChangedCounts,
  repoMap,
  defaultActiveWorktreeId
}: FileExplorerGroupContainerProps): React.JSX.Element {
  // Why: pick the active worktree's repoId as the default segment so the
  // user lands on the panel they were last looking at, falling back to the
  // first member if the active worktree isn't in the group.
  const initialRepoId =
    members.find((m) => m.id === defaultActiveWorktreeId)?.repoId ?? members[0]?.repoId ?? ''
  const [activeRepoId, setActiveRepoId] = useState<string>(initialRepoId)

  // Why: if membership shifts (e.g. a member is removed) and the selected
  // repoId disappears, fall back to the first remaining member rather than
  // rendering an empty file pane.
  useEffect(() => {
    if (!members.some((m) => m.repoId === activeRepoId) && members[0]) {
      setActiveRepoId(members[0].repoId)
    }
  }, [members, activeRepoId])

  return (
    <FileExplorerGroupView
      members={members}
      memberChangedCounts={memberChangedCounts}
      repoMap={repoMap}
      activeRepoId={activeRepoId}
      onSelectRepo={setActiveRepoId}
    />
  )
}
