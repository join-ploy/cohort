import React, { useCallback, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { PRState, WorkspaceGroup } from '../../../../shared/types'
import { getMemberWorktreesForGroup, getRepoMapFromState } from '@/store/selectors'
import { groupIsRunning } from './group-aggregation'
import { getWorktreeCardPrDisplay } from './worktree-card-pr-display'
import { prStateLabel, branchDisplayName } from './WorktreeCardHelpers'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { FolderOpen, LoaderCircle, MessageSquare, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import { runGroupArchive } from './archive-group-flow'

export type GroupCardProps = {
  group: WorkspaceGroup
  isActive?: boolean
}

// Why: PR-state coloring mirrors the swatches used in WorktreeCardMeta's PR
// section so grouped rows speak the same visual language as ungrouped cards
// without pulling in the full HoverCard/dropdown chrome.
const PR_STATE_CLASSES: Record<PRState, string> = {
  open: 'text-emerald-500/80',
  draft: 'text-muted-foreground/60',
  merged: 'text-purple-600/70 dark:text-purple-400/70',
  closed: 'text-muted-foreground/60'
}

const GroupCard = React.memo(function GroupCard({ group, isActive = false }: GroupCardProps) {
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const openModal = useAppStore((s) => s.openModal)
  const updateWorkspaceGroup = useAppStore((s) => s.updateWorkspaceGroup)

  const members = useAppStore(useShallow((s) => getMemberWorktreesForGroup(s, group.id)))
  const repoMap = useAppStore((s) => getRepoMapFromState(s))
  const prCache = useAppStore((s) => s.prCache)
  const isArchiving = useAppStore((s) => s.archivingGroupIds.has(group.id))

  // Why: runningWorktreeIds is not a first-class store field yet; derive it
  // from scriptsByWorktree on the fly. Mirrors how WorktreeCard reads its own
  // run-active flag (slices/scripts.ts). TODO: lift to a shared selector once
  // GroupsSection (E4) and other surfaces start needing it.
  const runningWorktreeIds = useAppStore(
    useShallow((s) => {
      const ids = new Set<string>()
      for (const [worktreeId, entry] of Object.entries(s.scriptsByWorktree)) {
        if (entry.run.status === 'running') {
          ids.add(worktreeId)
        }
      }
      return ids
    })
  )

  const isRunning = useMemo(
    () => groupIsRunning(members, runningWorktreeIds),
    [members, runningWorktreeIds]
  )

  const handleClick = useCallback(() => {
    // TODO: real group-activation lands when Phase F/G wires the main pane.
    // For now, activate the first member so clicking the card has feedback.
    const firstMemberId = group.memberWorktreeIds[0]
    if (firstMemberId) {
      setActiveWorktree(firstMemberId)
    }
  }, [group.memberWorktreeIds, setActiveWorktree])

  // Why: GroupCard owns its own right-click context menu rather than reusing
  // WorktreeContextMenu — the worktree menu carries linked-issue/PR rows and
  // multi-select machinery that don't apply to a group in v1. Keeping the
  // menu local lets us add only the affordances that map to a group
  // (rename, edit comment, pin/unpin, open folder, archive).
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })

  const handleArchive = useCallback(() => {
    setMenuOpen(false)
    runGroupArchive(group.id, group.displayName)
  }, [group.id, group.displayName])

  const handleRename = useCallback(() => {
    setMenuOpen(false)
    openModal('edit-group-meta', {
      groupId: group.id,
      currentDisplayName: group.displayName,
      currentComment: group.comment,
      focus: 'displayName'
    })
  }, [group.comment, group.displayName, group.id, openModal])

  const handleEditComment = useCallback(() => {
    setMenuOpen(false)
    openModal('edit-group-meta', {
      groupId: group.id,
      currentDisplayName: group.displayName,
      currentComment: group.comment,
      focus: 'comment'
    })
  }, [group.comment, group.displayName, group.id, openModal])

  const handleTogglePin = useCallback(() => {
    setMenuOpen(false)
    void updateWorkspaceGroup(group.id, { isPinned: !group.isPinned })
  }, [group.id, group.isPinned, updateWorkspaceGroup])

  const handleOpenInFinder = useCallback(() => {
    setMenuOpen(false)
    // Why: WorktreeContextMenu uses the same shell.openPath helper for its
    // "Open in Finder" row — reuse it so platform differences (Finder, File
    // Explorer, GNOME Files) stay routed through Electron's shell module.
    window.api.shell.openPath(group.parentPath)
  }, [group.parentPath])

  const hasCleanupError = group.archiveCleanupError != null && group.archiveCleanupError !== ''

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Group ${group.displayName}`}
      aria-pressed={isActive}
      className={cn(
        'group relative flex flex-col gap-1.5 px-2 py-2 cursor-pointer transition-all duration-200 outline-none select-none ml-1 rounded-lg',
        isActive
          ? 'bg-black/[0.08] shadow-[0_1px_2px_rgba(0,0,0,0.04)] border border-black/[0.015] dark:bg-white/[0.10] dark:border-border/40 dark:shadow-[0_1px_2px_rgba(0,0,0,0.03)]'
          : 'border border-transparent hover:bg-sidebar-accent/40',
        isArchiving && 'opacity-50 grayscale cursor-not-allowed'
      )}
      onClick={isArchiving ? undefined : handleClick}
      onDoubleClick={isArchiving ? undefined : handleRename}
      onContextMenu={(e) => {
        e.preventDefault()
        if (isArchiving) {
          return
        }
        const bounds = e.currentTarget.getBoundingClientRect()
        setMenuPoint({ x: e.clientX - bounds.left, y: e.clientY - bounds.top })
        setMenuOpen(true)
      }}
      onKeyDown={(e) => {
        if (isArchiving) {
          return
        }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleClick()
        }
      }}
      aria-busy={isArchiving}
      data-testid="group-card"
    >
      {/* Why: matches the dim-overlay-with-spinner pattern WorktreeCard uses
          for its force-delete in-flight state. Group archive runs cleanup
          scripts in parallel across every member which can take real seconds,
          so the user needs visible feedback that the action is still going. */}
      {isArchiving && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-background/50 backdrop-blur-[1px]">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-background px-3 py-1 text-[11px] font-medium text-foreground shadow-sm border border-border/50">
            <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
            Archiving…
          </div>
        </div>
      )}
      {/* Header row: optional running dot + group displayName */}
      <div className="flex items-center gap-1.5 min-w-0">
        {isRunning && (
          <span
            aria-label="A member is running"
            role="img"
            className="inline-block size-2 rounded-full bg-emerald-500 shrink-0"
            data-testid="group-running-dot"
          />
        )}
        <span className="text-[13px] font-normal truncate leading-tight text-foreground">
          {group.displayName}
        </span>
      </div>

      {/* Body: one row per member repo.
          Why: pl-3 + a left border bar communicates "these are members of THIS
          group, not top-level repos" — matches how WorktreeList nests cards
          under repo headers visually without reusing that scaffolding. */}
      {members.length > 0 && (
        <div
          className="ml-1 flex flex-col gap-0.5 border-l border-border/50 pl-2"
          data-testid="group-members"
        >
          {members.map((member) => {
            const repo = repoMap.get(member.repoId)
            const repoName = repo?.displayName ?? member.repoId
            // Why: prCache is keyed by `${repo.path}::${branch}` (see
            // WorktreeCard.tsx where the same key is computed), not by
            // worktreeId — match that layout so a member's cached PR
            // resolves the same way it does on its standalone card.
            const branch = branchDisplayName(member.branch)
            const prCacheKey = repo && branch ? `${repo.path}::${branch}` : ''
            const prEntry = prCacheKey ? prCache[prCacheKey] : undefined
            const pr = prEntry?.data ?? undefined
            const prDisplay = getWorktreeCardPrDisplay(pr, member.linkedPR)
            const prState = prDisplay?.state
            return (
              <div
                key={member.id}
                className="flex items-center gap-1.5 min-w-0 text-[12px] leading-tight"
                data-testid="group-member-row"
                data-member-id={member.id}
              >
                <span className="text-muted-foreground truncate flex-1 min-w-0">{repoName}</span>
                {prDisplay && (
                  <span className="flex items-center gap-1 shrink-0 tabular-nums">
                    <span className="text-muted-foreground/80">#{prDisplay.number}</span>
                    {prState && (
                      <span className={cn('text-[11px]', PR_STATE_CLASSES[prState])}>
                        {prStateLabel(prState).toLowerCase()}
                      </span>
                    )}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Why: surface the last archive-cleanup failure inline so the user can
          see which member(s) blocked the cascade without leaving the visible
          Groups list. ArchivedSection renders the same string for archived
          rows; this is the unarchived-but-blocked counterpart. */}
      {hasCleanupError && (
        <div
          data-testid="group-archive-cleanup-error"
          title={group.archiveCleanupError ?? undefined}
          className="text-[11px] text-destructive truncate"
        >
          Archive blocked: {group.archiveCleanupError}
        </div>
      )}

      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none absolute size-px opacity-0"
            style={{ left: menuPoint.x, top: menuPoint.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-52" sideOffset={0} align="start">
          <DropdownMenuItem onSelect={handleOpenInFinder} data-testid="group-card-open-folder">
            <FolderOpen className="size-3.5" />
            Open in Finder
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleTogglePin} data-testid="group-card-pin-action">
            {group.isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
            {group.isPinned ? 'Unpin' : 'Pin'}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleRename} data-testid="group-card-rename-action">
            <Pencil className="size-3.5" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleEditComment} data-testid="group-card-comment-action">
            <MessageSquare className="size-3.5" />
            {group.comment ? 'Edit Comment' : 'Add Comment'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* Why: v1 intentionally skips "Set as primary", "Sleep/wake", and
              "Delete now" — see plan §"Issue 3 scope": neither maps cleanly
              onto a group today (no primary member concept, no sleep/wake
              at group scope, no out-of-band delete flow). */}
          <DropdownMenuItem
            variant="destructive"
            onSelect={handleArchive}
            data-testid="group-card-archive-action"
          >
            <Trash2 className="size-3.5" />
            Archive Group
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})

export default GroupCard
