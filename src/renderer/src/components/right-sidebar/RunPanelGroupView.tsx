import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Play, Square } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import type { OrcaHooks, Worktree } from '../../../../shared/types'
import type { ScriptState, ScriptStatus } from '@/store/slices/scripts'
import SegmentedRepoTabs, { type RepoSegment, type RepoSegmentStatus } from './SegmentedRepoTabs'
import SidebarPtyTerminal from './SidebarPtyTerminal'

// Why: grouped-workspaces shell for the right-sidebar Run tab. Splits each
// member repo's run output across a segmented strip and renders a SINGLE
// atomic Start/Stop button — Run is group-coupled (one command for the whole
// composition) rather than per-member like Setup. Stays alongside RunPanel
// instead of nested inside it so the file-size lint cap stays comfortable.

// Why: map ScriptStatus → RepoSegmentStatus the same way Setup does so the
// segmented strip and any future aggregated badge read consistently.
export function runScriptStatusToSegmentStatus(status: ScriptStatus | null): RepoSegmentStatus {
  if (!status || status === 'idle') {
    return 'idle'
  }
  if (status === 'running') {
    return 'running'
  }
  return status === 'exited-success' ? 'done' : 'failed'
}

// Why: aggregation rule mirrors aggregateGroupSetupStatus in
// SetupPanelGroupView — any failed → failed, else any running → running,
// else done when every member succeeded, otherwise idle. Exported for
// possible future use in the activity-bar badge.
export function aggregateGroupRunStatus(statuses: RepoSegmentStatus[]): RepoSegmentStatus {
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

export type RunGroupMember = {
  worktreeId: string
  repoId: string
  repoName: string
  runScript: string | undefined
  runState: ScriptState | null
}

function memberStatusLabel(runState: ScriptState | null): string {
  if (!runState || runState.status === 'idle') {
    return 'never run'
  }
  if (runState.status === 'running') {
    return 'running…'
  }
  return `exited ${runState.exitCode ?? '?'}`
}

function groupAtomicLabel(aggregated: RepoSegmentStatus, isDispatching: boolean): string {
  if (isDispatching) {
    return 'starting…'
  }
  if (aggregated === 'running') {
    return 'running…'
  }
  if (aggregated === 'done') {
    return 'all exited 0'
  }
  if (aggregated === 'failed') {
    return 'some exited non-zero'
  }
  return 'never run'
}

function RunGroupTerminalArea({
  ptyId,
  runScript
}: {
  ptyId: string | null
  runScript: string | undefined
}): React.JSX.Element {
  // Why: empty state for a member with no run script — distinct from the
  // global "never run" header so the user understands this segment will be
  // skipped on Start. Cmd+R hint is omitted because the atomic Start button
  // covers the gesture in group mode.
  if (!runScript) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
        No run script configured for this repo.
      </div>
    )
  }
  if (!ptyId) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        Press Start to launch all members
      </div>
    )
  }
  return <SidebarPtyTerminal key={ptyId} ptyId={ptyId} />
}

export type RunPanelGroupViewProps = {
  members: RunGroupMember[]
  activeRepoId: string
  onSelectRepo: (repoId: string) => void
  onStartAll: () => void
  onStopAll: () => void
  /** Disable the Start button while the group-start fan-out is in flight. */
  isDispatching: boolean
}

export function RunPanelGroupView({
  members,
  activeRepoId,
  onSelectRepo,
  onStartAll,
  onStopAll,
  isDispatching
}: RunPanelGroupViewProps): React.JSX.Element {
  // Why: fall back to the first member if the externally-tracked
  // activeRepoId no longer matches any member (e.g. a member got removed).
  const activeMember = members.find((m) => m.repoId === activeRepoId) ?? members[0] ?? null

  const segments: RepoSegment[] = members.map((m) => ({
    repoId: m.repoId,
    repoName: m.repoName,
    status: runScriptStatusToSegmentStatus(m.runState?.status ?? null)
  }))
  const aggregated = aggregateGroupRunStatus(segments.map((s) => s.status))
  // Why: atomic semantics — show Stop while ANY member has a live PTY, else
  // show Start. A mixed state (some running, some exited) still surfaces Stop
  // so the user can halt the surviving members in one click.
  const anyRunning = aggregated === 'running'

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <SegmentedRepoTabs
        segments={segments}
        activeRepoId={activeMember?.repoId ?? ''}
        onSelect={onSelectRepo}
      />
      <div className="flex h-9 items-center justify-between gap-2 border-b border-border px-3">
        <span className="truncate text-xs text-muted-foreground">
          {groupAtomicLabel(aggregated, isDispatching)}
        </span>
        {anyRunning ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={onStopAll}
            aria-label="Stop all run scripts"
            className="gap-1"
          >
            <Square size={12} />
            Stop all
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="xs"
            onClick={onStartAll}
            disabled={isDispatching}
            aria-label="Start all run scripts"
            className="gap-1"
          >
            <Play size={12} />
            Start all
          </Button>
        )}
      </div>
      {activeMember ? (
        <>
          {/* Why: the per-member status row used to render even when the
              member was idle, which produced a duplicate "never run" line
              right below the group-atomic header. Only show this row when
              the active member's state carries info beyond what the
              group-atomic line already conveys (i.e. an exit code that the
              aggregated summary smooths over). */}
          {activeMember.runState && activeMember.runState.status !== 'idle' && (
            <div className="flex h-7 items-center border-b border-border px-3">
              <span className="truncate text-[11px] text-muted-foreground">
                {memberStatusLabel(activeMember.runState)}
              </span>
            </div>
          )}
          <RunGroupTerminalArea
            ptyId={activeMember.runState?.ptyId ?? null}
            runScript={activeMember.runScript}
          />
        </>
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
// a group so the hooks fire on entry without touching the single-worktree
// code path's render.
export type RunPanelGroupContainerProps = {
  groupId: string
  members: Worktree[]
  memberRunStates: (ScriptState | null)[]
  repoMap: Map<string, { id: string; displayName: string }>
  defaultActiveWorktreeId: string | null
}

export function RunPanelGroupContainer({
  groupId,
  members,
  memberRunStates,
  repoMap,
  defaultActiveWorktreeId
}: RunPanelGroupContainerProps): React.JSX.Element {
  // Why: land on the active worktree's repoId if it's in the group, else
  // first member. Mirrors the SetupPanelGroupContainer default.
  const initialRepoId =
    members.find((m) => m.id === defaultActiveWorktreeId)?.repoId ?? members[0]?.repoId ?? ''
  const [activeRepoId, setActiveRepoId] = useState<string>(initialRepoId)

  // Why: if membership changes and the selected repoId disappears, fall back
  // to the first remaining member.
  useEffect(() => {
    if (!members.some((m) => m.repoId === activeRepoId) && members[0]) {
      setActiveRepoId(members[0].repoId)
    }
  }, [members, activeRepoId])

  // Why: one hooks:check per member, fired in parallel. Result is a
  // repoId-keyed map of trimmed run scripts so the active segment can render
  // either the empty-state or the terminal pane.
  const [runScriptsByRepo, setRunScriptsByRepo] = useState<Record<string, string | undefined>>({})
  const repoIdsKey = useMemo(() => members.map((m) => m.repoId).join('|'), [members])
  useEffect(() => {
    let cancelled = false
    const next: Record<string, string | undefined> = {}
    Promise.all(
      members.map(async (member) => {
        try {
          const result = await window.api.hooks.check({ repoId: member.repoId })
          const hooks = (result.hooks as OrcaHooks | null) ?? null
          const trimmed = hooks?.scripts?.run?.trim()
          next[member.repoId] = trimmed && trimmed.length > 0 ? trimmed : undefined
        } catch {
          next[member.repoId] = undefined
        }
      })
    ).then(() => {
      if (!cancelled) {
        setRunScriptsByRepo(next)
      }
    })
    return () => {
      cancelled = true
    }
  }, [members, repoIdsKey])

  // Why: pull the slice actions via the store so tests can override the
  // implementation without monkey-patching window.api at the module level.
  const startGroupRun = useAppStore((s) => s.startGroupRun)
  const stopGroupRun = useAppStore((s) => s.stopGroupRun)

  // Why: track the in-flight Start fan-out locally — the store doesn't carry
  // a 'starting' status today (events flip 'idle' → 'running' on
  // run:started). The local flag disables the Start button until every
  // per-member start IPC resolves, matching the atomic-mode UX of
  // "one click, then either it's all up or you see toasts".
  const [isDispatching, setIsDispatching] = useState(false)

  const onStartAll = useCallback(() => {
    if (isDispatching) {
      return
    }
    setIsDispatching(true)
    void startGroupRun(groupId)
      .then((results) => {
        for (const result of results) {
          if (!result.ok) {
            toast.error(`Failed to start run script: ${result.reason}`)
          }
        }
      })
      .catch((err) => {
        toast.error(`Failed to start group run: ${err instanceof Error ? err.message : 'unknown'}`)
      })
      .finally(() => setIsDispatching(false))
  }, [groupId, isDispatching, startGroupRun])

  const onStopAll = useCallback(() => {
    void stopGroupRun(groupId)
      .then((results) => {
        for (const result of results) {
          if (!result.ok && result.reason !== 'not-running') {
            toast.error(`Failed to stop run script: ${result.reason}`)
          }
        }
      })
      .catch((err) => {
        toast.error(`Failed to stop group run: ${err instanceof Error ? err.message : 'unknown'}`)
      })
  }, [groupId, stopGroupRun])

  const groupMembers: RunGroupMember[] = members.map((wt, idx) => ({
    worktreeId: wt.id,
    repoId: wt.repoId,
    repoName: repoMap.get(wt.repoId)?.displayName ?? wt.repoId,
    runScript: runScriptsByRepo[wt.repoId],
    runState: memberRunStates[idx] ?? null
  }))

  return (
    <RunPanelGroupView
      members={groupMembers}
      activeRepoId={activeRepoId}
      onSelectRepo={setActiveRepoId}
      onStartAll={onStartAll}
      onStopAll={onStopAll}
      isDispatching={isDispatching}
    />
  )
}
