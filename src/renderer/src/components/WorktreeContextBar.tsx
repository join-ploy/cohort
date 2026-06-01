import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Database,
  Ellipsis,
  FolderOpen,
  GitCompare,
  Layers,
  PanelRight
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { toast } from 'sonner'
import { useAppStore } from '../store'
import {
  getGroupByWorktreeId,
  getMemberWorktreesForGroup,
  getRepoMapFromState,
  useRepoById,
  useWorktreeById
} from '../store/selectors'
import WorktreeContextMenu from './sidebar/WorktreeContextMenu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { tildifyPath } from '../lib/path'
import type { OrcaHooks, Repo, Worktree } from '../../../shared/types'

const isMac = navigator.userAgent.includes('Mac')
// Why: stable empty references so the non-group path skips the member/repo
// selectors entirely without churning shallow-equality on every render.
const EMPTY_MEMBERS: Worktree[] = []
const EMPTY_REPO_MAP = new Map<string, Repo>()

/**
 * Above-tab-strip workspace context bar.
 *
 * Renders the active repo + worktree identity on the left, plus the worktree
 * path readout and four "open externally" buttons on the right (Finder,
 * Database, Editor, Diff). Returns null when the workspace is not the active
 * view so the bar never shows over non-terminal surfaces.
 */
export default function WorktreeContextBar(): React.JSX.Element | null {
  const activeView = useAppStore((s) => s.activeView)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const settings = useAppStore((s) => s.settings)
  const worktree = useWorktreeById(activeWorktreeId)
  const repo = useRepoById(worktree?.repoId ?? null)
  // Why: when the active worktree is a group member, the breadcrumb should read
  // as "<group>" — the group is the workspace identity. Falls back to the
  // standard "<repo> > <worktree>" shape for ungrouped worktrees.
  const group = useAppStore((s) =>
    activeWorktreeId ? getGroupByWorktreeId(s, activeWorktreeId) : null
  )
  // Why: for a multi-repo group the path readout doubles as a repo switcher.
  // Selecting a member focuses it via setActiveWorktree — the same lightweight
  // switch the in-group tab strip uses, so the buttons below retarget to that
  // repo and the member's existing surface is restored WITHOUT spawning a new
  // agent terminal (which activateAndRevealWorktree would). Guard on groupId so
  // ungrouped worktrees pay no selector cost.
  const groupId = group?.id ?? null
  const groupMembers = useAppStore(
    useShallow((s) => (groupId ? getMemberWorktreesForGroup(s, groupId) : EMPTY_MEMBERS))
  )
  const repoMap = useAppStore((s) => (groupId ? getRepoMapFromState(s) : EMPTY_REPO_MAP))
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const worktreePath = worktree?.path ?? ''
  const workspaceName = worktree?.workspaceName ?? ''
  // Why: the renderer has no direct access to the OS home dir; fetch it once so
  // the path readout can collapse the home prefix to `~`. Stable per session.
  const [homeDir, setHomeDir] = useState<string>('')
  useEffect(() => {
    void window.api.app
      .getHomeDir()
      .then(setHomeDir)
      .catch(() => {})
  }, [])
  // Why: databaseUrl lives in the repo's orca.yaml / conductor.json so teammates
  // share one template. Mirror RunPanel's hooks:check pattern — re-fetch when the
  // active repo changes. Empty/missing → the Database 'url' preset is unconfigured.
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

  const toggleSidebarLabel = rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar'
  const toggleSidebarShortcut = `${isMac ? '⌘' : 'Ctrl+'}L`

  // Why: pre-hydration settings can be null for a frame; treat missing config as
  // not-yet-configured so the buttons render faded rather than crashing. The
  // VS Code editor preset is always "configured"; custom commands require a
  // non-empty string; the Database url preset requires a repo databaseUrl.
  const editorConfigured =
    settings?.externalEditorKind === 'vscode' ||
    (settings?.externalEditorCommand.trim().length ?? 0) > 0
  const diffConfigured = (settings?.externalDiffCommand.trim().length ?? 0) > 0
  const databaseConfigured =
    settings?.externalDatabaseKind === 'url'
      ? databaseUrl.length > 0
      : (settings?.externalDatabaseCommand.trim().length ?? 0) > 0

  const runTool = useCallback(
    (tool: 'editor' | 'diff' | 'database'): void => {
      if (!worktree || !repo) {
        return
      }
      void window.api.externalTool
        .run({
          tool,
          worktreeId: worktree.id,
          worktreePath: worktree.path,
          repoId: repo.id,
          workspaceName: worktree.workspaceName,
          displayName: worktree.displayName
        })
        .then((result) => {
          if (!result.ok) {
            toast.error(`Couldn't run ${tool} command${result.error ? `: ${result.error}` : ''}`)
          }
        })
        .catch(() => toast.error(`Couldn't run ${tool} command`))
    },
    [worktree, repo]
  )

  const handleFinder = useCallback((): void => {
    if (worktreePath) {
      window.api.shell.openPath(worktreePath)
    }
  }, [worktreePath])

  const handleDatabase = useCallback((): void => {
    if (!databaseConfigured) {
      return
    }
    if (settings?.externalDatabaseKind === 'custom') {
      runTool('database')
      return
    }
    if (!databaseUrl || !workspaceName) {
      return
    }
    const resolvedUrl = databaseUrl.split('${WORKSPACE_NAME}').join(workspaceName)
    void window.api.shell.openDatabase(resolvedUrl)
  }, [databaseConfigured, settings?.externalDatabaseKind, databaseUrl, workspaceName, runTool])

  const handleEditor = useCallback((): void => {
    if (!editorConfigured) {
      return
    }
    if (settings?.externalEditorKind === 'custom') {
      runTool('editor')
      return
    }
    // Why: vscode://file/ is a no-op on machines without VS Code installed,
    // matching shell.openPath's "open whatever the OS associates" behavior.
    if (worktreePath) {
      window.api.shell.openVscode(worktreePath)
    }
  }, [editorConfigured, settings?.externalEditorKind, worktreePath, runTool])

  const handleDiff = useCallback((): void => {
    if (diffConfigured) {
      runTool('diff')
    }
  }, [diffConfigured, runTool])

  const openContextMenuFromEllipsis = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>): void => {
      // Why: WorktreeContextMenu attaches an onContextMenuCapture on its wrapper.
      // Synthesising a 'contextmenu' MouseEvent at the button's position re-uses
      // the existing menu surface instead of forking a parallel DropdownMenu.
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

  // Why: the bar only makes sense above the workspace's central tab strip. Early
  // return must follow the hook declarations so hook order stays stable.
  if (activeView !== 'terminal' || !activeWorktreeId || !worktree) {
    return null
  }

  // Why: archived members have no renderable surface to switch to, so they're
  // excluded as switch targets. The switcher only appears once a group has more
  // than one live member — a single-member group has nothing to pick between.
  const switchableMembers = groupMembers.filter((m) => !m.isArchived)
  const showRepoSwitcher = group != null && switchableMembers.length > 1

  return (
    <WorktreeContextMenu worktree={worktree}>
      <div
        ref={wrapperRef}
        // Why: bar is a draggable window strip on macOS/Windows where the OS
        // title chrome is hidden; interactive children opt out via
        // -webkit-app-region: no-drag below. Background uses
        // --titlebar-background so it shares the terminal tab strip's color.
        className="worktree-context-bar relative flex h-9 items-center justify-between border-b border-border pl-3 pr-1.5"
        style={
          {
            WebkitAppRegion: 'drag',
            backgroundColor: 'var(--titlebar-background)'
          } as React.CSSProperties
        }
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden pr-3">
          {group && (
            <Layers
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-label="Workspace group"
            />
          )}
          <span className="shrink-0 truncate text-xs font-medium text-muted-foreground">
            {group ? group.displayName : (repo?.displayName ?? 'Workspace')}
          </span>
          {group ? (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/90">
              group
            </span>
          ) : (
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
          {/* Why: the worktree path is shown in full (no truncation) with the
              home prefix collapsed to `~`. In a multi-repo group it becomes a
              dropdown to switch the focused repo (which retargets the buttons);
              otherwise it's a plain readout — the Finder button owns reveal. */}
          {showRepoSwitcher ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Switch repo"
                  title={worktreePath}
                  className="flex items-center gap-1 whitespace-nowrap rounded-sm px-1 font-mono text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <span>{tildifyPath(worktreePath, homeDir)}</span>
                  <ChevronDown className="size-3 shrink-0" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64 p-1">
                {switchableMembers.map((member) => {
                  const memberRepo = repoMap.get(member.repoId)
                  return (
                    <DropdownMenuItem
                      key={member.id}
                      onSelect={() => setActiveWorktree(member.id)}
                      title={member.path}
                      className="flex items-center gap-2"
                    >
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: memberRepo?.badgeColor ?? 'var(--border)' }}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {memberRepo?.displayName ?? member.displayName}
                      </span>
                      {member.id === activeWorktreeId && <Check className="size-3.5 shrink-0" />}
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span
              className="whitespace-nowrap font-mono text-xs text-muted-foreground"
              title={worktreePath}
            >
              {tildifyPath(worktreePath, homeDir)}
            </span>
          )}

          {/* Why: local TooltipProvider so the bar's tooltips work even when
              rendered outside App's provider (tests / portaled surfaces). */}
          <TooltipProvider delayDuration={400}>
            <div className="flex items-center gap-0.5">
              <ToolButton
                label="Reveal in Finder"
                enabled
                onClick={handleFinder}
                icon={<FolderOpen className="size-3.5" />}
              />
              <ToolButton
                label="Open in database"
                enabled={databaseConfigured}
                onClick={handleDatabase}
                icon={<Database className="size-3.5" />}
              />
              <ToolButton
                label="Open in external editor"
                enabled={editorConfigured}
                onClick={handleEditor}
                icon={<Code2 className="size-3.5" />}
              />
              <ToolButton
                label="Open diff in external tool"
                enabled={diffConfigured}
                onClick={handleDiff}
                icon={<GitCompare className="size-3.5" />}
              />
            </div>
          </TooltipProvider>

          {/* Why: hosts the right-sidebar toggle inside the bar's no-drag
              region. App.tsx removes its workspace-view floating copy when this
              bar is mounted. */}
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

type ToolButtonProps = {
  label: string
  enabled: boolean
  onClick: () => void
  icon: React.ReactNode
}

// Why: aria-label + Tooltip live on every button (configured or not). When
// disabled we fade it and no-op the click rather than using the native
// `disabled` attribute, which would suppress the explanatory tooltip.
function ToolButton({ label, enabled, onClick, icon }: ToolButtonProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-disabled={!enabled}
          onClick={enabled ? onClick : undefined}
          className={`flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground ${
            enabled
              ? 'cursor-pointer hover:bg-accent hover:text-foreground'
              : 'cursor-not-allowed opacity-50'
          }`}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent>{enabled ? label : `${label} — not configured`}</TooltipContent>
    </Tooltip>
  )
}
