import * as React from 'react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { buildMemberScopedRef } from '../../../../../shared/automation-member-scoped-ref'
import type { AutomationTarget } from '../../../../../shared/automations-types'
import type { Worktree, WorkspaceGroup } from '../../../../../shared/types'

export type WorktreePickerProps = {
  /** Single-target picker mode (legacy). When `target` is supplied, this is
   *  ignored — the picker pulls projectIds from the AutomationTarget. */
  projectId: string
  /** Grouped-workspaces extension (Phase L4). When `target.kind === 'group'`,
   *  the picker surfaces groups whose membership matches the target's
   *  projectIds AND each group's member worktrees, in addition to the
   *  standard per-project worktrees. */
  target?: AutomationTarget
  onSelect: (worktreeRef: string) => void
  /** When the consumer already has a chosen value, suppress the auto-prefill
   *  side-effect — otherwise re-mounting after a manual change would clobber
   *  it back to the (still-only) option. */
  currentValue?: string
  onCancel?: () => void
  className?: string
}

function stripBranchPrefix(branch: string): string {
  return branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch
}

/** Decides which projectIds the picker scopes its worktree listing to. For
 *  single targets, just `[projectId]`; for groups, the target's full list. */
function effectiveProjectIds(props: WorktreePickerProps): string[] {
  if (props.target?.kind === 'group') {
    return props.target.projectIds
  }
  if (props.target?.kind === 'single') {
    return [props.target.projectId]
  }
  return props.projectId ? [props.projectId] : []
}

/** Filter the user's workspace groups down to ones whose membership lives
 *  ENTIRELY inside `targetProjectIds`. Groups that mix in repos the
 *  automation doesn't address are hidden — selecting them would spawn a run
 *  against a repo the automation can't reach. */
function relevantGroups(
  groups: readonly WorkspaceGroup[],
  worktreesByRepo: Record<string, Worktree[]>,
  targetProjectIds: string[]
): WorkspaceGroup[] {
  if (targetProjectIds.length === 0) {
    return []
  }
  const allowed = new Set(targetProjectIds)
  // Build an index from worktreeId → repoId so we can check each group's
  // members against the allowed repo set.
  const worktreeToRepo = new Map<string, string>()
  for (const [repoId, list] of Object.entries(worktreesByRepo)) {
    for (const wt of list) {
      worktreeToRepo.set(wt.id, repoId)
    }
  }
  return groups.filter((g) => {
    if (g.memberWorktreeIds.length === 0) {
      return false
    }
    for (const id of g.memberWorktreeIds) {
      const repoId = worktreeToRepo.get(id)
      if (!repoId || !allowed.has(repoId)) {
        return false
      }
    }
    return true
  })
}

type PickerEntry =
  | { kind: 'group'; group: WorkspaceGroup }
  | { kind: 'member'; group: WorkspaceGroup; worktree: Worktree }
  | { kind: 'member-scoped'; group: WorkspaceGroup; worktree: Worktree }
  | { kind: 'worktree'; worktree: Worktree }

export function WorktreePicker(props: WorktreePickerProps): React.JSX.Element {
  const projectIds = effectiveProjectIds(props)
  const isGrouped = props.target?.kind === 'group'

  // Why: select the flat per-project worktree list AND the workspace-group
  // catalog in one read so we can render groups, member rows, and ungrouped
  // standalone worktrees from a single render pass.
  const { worktrees, groups, worktreesByRepo } = useAppStore((s) => {
    const byRepo = s.worktreesByRepo as Record<string, Worktree[]>
    const flat: Worktree[] = []
    for (const repoId of projectIds) {
      const list = byRepo[repoId]
      if (list) {
        flat.push(...list)
      }
    }
    return {
      worktrees: flat,
      groups: s.workspaceGroups as WorkspaceGroup[],
      worktreesByRepo: byRepo
    }
  })

  const groupEntries = React.useMemo(
    () => (isGrouped ? relevantGroups(groups, worktreesByRepo, projectIds) : []),
    [isGrouped, groups, worktreesByRepo, projectIds]
  )

  // Build a flat ordered list of entries: groups first (with a label), then
  // each group's members, then any standalone (non-group) worktrees. Member-
  // scoped variants are nested per-member so the user can pick either
  // "whole group" or "this repo within the group".
  const entries = React.useMemo<PickerEntry[]>(() => {
    const out: PickerEntry[] = []
    const grouped = new Set<string>()
    for (const g of groupEntries) {
      out.push({ kind: 'group', group: g })
      for (const memberId of g.memberWorktreeIds) {
        const wt = worktrees.find((w) => w.id === memberId)
        if (wt) {
          grouped.add(wt.id)
          out.push({ kind: 'member', group: g, worktree: wt })
          out.push({ kind: 'member-scoped', group: g, worktree: wt })
        }
      }
    }
    for (const wt of worktrees) {
      if (!grouped.has(wt.id)) {
        out.push({ kind: 'worktree', worktree: wt })
      }
    }
    return out
  }, [groupEntries, worktrees])

  // Why: prefill the only top-level selectable value on mount when nothing's
  // chosen yet — there's nothing else the user could meaningfully click.
  // A "top-level" candidate is either a standalone worktree or a whole group;
  // member rows + member-scoped rows are nested sub-options of a group (the
  // user is opting into a narrower scope), so they don't count toward the
  // "is there exactly one choice" decision. This treats a group as equivalent
  // to a single worktree for prefill purposes — matching how the rest of the
  // automation surface uses groups interchangeably with worktrees.
  // Guarded by a one-shot ref so a later worktree appearing or a remount
  // after a manual edit can't clobber the choice.
  const { onSelect, currentValue } = props
  const autoPrefilledRef = React.useRef(false)
  React.useEffect(() => {
    if (autoPrefilledRef.current) {
      return
    }
    if (currentValue && currentValue.length > 0) {
      return
    }
    const topLevel = entries.filter((e) => e.kind === 'group' || e.kind === 'worktree')
    if (topLevel.length !== 1) {
      return
    }
    autoPrefilledRef.current = true
    const only = topLevel[0]
    if (only.kind === 'group') {
      onSelect(only.group.id)
    } else {
      onSelect(only.worktree.id)
    }
  }, [entries, currentValue, onSelect])

  if (entries.length === 0) {
    return (
      <div className={cn('p-3 text-xs text-muted-foreground', props.className)}>
        No worktrees in this project.
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col gap-2', props.className)}>
      <ul className="flex flex-col divide-y divide-border rounded-md border border-input">
        {entries.map((entry) => {
          if (entry.kind === 'group') {
            return (
              <li key={`group-${entry.group.id}`}>
                <button
                  type="button"
                  data-group-id={entry.group.id}
                  onClick={() => props.onSelect(entry.group.id)}
                  className="flex w-full items-baseline gap-2 px-2 py-2 text-left text-xs hover:bg-accent"
                >
                  <span className="font-medium text-foreground">{entry.group.displayName}</span>
                  <span className="text-muted-foreground">{entry.group.branchName}</span>
                  <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    group
                  </span>
                </button>
              </li>
            )
          }
          if (entry.kind === 'member') {
            const branch = stripBranchPrefix(entry.worktree.branch ?? '')
            return (
              <li key={`member-${entry.worktree.id}`}>
                <button
                  type="button"
                  data-worktree-id={entry.worktree.id}
                  data-member-of-group={entry.group.id}
                  onClick={() => props.onSelect(entry.worktree.id)}
                  className="flex w-full items-baseline gap-2 px-2 py-2 pl-6 text-left text-xs hover:bg-accent"
                >
                  <span className="text-foreground">{entry.worktree.displayName}</span>
                  {branch ? <span className="text-muted-foreground">{branch}</span> : null}
                  <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
                    member
                  </span>
                </button>
              </li>
            )
          }
          if (entry.kind === 'member-scoped') {
            // Why: emit a wire-format member-scoped sentinel so the runner can
            // recognize "scoped to <repo> within <group>" and configure the
            // PTY spawn (CWD = member path, tab still group-controlled).
            const ref = buildMemberScopedRef(entry.group.id, entry.worktree.id)
            return (
              <li key={`scoped-${entry.worktree.id}`}>
                <button
                  type="button"
                  data-member-scoped-ref={ref}
                  onClick={() => props.onSelect(ref)}
                  className="flex w-full items-baseline gap-2 px-2 py-2 pl-10 text-left text-xs hover:bg-accent"
                >
                  <span className="text-muted-foreground">
                    Run in <span className="text-foreground">{entry.worktree.displayName}</span>{' '}
                    only (scoped)
                  </span>
                  <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
                    scoped
                  </span>
                </button>
              </li>
            )
          }
          // entry.kind === 'worktree' (non-group)
          const branch = stripBranchPrefix(entry.worktree.branch ?? '')
          return (
            <li key={entry.worktree.id}>
              <button
                type="button"
                data-worktree-id={entry.worktree.id}
                onClick={() => props.onSelect(entry.worktree.id)}
                className="flex w-full items-baseline gap-2 px-2 py-2 text-left text-xs hover:bg-accent"
              >
                <span className="font-medium text-foreground">{entry.worktree.displayName}</span>
                {branch ? <span className="text-muted-foreground">{branch}</span> : null}
              </button>
            </li>
          )
        })}
      </ul>
      {props.onCancel ? (
        <button
          type="button"
          onClick={props.onCancel}
          className="self-end text-xs text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      ) : null}
    </div>
  )
}
