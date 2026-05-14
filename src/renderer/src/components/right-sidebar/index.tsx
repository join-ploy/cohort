import React, { useEffect, useMemo, useState } from 'react'
import { PanelRight } from 'lucide-react'
import { useAppStore } from '@/store'
import { getRepoMapFromState, useActiveWorktree, useRepoById } from '@/store/selectors'
import { cn } from '@/lib/utils'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import type { CheckStatus } from '../../../../shared/types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import FileExplorer from './FileExplorer'
import SourceControl from './SourceControl'
import SearchPanel from './Search'
import ChecksPanel from './ChecksPanel'
import PortsPanel from './PortsPanel'
import RunPanel from './RunPanel'
import SetupPanel from './SetupPanel'
import {
  ACTIVITY_ITEMS,
  ActivityBarButton,
  ActivityBarPositionMenu,
  scriptStatusToCheckStatus,
  setupStatusToCheckStatus
} from './activity-bar'
import type { ScriptStatus } from '@/store/slices/scripts'

const MIN_WIDTH = 220
// Why: long file names (e.g. construction drawing sheets, multi-part document
// names) used to be truncated at a hard 500px cap that no drag could exceed.
// We now let the user drag up to nearly the full window width and only keep a
// small reserve so the rest of the app (left sidebar, editor) is not squeezed
// to zero — the practical ceiling still scales with the user's window size.
const MIN_NON_SIDEBAR_AREA = 320
const ABSOLUTE_FALLBACK_MAX_WIDTH = 2000

const ACTIVITY_BAR_SIDE_WIDTH = 40

const isMac = navigator.userAgent.includes('Mac')

function branchDisplayName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

function getActiveChecksStatus(state: ReturnType<typeof useAppStore.getState>): CheckStatus | null {
  const activeWorktree = state.activeWorktreeId
    ? findWorktreeById(state.worktreesByRepo, state.activeWorktreeId)
    : null
  if (!activeWorktree) {
    return null
  }

  const activeRepo = getRepoMapFromState(state).get(activeWorktree.repoId)
  if (!activeRepo) {
    return null
  }

  const branch = branchDisplayName(activeWorktree.branch)
  if (!branch) {
    return null
  }

  const prCacheKey = `${activeRepo.path}::${branch}`
  return state.prCache[prCacheKey]?.data?.checksStatus ?? null
}

function getActiveScriptStatus(
  state: ReturnType<typeof useAppStore.getState>,
  kind: 'run' | 'setup'
): ScriptStatus {
  const id = state.activeWorktreeId
  if (!id) {
    return 'idle'
  }
  return state.scriptsByWorktree[id]?.[kind].status ?? 'idle'
}

function RightSidebarInner(): React.JSX.Element {
  const activeWorktree = useActiveWorktree()
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarWidth = useAppStore((s) => s.rightSidebarWidth)
  const setRightSidebarWidth = useAppStore((s) => s.setRightSidebarWidth)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar)
  const checksStatus = useAppStore(getActiveChecksStatus)
  // Why: Run/Setup dots mirror the per-worktree script slice. The selectors
  // return 'idle' (not null) when no entry exists so the button renders no dot.
  const runScriptStatus = useAppStore((s) => getActiveScriptStatus(s, 'run'))
  const setupScriptStatus = useAppStore((s) => getActiveScriptStatus(s, 'setup'))
  const activityBarPosition = useAppStore((s) => s.activityBarPosition)
  const setActivityBarPosition = useAppStore((s) => s.setActivityBarPosition)
  // Why: source control and checks are meaningless for non-git folders.
  // Hide those tabs so the activity bar only shows relevant actions.
  const activeRepo = useRepoById(activeWorktree?.repoId ?? null)
  const isFolder = activeRepo ? isFolderRepo(activeRepo) : false

  // Why: show the Ports tab only when the active worktree belongs to a
  // remote (SSH) repo, not for any global SSH connection. Switching to a
  // local worktree should hide the tab even if SSH sessions are alive.
  const isRemoteWorktree = !!activeRepo?.connectionId
  const hasActiveSshConnection = useAppStore((s) => {
    if (!activeRepo?.connectionId) {
      return false
    }
    const state = s.sshConnectionStates.get(activeRepo.connectionId)
    return state?.status === 'connected'
  })

  // Why: when the SSH connection drops while the user is viewing the Ports
  // panel, hiding the tab immediately would be jarring. Keep it visible
  // during a 30-second grace period, then hide it.
  const isPortsPanelActive = rightSidebarTab === 'ports'
  // Why: graceActiveRef is set synchronously during render (not via useEffect)
  // so that the very first render after disconnect already sees the grace flag,
  // preventing a one-frame flicker to the Explorer tab.
  const graceActiveRef = React.useRef(false)
  const graceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const [, forceUpdate] = useState(0)

  if (!hasActiveSshConnection && isPortsPanelActive && !graceActiveRef.current) {
    graceActiveRef.current = true
  } else if (graceActiveRef.current && (hasActiveSshConnection || !isPortsPanelActive)) {
    // Why: clear grace when either (a) the SSH session reconnects, or (b) the
    // user navigates away from the Ports tab — no reason to keep it visible
    // once they've moved on.
    graceActiveRef.current = false
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current)
      graceTimerRef.current = null
    }
  }

  const disconnectGraceActive = graceActiveRef.current

  useEffect(() => {
    if (disconnectGraceActive) {
      graceTimerRef.current = setTimeout(() => {
        graceActiveRef.current = false
        graceTimerRef.current = null
        // Why: only reset the tab if the user is still on Ports. If they
        // already navigated to Search/Checks/etc during the grace period,
        // forcing them back to Explorer would be disruptive.
        if (useAppStore.getState().rightSidebarTab === 'ports') {
          setRightSidebarTab('explorer')
        }
        forceUpdate((n) => n + 1)
      }, 30_000)
      return () => {
        if (graceTimerRef.current) {
          clearTimeout(graceTimerRef.current)
          graceTimerRef.current = null
        }
      }
    }
    return undefined
  }, [disconnectGraceActive, setRightSidebarTab])

  const visibleItems = useMemo(
    () =>
      ACTIVITY_ITEMS.filter((item) => {
        if (item.gitOnly && isFolder) {
          return false
        }
        if (item.sshOnly) {
          if (!isRemoteWorktree) {
            return false
          }
          if (!hasActiveSshConnection && !disconnectGraceActive) {
            return false
          }
        }
        return true
      }),
    [isFolder, isRemoteWorktree, hasActiveSshConnection, disconnectGraceActive]
  )

  // If the active tab is hidden (e.g. switched from a git repo to a folder),
  // fall back to the first visible tab.
  const effectiveTab = visibleItems.some((item) => item.id === rightSidebarTab)
    ? rightSidebarTab
    : visibleItems[0].id

  const activityBarSideWidth = activityBarPosition === 'side' ? ACTIVITY_BAR_SIDE_WIDTH : 0
  const maxWidth = useWindowAwareMaxWidth()
  const { containerRef, onResizeStart } = useSidebarResize<HTMLDivElement>({
    isOpen: rightSidebarOpen,
    width: rightSidebarWidth,
    minWidth: MIN_WIDTH,
    maxWidth,
    deltaSign: -1,
    renderedExtraWidth: activityBarSideWidth,
    setWidth: setRightSidebarWidth
  })

  const panelContent = (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden scrollbar-sleek-parent">
      {/* Why: sidebar panels no longer use key={activeWorktreeId} because
          the full unmount/remount cycle on every worktree switch triggered
          an IPC storm (watchWorktree + readDir + git:branchCompare + …)
          that froze the app for seconds on Windows.  Each panel now reacts
          to activeWorktreeId changes via store subscriptions and reset
          effects, keeping the component instance alive across switches. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {effectiveTab === 'explorer' && <FileExplorer />}
        {effectiveTab === 'search' && <SearchPanel />}
        {effectiveTab === 'source-control' && <SourceControl />}
        {effectiveTab === 'checks' && <ChecksPanel />}
        {effectiveTab === 'ports' && <PortsPanel />}
        {effectiveTab === 'run' && <RunPanel />}
        {effectiveTab === 'setup' && <SetupPanel />}
      </div>
    </div>
  )

  const activityBarIcons = visibleItems.map((item) => {
    const scriptStatus =
      item.id === 'run' ? runScriptStatus : item.id === 'setup' ? setupScriptStatus : null
    let indicator: CheckStatus | null = null
    if (item.id === 'checks') {
      indicator = checksStatus
    } else if (item.id === 'run' && scriptStatus) {
      indicator = scriptStatusToCheckStatus(scriptStatus)
    } else if (item.id === 'setup' && scriptStatus) {
      // Why: setup uses a vanish-on-exit mapping (run keeps the emerald/rose).
      indicator = setupStatusToCheckStatus(scriptStatus)
    }
    return (
      <ActivityBarButton
        key={item.id}
        item={item}
        active={effectiveTab === item.id}
        onClick={() => setRightSidebarTab(item.id)}
        layout={activityBarPosition}
        statusIndicator={indicator}
        statusIndicatorPulse={scriptStatus === 'running'}
      />
    )
  })

  const closeButton = rightSidebarOpen ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="sidebar-toggle mr-1"
          onClick={toggleRightSidebar}
          aria-label="Toggle right sidebar"
        >
          <PanelRight size={16} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {`Toggle right sidebar (${isMac ? '⌘L' : 'Ctrl+L'})`}
      </TooltipContent>
    </Tooltip>
  ) : null

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative flex-shrink-0 flex flex-row',
        // Why: overflow-visible is needed when open so the resize handle
        // on the left edge remains interactive.  When closed (width 0),
        // switch to overflow-hidden so the activity bar icons and panel
        // content don't leak past the 0-width boundary (the component
        // stays mounted for performance — see App.tsx).
        rightSidebarOpen ? 'overflow-visible' : 'overflow-hidden'
      )}
    >
      {/* Panel content area */}
      <div
        className="flex flex-col flex-1 min-w-0 bg-sidebar overflow-hidden"
        style={{
          borderLeft: rightSidebarOpen ? '1px solid var(--sidebar-border)' : 'none'
        }}
      >
        {activityBarPosition === 'top' ? (
          /* ── Top activity bar: horizontal icon row ── */
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="flex items-center justify-between border-b border-border h-[36px] min-h-[36px] pl-2 pr-1 right-sidebar-header-inset">
                <TooltipProvider delayDuration={400}>
                  <div className="flex items-center">{activityBarIcons}</div>
                  <div className="flex items-center">{closeButton}</div>
                </TooltipProvider>
              </div>
            </ContextMenuTrigger>
            <ActivityBarPositionMenu
              currentPosition={activityBarPosition}
              onChangePosition={setActivityBarPosition}
            />
          </ContextMenu>
        ) : (
          /* ── Side layout: static title header ── */
          /* Why: the 40px side activity bar absorbs the rightmost 40px of the
             138px window-controls overlay, but the remaining 98px still overlaps
             the panel header. right-sidebar-header-side-inset applies exactly
             that remainder (138-40=98px) as padding-right so the close button
             clears the minimize button without the full 138px gap. */
          <div className="flex items-center justify-between h-[36px] min-h-[36px] px-3 border-b border-border right-sidebar-header-side-inset">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
              {visibleItems.find((item) => item.id === effectiveTab)?.title ?? ''}
            </span>
            <TooltipProvider delayDuration={400}>
              <div className="flex items-center">{closeButton}</div>
            </TooltipProvider>
          </div>
        )}

        {panelContent}

        {/* Resize handle on LEFT side */}
        <div
          className="absolute top-0 left-0 w-1 h-full cursor-col-resize hover:bg-ring/20 active:bg-ring/30 transition-colors z-10"
          onMouseDown={onResizeStart}
        />
      </div>

      {/* Side Activity Bar (icon strip on right edge) — only for 'side' position */}
      {activityBarPosition === 'side' && (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="flex flex-col items-center w-10 min-w-[40px] bg-sidebar border-l border-border side-activity-bar-windows-inset">
              <TooltipProvider delayDuration={400}>{activityBarIcons}</TooltipProvider>
            </div>
          </ContextMenuTrigger>
          <ActivityBarPositionMenu
            currentPosition={activityBarPosition}
            onChangePosition={setActivityBarPosition}
          />
        </ContextMenu>
      )}
    </div>
  )
}

const RightSidebar = React.memo(RightSidebarInner)
export default RightSidebar

// Why: the drag-resize max is a function of window width, not a constant, so
// users with wide displays can expand the sidebar far enough to read long file
// names. Falls back to a large constant in non-DOM environments (tests).
function useWindowAwareMaxWidth(): number {
  const [max, setMax] = useState(() => computeMaxRightSidebarWidth())

  useEffect(() => {
    function update(): void {
      setMax(computeMaxRightSidebarWidth())
    }
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  return max
}

function computeMaxRightSidebarWidth(): number {
  if (typeof window === 'undefined' || !Number.isFinite(window.innerWidth)) {
    return ABSOLUTE_FALLBACK_MAX_WIDTH
  }
  return Math.max(MIN_WIDTH, window.innerWidth - MIN_NON_SIDEBAR_AREA)
}
