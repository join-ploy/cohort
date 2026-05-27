import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { isAutomationRunActive } from '@/store/slices/automation-runs'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { LinearIssue, Repo, WorkspaceGroup, Worktree } from '../../../../shared/types'
import { getMemberWorktreesForGroup, getRepoMapFromState } from '@/store/selectors'
import { groupIsRunning } from './group-aggregation'
import { getWorktreeCardPrDisplay } from './worktree-card-pr-display'
import { branchDisplayName, checksLabel } from './WorktreeCardHelpers'
import { LinearIssueSection, PrSection } from './WorktreeCardMeta'
import WorktreeCardAgents from './WorktreeCardAgents'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  Bot,
  CircleCheck,
  CircleX,
  Copy,
  FolderOpen,
  LoaderCircle,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Trash2
} from 'lucide-react'
import { runGroupArchive } from './archive-group-flow'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'

// Why: keep the periodic sidebar PR refresh aligned with the user-requested
// 60s cadence. WorktreeCard's mount-effect calls fetchPRForBranch once; the
// shared 5-min cache TTL then prevented any actual refetch in steady state.
// A 60s interval with force=true keeps PR additions/deletions, state and
// checksStatus reactive without rippling through every cache consumer.
const SIDEBAR_PR_REFRESH_INTERVAL_MS = 60_000

export type GroupCardProps = {
  group: WorkspaceGroup
  isActive?: boolean
}

const GroupCard = React.memo(function GroupCard({ group, isActive = false }: GroupCardProps) {
  const openModal = useAppStore((s) => s.openModal)
  const updateWorkspaceGroup = useAppStore((s) => s.updateWorkspaceGroup)

  const members = useAppStore(useShallow((s) => getMemberWorktreesForGroup(s, group.id)))
  const repoMap = useAppStore((s) => getRepoMapFromState(s))
  const isArchiving = useAppStore((s) => s.archivingGroupIds.has(group.id))
  const cardProps = useAppStore((s) => s.worktreeCardProperties)
  const showInlineAgents = cardProps.includes('inline-agents')

  // Why: union the group's own linkedLinearIssue with each member's so a
  // ticket linked at create-time on either surface still surfaces in the
  // sidebar. Dedup by identifier — same ticket linked from group + member
  // should render once. Stable order: group's own first, then members in
  // declared order so the visual layout doesn't reshuffle as new members
  // get linked over time.
  const linearIdentifiers = useMemo(() => {
    const out: string[] = []
    const seen = new Set<string>()
    const push = (id: string | null | undefined): void => {
      if (id && !seen.has(id)) {
        seen.add(id)
        out.push(id)
      }
    }
    push(group.linkedLinearIssue)
    for (const m of members) {
      push(m.linkedLinearIssue)
    }
    return out
  }, [group.linkedLinearIssue, members])

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
    const firstMemberId = group.memberWorktreeIds[0]
    if (firstMemberId) {
      activateAndRevealWorktree(firstMemberId)
    }
  }, [group.memberWorktreeIds])

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

  const memberPrUrls = useAppStore(
    useShallow((s) => {
      const urls: string[] = []
      for (const member of members) {
        const repo = repoMap.get(member.repoId)
        if (!repo) {
          continue
        }
        const branch = branchDisplayName(member.branch)
        if (!branch) {
          continue
        }
        const entry = s.prCache[`${repo.path}::${branch}`]
        if (entry?.data?.url) {
          urls.push(entry.data.url)
        }
      }
      return urls
    })
  )

  const handleCopyPrLinks = useCallback(() => {
    setMenuOpen(false)
    if (memberPrUrls.length > 0) {
      window.api.ui.writeClipboardText(memberPrUrls.join('\n'))
    }
  }, [memberPrUrls])

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
      {/* Header row: optional running dot + group displayName.
          Why: mirror the WorktreeCard title classes (text-[13px] truncate
          leading-tight + font-normal/foreground) so the group name reads as
          a sibling of the workspace folder name, not a subtler caption. */}
      <div className="flex items-center gap-1.5 min-w-0">
        {isRunning && (
          <span
            aria-label="A member is running"
            role="img"
            className="inline-block size-2 rounded-full bg-emerald-500 shrink-0"
            data-testid="group-running-dot"
          />
        )}
        <span
          className={cn(
            'text-[13px] truncate leading-tight',
            group.isUnread ? 'font-semibold' : 'font-normal',
            'text-foreground'
          )}
        >
          {group.displayName}
        </span>
      </div>

      {/* Why: linked Linear tickets render as IssueSection-style rows above
          the repo list, matching the row layout used elsewhere on workspace
          cards. Group-level link first, then each member's link in declared
          order (deduped); placement above the members visually maps "this
          ticket scopes the work below". */}
      {linearIdentifiers.length > 0 && (
        <div className="flex flex-col gap-0.5" data-testid="group-linear-issues">
          {linearIdentifiers.map((identifier) => (
            <GroupLinearIssueRow key={identifier} identifier={identifier} />
          ))}
        </div>
      )}

      {/* Body: one row per member repo.
          Why: pl-3 + a left border bar communicates "these are members of THIS
          group, not top-level repos" — matches how WorktreeList nests cards
          under repo headers visually without reusing that scaffolding. */}
      {members.length > 0 && (
        <div
          className="ml-1 flex flex-col gap-1 border-l border-border/50 pl-2"
          data-testid="group-members"
        >
          {members.map((member) => (
            <GroupMemberRow key={member.id} member={member} repo={repoMap.get(member.repoId)} />
          ))}
        </div>
      )}

      {/* Why: combined agents list spans every member — the user picked this
          over per-member placement so they can see the whole group's live
          agent activity at a glance. Each member's WorktreeCardAgents renders
          nothing when it has no agents, so the section silently vanishes for
          idle groups. Gated on the same `inline-agents` card property that
          drives the single-workspace card so the user's hide preference is
          honored consistently across both surfaces. */}
      {showInlineAgents && members.length > 0 && (
        <div
          className="ml-1 mt-0.5 flex flex-col gap-0.5"
          data-testid="group-agents"
          // Why: swallow bubbling so an agent-row click doesn't fall through
          // to the GroupCard root's handleClick / handleRename. Each member's
          // WorktreeCardAgents installs its own stopBubble too, but it lives
          // inside conditional renders; this outer guard covers any future
          // sibling content tucked into the same wrapper.
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {members.map((member) => (
            <WorktreeCardAgents key={member.id} worktreeId={member.id} />
          ))}
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
          {memberPrUrls.length > 0 && (
            <DropdownMenuItem onSelect={handleCopyPrLinks} data-testid="group-card-copy-pr-links">
              <Copy className="size-3.5" />
              Copy PR {memberPrUrls.length === 1 ? 'Link' : 'Links'}
            </DropdownMenuItem>
          )}
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

type GroupMemberRowProps = {
  member: Worktree
  repo: Repo | undefined
}

/**
 * Per-member row inside a GroupCard. Hand-rolls the visual subset of
 * WorktreeCard that survives inside the group container (run indicator,
 * change-file count, CI status, repo display name + optional PR row).
 *
 * Why hand-rolled rather than rendering a real WorktreeCard: WorktreeCard
 * owns its own context menu, multi-select, drag, and SSH-disconnect dialog
 * — every one of which would clash with the group-level affordances. The
 * common payload is shallow enough that mirroring it keeps both surfaces
 * honest without forcing a half-baked extraction.
 */
const GroupMemberRow = React.memo(function GroupMemberRow({
  member,
  repo
}: GroupMemberRowProps): React.JSX.Element {
  const openModal = useAppStore((s) => s.openModal)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const fetchPRForBranch = useAppStore((s) => s.fetchPRForBranch)
  const cardProps = useAppStore((s) => s.worktreeCardProperties)
  const showPR = cardProps.includes('pr')
  const showCI = cardProps.includes('ci')

  // Why: focused selector keeps re-renders local to this row when the
  // member's run-script status flips — mirrors WorktreeCard's pattern.
  const isRunActive = useAppStore((s) => s.scriptsByWorktree?.[member.id]?.run.status === 'running')

  // Why: file-count badge reads off the same per-worktree status array
  // FileExplorer / SourceControl use, so the number stays consistent across
  // every surface that mentions changes for this worktree. Polling for
  // non-active members is now driven by useGitStatusPolling's group fan-out
  // so the count stays fresh without the user having to switch members.
  const changedFileCount = useAppStore((s) => (s.gitStatusByWorktree[member.id] ?? []).length)

  // Why: surface the worktree's automation-creation badge per member so
  // group rows match WorktreeCard's affordance. A pulsing bot signals an
  // active automation run; a static bot signals "created by automation,
  // run has terminated". Sibling members in a group can each have their
  // own createdByAutomationRunId because grouped creation forwards the
  // chain run id onto every worktree it minted.
  const automationRunId = member.createdByAutomationRunId
  const automationRunStatus = useAppStore((s) =>
    automationRunId ? s.automationRunsById[automationRunId]?.status : undefined
  )
  const automationBadge = automationRunId
    ? {
        active: automationRunStatus ? isAutomationRunActive(automationRunStatus) : false,
        tooltip: automationRunStatus
          ? isAutomationRunActive(automationRunStatus)
            ? 'Automation running…'
            : 'Created by automation'
          : 'Created by automation'
      }
    : null

  // Why: prCache is keyed `${repo.path}::${branch}` (see WorktreeCard
  // where the same key is computed), not by worktreeId — match that
  // layout so a member's cached PR resolves the same way it does on
  // its standalone card.
  const branch = branchDisplayName(member.branch)
  const isFolder = repo ? isFolderRepo(repo) : false
  const prCacheKey = repo && branch ? `${repo.path}::${branch}` : ''
  const prEntry = useAppStore((s) => (prCacheKey ? s.prCache[prCacheKey] : undefined))
  const pr = prEntry?.data ?? undefined
  const prDisplay = getWorktreeCardPrDisplay(pr, member.linkedPR)
  const checksStatus = pr?.checksStatus

  // Why: before this effect, group sibling rows pulled stale PR data from
  // the cache (whatever the user had last warmed by visiting the member's
  // worktree) and never re-fetched on their own. Match WorktreeCard's
  // mount-fetch and add the user-requested 60s sidebar refresh interval so
  // PR additions/deletions, state, and checksStatus actually move while
  // the user stays focused inside Orca. Skip when both PR and CI columns
  // are hidden — a presentational preference shouldn't burn rate limit on
  // data the user cannot see.
  useEffect(() => {
    if (!repo || isFolder || member.isBare || !prCacheKey || (!showPR && !showCI)) {
      return
    }
    const linkedPRNumber = member.linkedPR ?? null
    fetchPRForBranch(repo.path, branch, { linkedPRNumber })
    const interval = setInterval(() => {
      // Why: force so the interval actually pulls fresh data even when the
      // 5-minute prCache TTL would otherwise short-circuit a non-forced call.
      fetchPRForBranch(repo.path, branch, { linkedPRNumber, force: true })
    }, SIDEBAR_PR_REFRESH_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [
    repo,
    isFolder,
    member.isBare,
    member.linkedPR,
    branch,
    prCacheKey,
    fetchPRForBranch,
    showPR,
    showCI
  ])

  const repoName = repo?.displayName ?? member.repoId

  const handleEditPr = useCallback(() => {
    openModal('edit-meta', {
      worktreeId: member.id,
      currentDisplayName: member.displayName,
      currentIssue: member.linkedIssue,
      currentPR: member.linkedPR,
      currentComment: member.comment,
      focus: 'pr'
    })
  }, [member, openModal])

  const handleRemovePr = useCallback(() => {
    void updateWorktreeMeta(member.id, { linkedPR: null })
  }, [member.id, updateWorktreeMeta])

  // PrSection requires an onClick. Member rows are not independently
  // interactive — clicks bubble to the GroupCard root which treats them
  // as a group activation, so this is intentionally empty.
  const noopPrSectionClick = useCallback((_e: React.MouseEvent) => {
    // intentionally empty: see comment above.
  }, [])

  return (
    <div
      className="flex flex-col gap-0.5 -mx-1 px-1 py-0.5"
      data-testid="group-member-row"
      data-member-id={member.id}
    >
      {/* Header line: repo name + [branch] + change count + CI icon + run indicator */}
      <div className="flex items-center justify-between min-w-0 gap-2">
        {/* Why: repo name + parenthesized branch share the left flex slot so
            they truncate as one unit when space runs short, preserving the
            right-side change-count / CI / run indicators. Repo name is a
            slightly muted grey to keep emphasis on the branch (which the
            user is more likely to be working with).
          */}
        <span className="text-[12px] leading-tight truncate min-w-0 flex-1 text-foreground/70">
          {repoName}
          {branch && <span className="text-foreground"> ({branch})</span>}
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Why: PR-based +/- diff stats. Matches the per-card display on
              WorktreeCard (line ~597) so the user gets the same "size of the
              change vs the PR base" signal here. Hidden when both totals are 0
              or there is no PR — keeps unchanged worktrees uncluttered. */}
          {pr && ((pr.additions ?? 0) > 0 || (pr.deletions ?? 0) > 0) && (
            <span
              className="text-[10px] tabular-nums leading-none shrink-0"
              data-testid="group-member-diff-stats"
              aria-label={`+${pr.additions ?? 0} additions, -${pr.deletions ?? 0} deletions`}
            >
              <span className="text-emerald-500">+{pr.additions ?? 0}</span>{' '}
              <span className="text-rose-500">−{pr.deletions ?? 0}</span>
            </span>
          )}
          {changedFileCount > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="text-[10px] tabular-nums leading-none text-muted-foreground/80"
                  data-testid="group-member-change-count"
                  aria-label={`${changedFileCount} changed files`}
                >
                  {changedFileCount}
                </span>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                <span>
                  {changedFileCount} changed {changedFileCount === 1 ? 'file' : 'files'}
                </span>
              </TooltipContent>
            </Tooltip>
          )}
          {automationBadge && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  data-testid="group-member-automation-bot"
                  data-automation-run-id={automationRunId}
                  data-automation-active={automationBadge.active ? 'true' : 'false'}
                  className="inline-flex items-center text-muted-foreground"
                >
                  <Bot
                    className={cn(
                      'size-3',
                      automationBadge.active && 'animate-pulse text-foreground'
                    )}
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                <span>{automationBadge.tooltip}</span>
              </TooltipContent>
            </Tooltip>
          )}
          {checksStatus && checksStatus !== 'neutral' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="inline-flex items-center opacity-80 hover:opacity-100 transition-opacity"
                  data-testid="group-member-ci"
                >
                  {checksStatus === 'success' && (
                    <CircleCheck className="size-3 text-emerald-500" />
                  )}
                  {checksStatus === 'failure' && <CircleX className="size-3 text-rose-500" />}
                  {checksStatus === 'pending' && (
                    <LoaderCircle className="size-3 text-amber-500 animate-spin" />
                  )}
                </span>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                <span>CI checks {checksLabel(checksStatus).toLowerCase()}</span>
              </TooltipContent>
            </Tooltip>
          )}
          {/* Why: same 3-bar equalizer WorktreeCard uses for live run scripts
              (.orca-run-eq, defined in main.css). Sized down a hair to fit
              the denser member row. */}
          {isRunActive && (
            <span
              className="orca-run-eq shrink-0"
              role="img"
              aria-label="Run script is running"
              data-testid="group-member-run-eq"
            >
              <span className="orca-run-eq__bar" />
              <span className="orca-run-eq__bar" />
              <span className="orca-run-eq__bar" />
            </span>
          )}
        </div>
      </div>

      {/* PR row underneath when the member has a linked PR. Reuses
          PrSection so the chrome (state-tinted icon, hover card, edit/
          remove dropdown) stays in lockstep with WorktreeCard. */}
      {prDisplay && (
        <PrSection
          pr={prDisplay}
          onClick={noopPrSectionClick}
          onEdit={handleEditPr}
          onRemove={handleRemovePr}
        />
      )}
    </div>
  )
})

type GroupLinearIssueRowProps = {
  identifier: string
}

/**
 * Per-row Linear ticket renderer. Pulls the cached LinearIssue out of the
 * store and triggers a fetch on mount so the title backfills automatically.
 *
 * Why a dedicated row component: keeps the per-identifier subscription
 * scoped to one row at a time — adding/removing a single linked ticket
 * doesn't re-render the rest of the GroupCard.
 *
 * Why fetch by identifier (e.g. "ENG-123") rather than UUID: the persisted
 * `linkedLinearIssue` field stores the human-readable identifier (see
 * launch-work-item-direct.ts) and the Linear SDK's `client.issue(id)` accepts
 * both UUIDs and identifiers. Eventually we should normalize cache keys, but
 * the worst case today is a duplicate cache entry for the same issue.
 */
const GroupLinearIssueRow = React.memo(function GroupLinearIssueRow({
  identifier
}: GroupLinearIssueRowProps): React.JSX.Element {
  const fetchLinearIssue = useAppStore((s) => s.fetchLinearIssue)
  // Why: focused selector — only re-renders this row when its specific cache
  // entry changes, not on every unrelated linearIssueCache write.
  const cached = useAppStore((s) => s.linearIssueCache[identifier]?.data)

  useEffect(() => {
    // Why: best-effort hydrate. The store dedupes inflight requests so
    // multiple rows for the same identifier (e.g. group + member both linked
    // to the same ticket — deduped by the parent before reaching here) only
    // result in one IPC call.
    void fetchLinearIssue(identifier)
  }, [fetchLinearIssue, identifier])

  const issue: LinearIssue | null | undefined = cached
  return (
    <LinearIssueSection
      identifier={issue?.identifier ?? identifier}
      title={issue?.title}
      url={issue?.url ?? null}
      stateColor={issue?.state?.color ?? null}
      stateName={issue?.state?.name ?? null}
    />
  )
})

export default GroupCard
