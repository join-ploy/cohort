import React, { useMemo, useState } from 'react'
import { ChevronDown, FolderTree, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { useWorkspaceGroups } from '@/store/selectors'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { ARCHIVE_TTL_MS } from '../../../../shared/archive-constants'
import type { WorkspaceGroup, Worktree } from '../../../../shared/types'
import { getArchivedWorktrees } from './visible-worktrees'

const MS_PER_DAY = 24 * 60 * 60 * 1000

// Pure so it's trivially testable and avoids re-render-time clock skew issues.
function daysRemaining(archivedAt: number, now: number): number {
  const remaining = archivedAt + ARCHIVE_TTL_MS - now
  return Math.max(0, Math.ceil(remaining / MS_PER_DAY))
}

// Why: worktree rows and group rows share the same list and sort key, but
// have different action surfaces. A discriminated union keeps the render
// logic narrow without leaking nullable fields between the two shapes.
type ArchivedRow =
  | { kind: 'worktree'; archivedAt: number; worktree: Worktree }
  | { kind: 'group'; archivedAt: number; group: WorkspaceGroup }

export function ArchivedSection(): React.JSX.Element | null {
  const archived = useAppStore(useShallow(getArchivedWorktrees))
  const restoreWorktree = useAppStore((s) => s.restoreWorktree)
  const openModal = useAppStore((s) => s.openModal)
  const workspaceGroups = useWorkspaceGroups()
  const [open, setOpen] = useState(false)

  // Why: sort newest-first so the most recently archived item — what the user
  // is most likely to want to restore or delete — is at the top. Worktrees
  // and groups share the same ordering so they interleave by archive time.
  const sorted = useMemo<ArchivedRow[]>(() => {
    const rows: ArchivedRow[] = archived.map((wt) => ({
      kind: 'worktree' as const,
      archivedAt: wt.archivedAt ?? 0,
      worktree: wt
    }))
    for (const g of workspaceGroups) {
      if (g.isArchived) {
        rows.push({ kind: 'group', archivedAt: g.archivedAt ?? 0, group: g })
      }
    }
    return rows.sort((a, b) => b.archivedAt - a.archivedAt)
  }, [archived, workspaceGroups])

  if (sorted.length === 0) {
    return null
  }

  const handleRestore = (worktreeId: string): void => {
    restoreWorktree(worktreeId).catch((err: unknown) => {
      toast.error('Failed to restore worktree', {
        description: err instanceof Error ? err.message : String(err)
      })
    })
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-t border-sidebar-border">
      <CollapsibleTrigger
        className={cn(
          'group flex h-8 w-full items-center justify-between gap-2 px-3 py-1 outline-none',
          'text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80',
          'hover:text-foreground select-none',
          'focus-visible:ring-2 focus-visible:ring-ring/50'
        )}
      >
        <span>Archived ({sorted.length})</span>
        <ChevronDown
          className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180"
          strokeWidth={2.25}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden">
        <ul className="flex flex-col gap-px pb-1">
          {sorted.map((row) => {
            if (row.kind === 'group') {
              const g = row.group
              const days = g.archivedAt != null ? daysRemaining(g.archivedAt, Date.now()) : 0
              const hasError = g.archiveCleanupError != null && g.archiveCleanupError !== ''
              return (
                <li
                  key={g.id}
                  data-testid="archived-group-row"
                  className="flex items-center justify-between gap-2 rounded-md px-3 py-1.5 hover:bg-sidebar-accent"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-1.5">
                      {/* Why: icon distinguishes group rows from worktree rows
                          at a glance without changing row height. */}
                      <FolderTree
                        className="size-3.5 shrink-0 text-muted-foreground"
                        strokeWidth={2}
                        aria-hidden
                      />
                      <span
                        data-testid="archived-group-name"
                        className="truncate text-[13px] text-sidebar-foreground"
                      >
                        {g.displayName}
                      </span>
                      <Badge
                        variant="secondary"
                        className="shrink-0 text-[9px] uppercase tracking-wider"
                      >
                        Group
                      </Badge>
                    </span>
                    {hasError ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge
                            variant="destructive"
                            className="w-fit text-[10px] uppercase tracking-wider"
                          >
                            Cleanup blocked
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent side="top" sideOffset={4}>
                          {g.archiveCleanupError}
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">{days} days left</span>
                    )}
                  </div>
                </li>
              )
            }

            const wt = row.worktree
            const days = wt.archivedAt != null ? daysRemaining(wt.archivedAt, Date.now()) : 0
            const hasError = wt.archiveCleanupError != null && wt.archiveCleanupError !== ''
            return (
              <li
                key={wt.id}
                className="flex items-center justify-between gap-2 rounded-md px-3 py-1.5 hover:bg-sidebar-accent"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span
                    data-testid="archived-worktree-name"
                    className="truncate text-[13px] text-sidebar-foreground"
                  >
                    {wt.displayName}
                  </span>
                  {hasError ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge
                          variant="destructive"
                          className="w-fit text-[10px] uppercase tracking-wider"
                        >
                          Cleanup blocked
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent side="top" sideOffset={4}>
                        {wt.archiveCleanupError}
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">{days} days left</span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Restore"
                        onClick={() => handleRestore(wt.id)}
                      >
                        <RotateCcw />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={4}>
                      Restore
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Delete now"
                        // Why: deletion is the destructive path — paint the icon
                        // alone so the row chrome stays quiet, but signal intent
                        // on hover.
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => openModal('delete-worktree', { worktreeId: wt.id })}
                      >
                        <Trash2 />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={4}>
                      Delete now
                    </TooltipContent>
                  </Tooltip>
                </div>
              </li>
            )
          })}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}
