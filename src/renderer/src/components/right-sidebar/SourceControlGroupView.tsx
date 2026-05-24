import React, { useEffect, useState } from 'react'
import type { Worktree } from '../../../../shared/types'
import SegmentedRepoTabs, { type RepoSegment, type RepoSegmentStatus } from './SegmentedRepoTabs'
import { SourceControlInner } from './SourceControl'
import { changedCountToSegmentStatus } from './FileExplorerGroupView'

// Why: grouped-workspaces shell for the right-sidebar Source Control tab.
// Splits the commit/branch surface across one segment per member repo so each
// member's uncommitted-changes view, commit drafts, and remote operations
// stay scoped to that worktree. Lives alongside SourceControl.tsx (which is
// already ~1800 lines) instead of nesting the segmented strip inside it.

export type SourceControlGroupViewProps = {
  members: Worktree[]
  memberChangedCounts: number[]
  repoMap: Map<string, { id: string; displayName: string }>
  activeRepoId: string
  onSelectRepo: (repoId: string) => void
}

export function SourceControlGroupView({
  members,
  memberChangedCounts,
  repoMap,
  activeRepoId,
  onSelectRepo
}: SourceControlGroupViewProps): React.JSX.Element {
  // Why: fall back to the first member if the externally-tracked activeRepoId
  // no longer matches any member (e.g. a member got removed). Without this
  // guard the inner SourceControlInner would render with a stale worktreeId.
  const activeMember = members.find((m) => m.repoId === activeRepoId) ?? members[0] ?? null

  const segments: RepoSegment[] = members.map((m, idx) => {
    const count = memberChangedCounts[idx] ?? 0
    // Why: minimal viable parity — source control has no native "running"
    // concept at the panel level, so we mirror the Explorer tab's mapping:
    // dirty members surface their changed-file count as a badge and stay
    // 'idle' (the dim dot), clean members get 'done' (green). This keeps the
    // Explorer and Source Control segmented strips consistent so the user
    // doesn't see different per-member badges between the two tabs.
    const status: RepoSegmentStatus = changedCountToSegmentStatus(count)
    return {
      repoId: m.repoId,
      repoName: repoMap.get(m.repoId)?.displayName ?? m.repoId,
      status,
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
        // SourceControlInner on segment switch — the inner component holds
        // per-worktree local state (scope, filterQuery, baseRef dialog,
        // bulk-execution flag) keyed off the active worktree, and a
        // segment switch should land on a clean panel rather than inherit
        // the previous segment's UI flags.
        <SourceControlInner key={activeMember.id} worktreeId={activeMember.id} />
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
export type SourceControlGroupContainerProps = {
  members: Worktree[]
  memberChangedCounts: number[]
  repoMap: Map<string, { id: string; displayName: string }>
  defaultActiveWorktreeId: string | null
}

export function SourceControlGroupContainer({
  members,
  memberChangedCounts,
  repoMap,
  defaultActiveWorktreeId
}: SourceControlGroupContainerProps): React.JSX.Element {
  // Why: pick the active worktree's repoId as the default segment so the
  // user lands on the panel they were last looking at, falling back to the
  // first member if the active worktree isn't in the group.
  const initialRepoId =
    members.find((m) => m.id === defaultActiveWorktreeId)?.repoId ?? members[0]?.repoId ?? ''
  const [activeRepoId, setActiveRepoId] = useState<string>(initialRepoId)

  // Why: if membership shifts (e.g. a member is removed) and the selected
  // repoId disappears, fall back to the first remaining member rather than
  // rendering an empty source-control pane.
  useEffect(() => {
    if (!members.some((m) => m.repoId === activeRepoId) && members[0]) {
      setActiveRepoId(members[0].repoId)
    }
  }, [members, activeRepoId])

  return (
    <SourceControlGroupView
      members={members}
      memberChangedCounts={memberChangedCounts}
      repoMap={repoMap}
      activeRepoId={activeRepoId}
      onSelectRepo={setActiveRepoId}
    />
  )
}
