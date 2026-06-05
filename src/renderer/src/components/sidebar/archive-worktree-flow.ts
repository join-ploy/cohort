import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { getWorktreeMapFromState } from '@/store/selectors'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { getDeleteWorktreeToastCopy } from './delete-worktree-toast'
import { runSleepWorktrees } from './sleep-worktree-flow'
import { ARCHIVE_TTL_MS } from '../../../../shared/archive-constants'
import type { Worktree } from '../../../../shared/types'

// Why: derive the toast's countdown from the shared TTL so it never drifts from
// the cleanup service / Archived view when the retention window changes.
const ARCHIVE_TTL_DAYS = Math.round(ARCHIVE_TTL_MS / (24 * 60 * 60 * 1000))

// Why: a failed delete almost always means the worktree still has changes
// that need attention. The "View" affordance surfaces those changes directly
// by switching to the source-control tab so the user lands on the diff panel
// where the blocking work is visible.
function viewWorktreeDiff(worktreeId: string): void {
  activateAndRevealWorktree(worktreeId)
  const state = useAppStore.getState()
  state.setRightSidebarTab('source-control')
  state.setRightSidebarOpen(true)
}

/**
 * Hard-delete-with-toast helper retained for the Archived view's
 * "Delete now" path (Phase 6). Centralizes the error toast copy, the
 * "Force Delete" action wiring, and the "View" affordance so the
 * confirm-modal and the future Archived-view callers behave identically.
 */
export function runWorktreeDeleteWithToast(worktreeId: string, worktreeName: string): void {
  const removeWorktree = useAppStore.getState().removeWorktree

  removeWorktree(worktreeId, false)
    .then((result) => {
      if (result.ok) {
        return
      }
      const state = useAppStore.getState().deleteStateByWorktreeId[worktreeId]
      const canForceDelete = state?.canForceDelete ?? false
      const toastCopy = getDeleteWorktreeToastCopy(worktreeName, canForceDelete, result.error)
      const showToast = toastCopy.isDestructive ? toast.error : toast.info
      showToast(toastCopy.title, {
        description: toastCopy.description,
        duration: 10000,
        cancel: {
          label: 'View',
          onClick: () => viewWorktreeDiff(worktreeId)
        },
        action: canForceDelete
          ? {
              label: 'Force Delete',
              onClick: () => {
                useAppStore
                  .getState()
                  .removeWorktree(worktreeId, true)
                  .then((forceResult) => {
                    if (!forceResult.ok) {
                      toast.error('Force delete failed', {
                        description: forceResult.error,
                        action: {
                          label: 'View',
                          onClick: () => viewWorktreeDiff(worktreeId)
                        }
                      })
                    }
                  })
                  .catch((err: unknown) => {
                    toast.error('Failed to delete worktree', {
                      description: err instanceof Error ? err.message : String(err),
                      action: {
                        label: 'View',
                        onClick: () => viewWorktreeDiff(worktreeId)
                      }
                    })
                  })
              }
            }
          : undefined
      })
    })
    .catch((err: unknown) => {
      toast.error('Failed to delete worktree', {
        description: err instanceof Error ? err.message : String(err)
      })
    })
}

/**
 * Soft-delete entrypoint shared by the sidebar context menu and the resource
 * popover. The archive flow has no confirm step — instead the user gets a
 * 10-second undo window in the toast itself. The real removal runs from the
 * main-process cleanup service once the archive TTL elapses.
 *
 * Why this is a module helper rather than a store action: the toast/undo UX
 * is intrinsically UI-shaped and depends on sonner; keeping it in the
 * renderer layer mirrors the previous delete flow and avoids leaking toast
 * concerns into the store slice.
 *
 * The main-worktree / missing-record guard is defense-in-depth — callers are
 * responsible for disabling UI when this is known ahead of time, but we
 * still refuse to act if the record disappeared between render and click.
 */
export function runWorktreeArchive(worktreeId: string): void {
  const state = useAppStore.getState()
  const target = getWorktreeMapFromState(state).get(worktreeId) ?? null
  if (!target || target.isMainWorktree) {
    return
  }

  const displayName = target.displayName

  // Why: archive shouldn't leave PTYs (or webviews) running for a worktree
  // the user has set aside. Reuse the sleep flow so the active pane unmounts
  // cleanly (setActiveWorktree(null)) before meta flips, and so undo/restore
  // can re-spawn against the same on-disk history dir / relay session ids.
  runSleepWorktrees([worktreeId])
    .then(() => useAppStore.getState().archiveWorktree(worktreeId))
    .then(() => {
      toast.info(
        `Archived '${displayName}' — will be deleted in ${ARCHIVE_TTL_DAYS} day${ARCHIVE_TTL_DAYS === 1 ? '' : 's'}`,
        {
          duration: 10000,
          action: {
            label: 'Undo',
            onClick: () => {
              useAppStore
                .getState()
                .restoreWorktree(worktreeId)
                .catch((err: unknown) => {
                  toast.error('Failed to restore worktree', {
                    description: err instanceof Error ? err.message : String(err)
                  })
                })
            }
          }
        }
      )
    })
    .catch((err: unknown) => {
      toast.error('Failed to archive worktree', {
        description: err instanceof Error ? err.message : String(err)
      })
    })
}

export function runWorktreeBatchArchive(worktreeIds: readonly string[]): void {
  const state = useAppStore.getState()
  const worktreeMap = getWorktreeMapFromState(state)
  const targets = worktreeIds
    .map((id) => worktreeMap.get(id) ?? null)
    .filter((worktree): worktree is Worktree => worktree != null && !worktree.isMainWorktree)

  if (targets.length === 0) {
    return
  }

  for (const target of targets) {
    runWorktreeArchive(target.id)
  }
}
