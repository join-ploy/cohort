import React, { useCallback, useRef } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Ellipsis,
  FolderOpen,
  SquareSplitHorizontal
} from 'lucide-react'
import { useAppStore } from '../store'
import { useRepoById, useWorktreeById } from '../store/selectors'
import WorktreeContextMenu from './sidebar/WorktreeContextMenu'

const isMac = navigator.userAgent.includes('Mac')
const isLinux = navigator.userAgent.includes('Linux')

// Why: macOS opens Finder, Windows opens File Explorer, Linux opens Files —
// the label matches what the underlying shell.openPath actually invokes.
const externalOpenLabel = isMac
  ? 'Reveal in Finder'
  : isLinux
    ? 'Open Containing Folder'
    : 'Reveal in File Explorer'

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
  const worktree = useWorktreeById(activeWorktreeId)
  const repo = useRepoById(worktree?.repoId ?? null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const worktreePath = worktree?.path ?? ''

  const handleOpenExternal = useCallback((): void => {
    if (!worktreePath) {
      return
    }
    // Why: matches the existing right-click "Open in Finder" action on
    // WorktreeCard — there is no separate "external editor" IPC yet, so the
    // reveal-in-OS-file-manager is the closest available action.
    window.api.shell.openPath(worktreePath)
  }, [worktreePath])

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
          {/* Why: split button — left segment is the primary "open in editor"
              action; right segment will host an editor-picker dropdown once
              Orca grows a defaultEditor setting. For now both segments fall
              through to shell.openPath since there is no
              external-editor-launcher IPC yet. */}
          <div className="flex max-w-[260px] items-center">
            <button
              type="button"
              onClick={handleOpenExternal}
              aria-label={externalOpenLabel}
              title={externalOpenLabel}
              className="flex h-6 min-w-0 cursor-pointer items-center gap-1.5 rounded-sm rounded-r-none border border-r-0 border-border bg-background px-2 font-mono text-xs font-medium text-foreground hover:bg-accent"
            >
              <FolderOpen className="size-3 shrink-0" />
              <span className="min-w-0 truncate">{worktreePath}</span>
            </button>
            <button
              type="button"
              aria-label="Choose editor"
              // Why: no editor-picker UI exists yet. Disabled-styling makes
              // the stub state obvious; remove `cursor-default` and wire a
              // DropdownMenu when an external-editor concept lands.
              className="flex h-6 cursor-default items-center rounded-sm rounded-l-none border border-border bg-background px-1.5 text-muted-foreground hover:bg-accent"
              disabled
            >
              <ChevronDown className="size-3" />
            </button>
          </div>
          <button
            type="button"
            aria-label="Open in external editor"
            title={externalOpenLabel}
            onClick={handleOpenExternal}
            className="cursor-pointer text-muted-foreground hover:text-foreground"
          >
            <SquareSplitHorizontal className="size-4" />
          </button>
        </div>
      </div>
    </WorktreeContextMenu>
  )
}
