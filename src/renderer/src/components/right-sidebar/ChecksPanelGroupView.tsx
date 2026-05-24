import React, { useEffect, useState } from 'react'
import type { CheckStatus, Worktree } from '../../../../shared/types'
import SegmentedRepoTabs, { type RepoSegment, type RepoSegmentStatus } from './SegmentedRepoTabs'
import { ChecksPanelInner } from './ChecksPanel'

// Why: grouped-workspaces shell for the right-sidebar Checks tab. Splits
// PR-checks across one segment per member repo so each member's PR header,
// checks list, and review comments stay scoped to that worktree. Lives
// alongside ChecksPanel.tsx (which is already ~600 lines) instead of nesting
// the segmented strip inside it. Mirrors SourceControlGroupView so the three
// segmented panels evolve as a single pattern.

// Why: PR `checksStatus` → segment status mapping. The Checks tab's natural
// states map to the segmented strip's status vocabulary roughly 1:1:
//   - 'success'  → 'done'    (green dot; CI is green)
//   - 'failure'  → 'failed'  (rose dot; needs attention)
//   - 'pending'  → 'running' (spinner; CI is mid-run)
//   - 'neutral'  → 'idle'    (dim; informational only — neither pass nor fail)
//   - undefined  → 'idle'    (dim; no PR yet, or status not fetched)
// Exported so future activity-bar aggregation can reuse the same rule and
// the two surfaces cannot drift.
export function checksStatusToSegmentStatus(status: CheckStatus | undefined): RepoSegmentStatus {
  if (status === 'success') {
    return 'done'
  }
  if (status === 'failure') {
    return 'failed'
  }
  if (status === 'pending') {
    return 'running'
  }
  return 'idle'
}

export type ChecksPanelGroupViewProps = {
  members: Worktree[]
  memberChecksStatuses: (CheckStatus | undefined)[]
  repoMap: Map<string, { id: string; displayName: string }>
  activeRepoId: string
  onSelectRepo: (repoId: string) => void
}

export function ChecksPanelGroupView({
  members,
  memberChecksStatuses,
  repoMap,
  activeRepoId,
  onSelectRepo
}: ChecksPanelGroupViewProps): React.JSX.Element {
  // Why: fall back to the first member if the externally-tracked activeRepoId
  // no longer matches any member (e.g. a member got removed). Without this
  // guard the inner ChecksPanelInner would render with a stale worktreeId.
  const activeMember = members.find((m) => m.repoId === activeRepoId) ?? members[0] ?? null

  const segments: RepoSegment[] = members.map((m, idx) => {
    const status = checksStatusToSegmentStatus(memberChecksStatuses[idx])
    return {
      repoId: m.repoId,
      repoName: repoMap.get(m.repoId)?.displayName ?? m.repoId,
      status
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
        // ChecksPanelInner on segment switch — the inner component holds
        // per-worktree local state (checks/comments arrays, polling refs,
        // mid-edit title) and a segment switch should land on a clean
        // panel rather than inherit the previous segment's UI flags.
        <ChecksPanelInner key={activeMember.id} worktreeId={activeMember.id} />
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
export type ChecksPanelGroupContainerProps = {
  members: Worktree[]
  memberChecksStatuses: (CheckStatus | undefined)[]
  repoMap: Map<string, { id: string; displayName: string }>
  defaultActiveWorktreeId: string | null
}

export function ChecksPanelGroupContainer({
  members,
  memberChecksStatuses,
  repoMap,
  defaultActiveWorktreeId
}: ChecksPanelGroupContainerProps): React.JSX.Element {
  // Why: pick the active worktree's repoId as the default segment so the
  // user lands on the panel they were last looking at, falling back to the
  // first member if the active worktree isn't in the group.
  const initialRepoId =
    members.find((m) => m.id === defaultActiveWorktreeId)?.repoId ?? members[0]?.repoId ?? ''
  const [activeRepoId, setActiveRepoId] = useState<string>(initialRepoId)

  // Why: if membership shifts (e.g. a member is removed) and the selected
  // repoId disappears, fall back to the first remaining member rather than
  // rendering an empty checks pane.
  useEffect(() => {
    if (!members.some((m) => m.repoId === activeRepoId) && members[0]) {
      setActiveRepoId(members[0].repoId)
    }
  }, [members, activeRepoId])

  return (
    <ChecksPanelGroupView
      members={members}
      memberChecksStatuses={memberChecksStatuses}
      repoMap={repoMap}
      activeRepoId={activeRepoId}
      onSelectRepo={setActiveRepoId}
    />
  )
}
