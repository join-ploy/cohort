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
  const settings = useAppStore((s) => s.settings)
  const worktree = useWorktreeById(activeWorktreeId)
  const repo = useRepoById(worktree?.repoId ?? null)
  // Why: when the active worktree is a group member, the breadcrumb should read
  // as "<group>" — the group is the workspace identity. Falls back to the
  // standard "<repo> > <worktree>" shape for ungrouped worktrees.
  const group = useAppStore((s) =>
    activeWorktreeId ? getGroupByWorktreeId(s, activeWorktreeId) : null
  )
  // Why: guard on groupId so ungrouped worktrees pay no member/repo selector cost.
  const groupId = group?.id ?? null
  const groupMembers = useAppStore(
    useShallow((s) => (groupId ? getMemberWorktreesForGroup(s, groupId) : EMPTY_MEMBERS))
  )
  const repoMap = useAppStore((s) => (groupId ? getRepoMapFromState(s) : EMPTY_REPO_MAP))

  // Why: in a multi-repo group the path readout is a repo *target* selector for
  // the action buttons. Picking a member deliberately does NOT change what's on
  // screen (no setActiveWorktree) — it only points Finder/Editor/Diff/Database at
  // that repo, so the user can act on a sibling repo while staying in the
  // group's main terminal. `targetOverride` is the user's pick; it's ignored once
  // it's no longer a live member of the current group (e.g. after moving to
  // another workspace), so the target falls back to the focused worktree.
  const [targetOverride, setTargetOverride] = useState<string | null>(null)
  const switchableMembers = groupMembers.filter((m) => !m.isArchived)
  const showRepoSwitcher = group != null && switchableMembers.length > 1
  const targetWorktreeId =
    targetOverride != null && switchableMembers.some((m) => m.id === targetOverride)
      ? targetOverride
      : activeWorktreeId
  // The action buttons operate on targetWorktree/targetRepo — the focused
  // worktree unless the user picked another group member from the switcher.
  const targetWorktree = useWorktreeById(targetWorktreeId)
  const targetRepo = useRepoById(targetWorktree?.repoId ?? null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const targetPath = targetWorktree?.path ?? ''
  const targetWorkspaceName = targetWorktree?.workspaceName ?? ''
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
  // share one template. Re-fetch for the TARGET repo (the Database button acts on
  // it). Empty/missing → the Database 'url' preset is unconfigured.
  const [databaseUrl, setDatabaseUrl] = useState<string>('')
  useEffect(() => {
    if (!targetRepo?.id) {
      setDatabaseUrl('')
      return
    }
    let cancelled = false
    void window.api.hooks
      .check({ repoId: targetRepo.id })
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
  }, [targetRepo?.id])

  const toggleSidebarLabel = rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar'
  const toggleSidebarShortcut = `${isMac ? '⌘' : 'Ctrl+'}L`

  // Why: the Finder button's label/tooltip must name what shell.openPath
  // actually opens on each platform — Finder on macOS, File Explorer on Windows,
  // the file manager on Linux (AGENTS.md cross-platform labelling rule).
  const finderLabel = isMac
    ? 'Reveal in Finder'
    : navigator.userAgent.includes('Linux')
      ? 'Open Containing Folder'
      : 'Reveal in File Explorer'

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
      if (!targetWorktree || !targetRepo) {
        return
      }
      void window.api.externalTool
        .run({
          tool,
          worktreeId: targetWorktree.id,
          worktreePath: targetWorktree.path,
          repoId: targetRepo.id,
          workspaceName: targetWorktree.workspaceName,
          displayName: targetWorktree.displayName
        })
        .then((result) => {
          if (!result.ok) {
            toast.error(`Couldn't run ${tool} command${result.error ? `: ${result.error}` : ''}`)
          }
        })
        .catch(() => toast.error(`Couldn't run ${tool} command`))
    },
    [targetWorktree, targetRepo]
  )

  const handleFinder = useCallback((): void => {
    if (targetPath) {
      window.api.shell.openPath(targetPath)
    }
  }, [targetPath])

  const handleDatabase = useCallback((): void => {
    if (!databaseConfigured) {
      return
    }
    if (settings?.externalDatabaseKind === 'custom') {
      runTool('database')
      return
    }
    if (!databaseUrl || !targetWorkspaceName) {
      return
    }
    const resolvedUrl = databaseUrl.split('${WORKSPACE_NAME}').join(targetWorkspaceName)
    void window.api.shell.openDatabase(resolvedUrl)
  }, [
    databaseConfigured,
    settings?.externalDatabaseKind,
    databaseUrl,
    targetWorkspaceName,
    runTool
  ])

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
    if (targetPath) {
      window.api.shell.openVscode(targetPath)
    }
  }, [editorConfigured, settings?.externalEditorKind, targetPath, runTool])

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
          {/* Why: the path is shown in full (no truncation) with the home prefix
              collapsed to `~`. In a multi-repo group it's a dropdown that picks
              which repo the action buttons target (without changing the on-screen
              view); otherwise a plain readout. The shown path is always the
              target's, so it reflects exactly what the buttons will act on. */}
          {showRepoSwitcher ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Choose repo for actions"
                  title={targetPath}
                  className="flex items-center gap-1 whitespace-nowrap rounded-sm px-1 font-mono text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <span>{tildifyPath(targetPath, homeDir)}</span>
                  <ChevronDown className="size-3 shrink-0" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64 p-1">
                {switchableMembers.map((member) => {
                  const memberRepo = repoMap.get(member.repoId)
                  return (
                    <DropdownMenuItem
                      key={member.id}
                      onSelect={() => setTargetOverride(member.id)}
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
                      {member.id === targetWorktreeId && <Check className="size-3.5 shrink-0" />}
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span
              className="whitespace-nowrap font-mono text-xs text-muted-foreground"
              title={targetPath}
            >
              {tildifyPath(targetPath, homeDir)}
            </span>
          )}

          {/* Why: local TooltipProvider so the bar's tooltips work even when
              rendered outside App's provider (tests / portaled surfaces). */}
          <TooltipProvider delayDuration={400}>
            <div className="flex items-center gap-0.5">
              <ToolButton
                label={finderLabel}
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
