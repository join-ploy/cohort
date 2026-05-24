import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Code2,
  Database,
  Ellipsis,
  Folder,
  FolderOpen,
  PanelRight
} from 'lucide-react'
import { useAppStore } from '../store'
import { getGroupByWorktreeId, useRepoById, useWorktreeById } from '../store/selectors'
import WorktreeContextMenu from './sidebar/WorktreeContextMenu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { OrcaHooks } from '../../../shared/types'

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
  // Why: nullish-coalesce guards the brief pre-hydration window when the slice
  // initializer has not yet run (older tests + first-paint), so the bar never
  // renders an undefined opener choice.
  const pathOpenerChoice = useAppStore((s) => s.pathOpenerChoice ?? 'finder')
  const setPathOpenerChoice = useAppStore((s) => s.setPathOpenerChoice)
  const worktree = useWorktreeById(activeWorktreeId)
  const repo = useRepoById(worktree?.repoId ?? null)
  // Why: when the active worktree is a group member, the breadcrumb should
  // read as "<group> > <repo>" — the group is the workspace identity, the
  // repo is the inset position within it. Falls back to the standard
  // "<repo> > <worktree>" shape for ungrouped worktrees.
  const group = useAppStore((s) =>
    activeWorktreeId ? getGroupByWorktreeId(s, activeWorktreeId) : null
  )
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const worktreePath = worktree?.path ?? ''
  const workspaceName = worktree?.workspaceName ?? ''
  // Why: databaseUrl now lives in the repo's orca.yaml / conductor.json so
  // teammates share one connection template. Mirror RunPanel's hooks:check
  // pattern — re-fetch when the active repo changes and store the trimmed
  // value in local state. Empty/missing → Database opener stays disabled.
  const [databaseUrl, setDatabaseUrl] = useState<string>('')
  useEffect(() => {
    if (!repo?.id) {
      setDatabaseUrl('')
      return
    }
    let cancelled = false
    void window.api.hooks
      .check({ repoId: repo.id })
      .then((result) => {
        if (cancelled) {
          return
        }
        const hooks = (result.hooks as OrcaHooks | null) ?? null
        setDatabaseUrl(hooks?.databaseUrl?.trim() ?? '')
      })
      .catch(() => {
        if (!cancelled) {
          setDatabaseUrl('')
        }
      })
    return () => {
      cancelled = true
    }
  }, [repo?.id])
  const databaseTemplateConfigured = databaseUrl.length > 0

  const toggleSidebarLabel = rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar'
  const toggleSidebarShortcut = `${isMac ? '⌘' : 'Ctrl+'}L`

  // Why: macOS opens Finder, Windows opens File Explorer, Linux opens Files —
  // the label matches what the underlying shell.openPath actually invokes.
  const finderLabel = isMac
    ? 'Reveal in Finder'
    : navigator.userAgent.includes('Linux')
      ? 'Open Containing Folder'
      : 'Reveal in File Explorer'

  const primaryLabel =
    pathOpenerChoice === 'vscode'
      ? 'Open in VS Code'
      : pathOpenerChoice === 'database'
        ? 'Open in Database'
        : finderLabel

  const handleOpenPath = useCallback((): void => {
    if (pathOpenerChoice === 'database') {
      // Why: guard at click-time so a cleared template after the user picked
      // Database in the dropdown silently no-ops instead of dispatching an
      // invalid URL. Empty workspaceName is impossible for non-null worktree,
      // but the check costs nothing and protects the URL substitution.
      if (!databaseUrl || !workspaceName) {
        return
      }
      const resolvedUrl = databaseUrl.split('${WORKSPACE_NAME}').join(workspaceName)
      void window.api.shell.openDatabase(resolvedUrl)
      return
    }
    if (!worktreePath) {
      return
    }
    if (pathOpenerChoice === 'vscode') {
      // Why: vscode://file/ is a no-op on machines without VS Code installed,
      // matching shell.openPath's "open whatever the OS associates" behavior.
      window.api.shell.openVscode(worktreePath)
    } else {
      window.api.shell.openPath(worktreePath)
    }
  }, [worktreePath, pathOpenerChoice, databaseUrl, workspaceName])

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
        // Background uses --titlebar-background so the breadcrumb bar
        // shares the exact chrome color as the terminal tab strip above
        // (the strip is portaled into `.titlebar`, which reads the same var).
        className="worktree-context-bar relative flex h-9 items-center justify-between border-b border-border pl-3 pr-1.5"
        style={
          {
            WebkitAppRegion: 'drag',
            backgroundColor: 'var(--titlebar-background)'
          } as React.CSSProperties
        }
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden pr-3">
          {/* Why: breadcrumb uses text-xs (12px) so it sits visually below the
              tab strip's labels — it's identity metadata, not a primary action.
              For grouped workspaces, the GROUP is the workspace identity; we
              don't render a second segment because the per-repo position is
              already surfaced by the segmented tabs in Setup/Run/Diff/Source/
              Checks. Naming a specific member here was misleading (it locked
              to the first member regardless of which segment the user was
              viewing). Ungrouped worktrees keep the original
              "<repo> > <worktree>" shape. */}
          <span className="shrink-0 truncate text-xs font-medium text-muted-foreground">
            {group ? group.displayName : (repo?.displayName ?? 'Workspace')}
          </span>
          {!group && (
            <>
              <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">
                {worktree.displayName}
              </span>
            </>
          )}
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
          {/* Why: split button — left segment dispatches to the currently
              selected opener (Finder/Explorer/Files, VS Code, or the
              configured Database client); right segment is the DropdownMenu
              that picks which opener that primary click uses. The chosen
              opener persists via PersistedUIState. */}
          <div className="flex max-w-[260px] items-center">
            {/* Why: backgroundColor inherits the bar's --titlebar-background
                token so the selector visually flattens into the bar instead
                of sitting on a darker bg-background that read as a heavy
                inset. Hover keeps an accent wash for affordance. */}
            <button
              type="button"
              onClick={handleOpenPath}
              aria-label={primaryLabel}
              title={primaryLabel}
              className="flex h-6 min-w-0 cursor-pointer items-center gap-1.5 rounded-sm rounded-r-none border border-r-0 border-border px-2 font-mono text-xs font-medium text-foreground hover:bg-accent"
              style={{ backgroundColor: 'var(--titlebar-background)' }}
            >
              {/* Why: icon mirrors the active opener choice so the button's
                  glyph matches what clicking it will do. */}
              {pathOpenerChoice === 'vscode' ? (
                <Code2 className="size-3 shrink-0" />
              ) : pathOpenerChoice === 'database' ? (
                <Database className="size-3 shrink-0" />
              ) : (
                <FolderOpen className="size-3 shrink-0" />
              )}
              <span className="min-w-0 truncate">{worktreePath}</span>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Choose opener"
                  className="flex h-6 cursor-pointer items-center rounded-sm rounded-l-none border border-border px-1.5 text-muted-foreground hover:bg-accent"
                  style={{ backgroundColor: 'var(--titlebar-background)' }}
                >
                  <ChevronDown className="size-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48 p-1">
                <DropdownMenuItem
                  onSelect={() => setPathOpenerChoice('finder')}
                  className="flex items-center gap-2"
                >
                  <Folder className="size-3.5" />
                  <span>Finder</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => setPathOpenerChoice('vscode')}
                  className="flex items-center gap-2"
                >
                  <Code2 className="size-3.5" />
                  <span>VS Code</span>
                </DropdownMenuItem>
                {/* Why: disabling the item (rather than hiding it) keeps the
                    Database affordance discoverable. The inline "Configure in
                    Settings" hint explains why it's greyed out — a `title`
                    tooltip would never fire because Radix sets
                    pointer-events: none on disabled items. */}
                <DropdownMenuItem
                  onSelect={() => setPathOpenerChoice('database')}
                  disabled={!databaseTemplateConfigured}
                  className="flex items-center gap-2"
                >
                  <Database className="size-3.5" />
                  <span className="flex-1">Database</span>
                  {!databaseTemplateConfigured && (
                    <span className="text-[10px] text-muted-foreground">Configure</span>
                  )}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {/* Why: hosts the right-sidebar toggle inside the bar's no-drag
              region. App.tsx removes its workspace-view floating copy when
              this bar is mounted; the right-sidebar header no longer hosts
              a duplicate either. */}
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
