import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { OrcaHooks, Worktree } from '../../../../shared/types'
import type { ScriptState, ScriptStatus } from '@/store/slices/scripts'
import SegmentedRepoTabs, { type RepoSegment, type RepoSegmentStatus } from './SegmentedRepoTabs'
import { SetupPanelView, callSetupStart, callSetupStop } from './SetupPanel'

// Why: grouped-workspaces shell for the right-sidebar Setup tab. Splits each
// member repo's setup output across a segmented strip so the user can pick
// which member's PTY they're looking at. Lives alongside SetupPanel (not
// inside it) so the file-size lint cap stays comfortable as Run/Diff phases
// reuse the same pattern.

// Why: surface ScriptStatus → RepoSegmentStatus mapping so the segmented
// strip + the aggregated parent-tab badge (in right-sidebar/index.tsx) can
// reuse the same conversion. 'idle' for missing/idle, 'running' while live,
// then settles to 'done' / 'failed' on exit.
export function scriptStatusToSegmentStatus(status: ScriptStatus | null): RepoSegmentStatus {
  if (!status || status === 'idle') {
    return 'idle'
  }
  if (status === 'running') {
    return 'running'
  }
  return status === 'exited-success' ? 'done' : 'failed'
}

// Why: aggregation rule per grouped-workspaces plan — any failed → red, else
// any running → spinner, else if every member has finished → green, else
// neutral/idle. Exported for the parent-tab badge in right-sidebar/index.tsx
// and reused by the group view's own header status text.
export function aggregateGroupSetupStatus(statuses: RepoSegmentStatus[]): RepoSegmentStatus {
  if (statuses.length === 0) {
    return 'idle'
  }
  if (statuses.some((s) => s === 'failed')) {
    return 'failed'
  }
  if (statuses.some((s) => s === 'running')) {
    return 'running'
  }
  if (statuses.every((s) => s === 'done')) {
    return 'done'
  }
  return 'idle'
}

export type SetupGroupMember = {
  worktreeId: string
  repoId: string
  repoName: string
  isPrimaryWorktree: boolean
  setupScript: string | undefined
  setupState: ScriptState | null
}

export type SetupPanelGroupViewProps = {
  members: SetupGroupMember[]
  activeRepoId: string
  onSelectRepo: (repoId: string) => void
  onReRun: (worktreeId: string) => void
  onStop: (worktreeId: string) => void
  onOpenOrcaYaml: () => void
}

export function SetupPanelGroupView({
  members,
  activeRepoId,
  onSelectRepo,
  onReRun,
  onStop,
  onOpenOrcaYaml
}: SetupPanelGroupViewProps): React.JSX.Element {
  // Why: fall back to the first member if the externally-tracked
  // activeRepoId no longer matches any member (e.g. a member got removed).
  // Without this guard the inner SetupPanelView would render with stale
  // props and the segmented strip would highlight nothing.
  const activeMember = members.find((m) => m.repoId === activeRepoId) ?? members[0] ?? null

  const segments: RepoSegment[] = members.map((m) => ({
    repoId: m.repoId,
    repoName: m.repoName,
    status: scriptStatusToSegmentStatus(m.setupState?.status ?? null)
  }))

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <SegmentedRepoTabs
        segments={segments}
        activeRepoId={activeMember?.repoId ?? ''}
        onSelect={onSelectRepo}
      />
      {activeMember ? (
        <SetupPanelView
          setupScript={activeMember.setupScript}
          setupState={activeMember.setupState}
          isPrimaryWorktree={activeMember.isPrimaryWorktree}
          onReRun={() => onReRun(activeMember.worktreeId)}
          onStop={() => onStop(activeMember.worktreeId)}
          onOpenOrcaYaml={onOpenOrcaYaml}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          No members in this workspace group.
        </div>
      )}
    </div>
  )
}

// Why: container that owns per-member hooks-check fetches and the
// selected-segment state. Mounted only when the active worktree belongs to
// a group so the hooks fire on entry without affecting the single-worktree
// code path's render.
export type SetupPanelGroupContainerProps = {
  members: Worktree[]
  memberSetupStates: (ScriptState | null)[]
  repoMap: Map<string, { id: string; displayName: string }>
  defaultActiveWorktreeId: string | null
}

export function SetupPanelGroupContainer({
  members,
  memberSetupStates,
  repoMap,
  defaultActiveWorktreeId
}: SetupPanelGroupContainerProps): React.JSX.Element {
  // Why: pick the active worktree's repoId as the default segment so the
  // user lands on the panel they were last looking at, falling back to the
  // first member if the active worktree isn't in the group.
  const initialRepoId =
    members.find((m) => m.id === defaultActiveWorktreeId)?.repoId ?? members[0]?.repoId ?? ''
  const [activeRepoId, setActiveRepoId] = useState<string>(initialRepoId)

  // Why: if membership shifts (e.g. a member is removed) and the selected
  // repoId disappears, fall back to the first remaining member rather than
  // rendering an empty terminal pane.
  useEffect(() => {
    if (!members.some((m) => m.repoId === activeRepoId) && members[0]) {
      setActiveRepoId(members[0].repoId)
    }
  }, [members, activeRepoId])

  // Why: one hooks:check per member, fired in parallel. The result is a
  // repoId-keyed map of trimmed setup scripts so the active member's body
  // renders the right empty-state vs. configured branch. Cancellation flag
  // covers the case where the group composition changes mid-fetch.
  const [setupScriptsByRepo, setSetupScriptsByRepo] = useState<Record<string, string | undefined>>(
    {}
  )
  const repoIdsKey = useMemo(() => members.map((m) => m.repoId).join('|'), [members])
  useEffect(() => {
    let cancelled = false
    const next: Record<string, string | undefined> = {}
    Promise.all(
      members.map(async (member) => {
        try {
          const result = await window.api.hooks.check({ repoId: member.repoId })
          const hooks = (result.hooks as OrcaHooks | null) ?? null
          const trimmed = hooks?.scripts?.setup?.trim()
          next[member.repoId] = trimmed && trimmed.length > 0 ? trimmed : undefined
        } catch {
          next[member.repoId] = undefined
        }
      })
    ).then(() => {
      if (!cancelled) {
        setSetupScriptsByRepo(next)
      }
    })
    return () => {
      cancelled = true
    }
  }, [members, repoIdsKey])

  const onReRunMember = useCallback((memberWorktreeId: string) => {
    void callSetupStart(
      { worktreeId: memberWorktreeId },
      { start: window.api.setupScript.start, toastError: toast.error }
    )
  }, [])
  const onStopMember = useCallback((memberWorktreeId: string) => {
    void callSetupStop(
      { worktreeId: memberWorktreeId },
      { stop: window.api.setupScript.stop, toastError: toast.error }
    )
  }, [])
  const onOpenOrcaYaml = useCallback(() => {}, [])

  const groupMembers: SetupGroupMember[] = members.map((wt, idx) => ({
    worktreeId: wt.id,
    repoId: wt.repoId,
    repoName: repoMap.get(wt.repoId)?.displayName ?? wt.repoId,
    isPrimaryWorktree: wt.isMainWorktree,
    setupScript: setupScriptsByRepo[wt.repoId],
    setupState: memberSetupStates[idx] ?? null
  }))

  return (
    <SetupPanelGroupView
      members={groupMembers}
      activeRepoId={activeRepoId}
      onSelectRepo={setActiveRepoId}
      onReRun={onReRunMember}
      onStop={onStopMember}
      onOpenOrcaYaml={onOpenOrcaYaml}
    />
  )
}
