import React, { useCallback, useRef } from 'react'
import { ChevronRight, Ellipsis, PanelRight } from 'lucide-react'
import { useAppStore } from '../store'
import { useRepoById, useWorktreeById } from '../store/selectors'
import WorktreeContextMenu from './sidebar/WorktreeContextMenu'

const isMac = navigator.userAgent.includes('Mac')

/**
 * Above-tab-strip workspace context bar.
 *
 * Renders the active repo + worktree identity on the left, plus quick "open
 * folder externally" actions on the right. Returns null when the workspace is
 * not the active view (Settings, Tasks, Activity, Automations, landing) so the
 * bar never shows over non-terminal surfaces.
 */
export default function WorktreeContextBar(): React.JSX.Element | null {
  const activeView = useAppStore((s) => s.activeView)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar)
  const worktree = useWorktreeById(activeWorktreeId)
  const repo = useRepoById(worktree?.repoId ?? null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  const toggleSidebarLabel = rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar'
  const toggleSidebarShortcut = `${isMac ? '⌘' : 'Ctrl+'}L`

  const openContextMenuFromEllipsis = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>): void => {
      // Why: WorktreeContextMenu attaches an onContextMenuCapture on its
      // wrapper. Synthesising a 'contextmenu' MouseEvent at the button's
      // position re-uses the existing menu surface (same items, same
      // positioning logic) instead of forking a parallel DropdownMenu.
      const target = wrapperRef.current
      if (!target) {
        return
      }
      const rect = event.currentTarget.getBoundingClientRect()
      const synthetic = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left,
        clientY: rect.bottom
      })
      target.dispatchEvent(synthetic)
    },
    []
  )

  // Why: the bar only makes sense above the workspace's central tab strip.
  // Other views own their full content area and would be visually disrupted
  // by an extra strip above their headers. Early return must follow the hook
  // declarations so the hook order stays stable across renders.
  if (activeView !== 'terminal' || !activeWorktreeId || !worktree) {
    return null
  }

  return (
    <WorktreeContextMenu worktree={worktree}>
      <div
        ref={wrapperRef}
        // Why: bar is a draggable window strip on macOS/Windows where the
        // OS title chrome is hidden; interactive children opt out via
        // -webkit-app-region: no-drag below. Matches how `.titlebar` works.
        className="worktree-context-bar relative flex h-9 items-center justify-between border-b border-border bg-background pl-3 pr-1.5"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden pr-3">
          {/* Why: no GitHub remote → no avatar URL available on the Repo
              record. Falls back to the same color dot WorktreeCard uses so
              the bar stays visually consistent with the sidebar identity.
              TODO: surface repo owner via IPC so we can render the
              github.com/<owner>.png avatar when one exists. */}
          {repo ? (
            <span
              aria-hidden
              className="size-3 shrink-0 rounded-sm"
              style={{ backgroundColor: repo.badgeColor }}
            />
          ) : null}
          <span className="shrink-0 truncate text-sm font-medium text-muted-foreground">
            {repo?.displayName ?? 'Workspace'}
          </span>
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
          {/* Why: the worktree name is purely informational here in v1 — the
              right-click context menu (and the ellipsis button below) already
              expose rename + the rest of the worktree actions. */}
          <span className="min-w-0 truncate text-sm font-medium text-muted-foreground">
            {worktree.displayName}
          </span>
          <button
            type="button"
            aria-label="Worktree actions"
            onClick={openContextMenuFromEllipsis}
            className="ml-1 shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <Ellipsis className="size-3.5" />
          </button>
        </div>

        <div
          className="flex shrink-0 items-center gap-2"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {/* Why: hosts the right-sidebar toggle inside the bar so it lives
              in a no-drag region (the absolutely-positioned floating toggle
              that previously sat on top of the bar fought the OS drag region
              and couldn't reliably receive clicks). App.tsx removes its
              floating copy when this bar is mounted. */}
          <button
            type="button"
            onClick={toggleRightSidebar}
            aria-label={`${toggleSidebarLabel} (${toggleSidebarShortcut})`}
            title={`${toggleSidebarLabel} (${toggleSidebarShortcut})`}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <PanelRight className="size-4" />
          </button>
        </div>
      </div>
    </WorktreeContextMenu>
  )
}
