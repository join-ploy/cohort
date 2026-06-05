import { ARCHIVE_CLEANUP_INTERVAL_MS, ARCHIVE_TTL_MS } from '../../shared/archive-constants'
import type { Store } from '../persistence'

export type CleanupServiceDeps = {
  store: Store
  // Why: injected so tests can avoid the real worktree-removal pipeline; the
  // production wiring passes a thunk that calls runWorktreeRemoval.
  runRemoval: (worktreeId: string) => Promise<void>
  // Why: archived workspace-group RECORDS aren't worktree meta, so they need
  // their own teardown (remove members + group folder + record). Without this,
  // archived groups linger in the Archived view forever past their TTL.
  runGroupRemoval: (groupId: string) => Promise<void>
  intervalMs?: number
  ttlMs?: number
  now?: () => number
}

export type CleanupService = {
  runOnce: () => Promise<void>
  start: () => void
  stop: () => void
}

export function createCleanupService(deps: CleanupServiceDeps): CleanupService {
  const ttl = deps.ttlMs ?? ARCHIVE_TTL_MS
  const interval = deps.intervalMs ?? ARCHIVE_CLEANUP_INTERVAL_MS
  const now = deps.now ?? Date.now
  let timer: ReturnType<typeof setInterval> | null = null

  async function runOnce(): Promise<void> {
    const allMeta = deps.store.getAllWorktreeMeta()
    const threshold = now() - ttl
    const candidates: string[] = []
    for (const [worktreeId, meta] of Object.entries(allMeta)) {
      if (!meta.isArchived) {
        continue
      }
      if (typeof meta.archivedAt !== 'number') {
        continue
      }
      if (meta.archivedAt > threshold) {
        continue
      }
      candidates.push(worktreeId)
    }
    for (const id of candidates) {
      try {
        await deps.runRemoval(id)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // Why: stay archived and keep archivedAt set so the next tick still
        // considers this worktree past TTL and retries on its own.
        deps.store.setWorktreeMeta(id, { archiveCleanupError: message })
      }
    }

    // Why: workspace-group records are pruned separately from worktree meta.
    // Run AFTER the worktree loop so a group's member worktrees (which carry
    // their own archived meta) are already removed by the time the group
    // teardown runs — leaving the group folder empty and the record safe to drop.
    const groupCandidates: string[] = []
    for (const group of deps.store.getWorkspaceGroups()) {
      if (!group.isArchived) {
        continue
      }
      if (typeof group.archivedAt !== 'number') {
        continue
      }
      if (group.archivedAt > threshold) {
        continue
      }
      groupCandidates.push(group.id)
    }
    for (const id of groupCandidates) {
      try {
        await deps.runGroupRemoval(id)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // Why: keep the group archived (mirrors the worktree path) so the next
        // tick retries; surface the reason on the record for the Archived view's
        // "Cleanup blocked" badge.
        const group = deps.store.getWorkspaceGroups().find((g) => g.id === id)
        if (group) {
          deps.store.setWorkspaceGroup({ ...group, archiveCleanupError: message })
        }
      }
    }
  }

  function start(): void {
    if (timer) {
      return
    }
    timer = setInterval(() => {
      runOnce().catch((err) => {
        console.error('[archive-cleanup] tick failed:', err)
      })
    }, interval)
    // Why: also fire immediately on startup so a user who quit Orca for weeks
    // sees expired worktrees cleaned up without waiting a full interval.
    runOnce().catch((err) => {
      console.error('[archive-cleanup] startup tick failed:', err)
    })
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return { runOnce, start, stop }
}
