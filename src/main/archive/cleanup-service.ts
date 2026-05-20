import { ARCHIVE_CLEANUP_INTERVAL_MS, ARCHIVE_TTL_MS } from '../../shared/archive-constants'
import type { Store } from '../persistence'

export type CleanupServiceDeps = {
  store: Store
  // Why: injected so tests can avoid the real worktree-removal pipeline; the
  // production wiring passes a thunk that calls runWorktreeRemoval.
  runRemoval: (worktreeId: string) => Promise<void>
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
