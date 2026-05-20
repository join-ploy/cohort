import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ARCHIVE_TTL_MS } from '../../shared/archive-constants'
import type { Store } from '../persistence'

// Why: persistence.ts reads electron.app.getPath() at module load. Mirror the
// pattern from persistence.test.ts so the Store can be constructed in tests
// without a real Electron runtime.
const testState = { dir: '' }

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    }
  }
}))

vi.mock('../git/repo', () => ({
  getGitUsername: vi.fn().mockReturnValue('testuser')
}))

async function createStore(): Promise<Store> {
  vi.resetModules()
  const { Store, initDataPath } = await import('../persistence')
  initDataPath()
  return new Store()
}

async function loadCleanupService() {
  // Why: dynamic import so module-level state (and the electron mock above) is
  // wired before createCleanupService closes over its deps.
  return await import('./cleanup-service')
}

describe('archive cleanup service', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-archive-cleanup-test-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('selects only archived worktrees past the TTL', async () => {
    const store = await createStore()
    const { createCleanupService } = await loadCleanupService()
    const oldId = 'repo1::/path/old'
    const youngId = 'repo1::/path/young'
    const liveId = 'repo1::/path/live'
    const now = Date.now()
    store.setWorktreeMeta(oldId, {
      isArchived: true,
      archivedAt: now - ARCHIVE_TTL_MS - 1000
    })
    store.setWorktreeMeta(youngId, { isArchived: true, archivedAt: now })
    store.setWorktreeMeta(liveId, { isArchived: false, archivedAt: null })

    const removed: string[] = []
    const service = createCleanupService({
      store,
      runRemoval: async (id) => {
        removed.push(id)
      }
    })

    await service.runOnce()

    expect(removed).toEqual([oldId])
  })

  it('records archiveCleanupError and leaves the worktree archived when removal throws', async () => {
    const store = await createStore()
    const { createCleanupService } = await loadCleanupService()
    const id = 'repo1::/path/blocked'
    const archivedAt = Date.now() - ARCHIVE_TTL_MS - 1000
    store.setWorktreeMeta(id, {
      isArchived: true,
      archivedAt
    })

    const service = createCleanupService({
      store,
      runRemoval: async () => {
        throw new Error('worktree has uncommitted changes')
      }
    })

    await service.runOnce()

    const meta = store.getWorktreeMeta(id)
    expect(meta?.isArchived).toBe(true)
    expect(meta?.archivedAt).toBe(archivedAt)
    expect(meta?.archiveCleanupError).toContain('uncommitted changes')
  })

  it('retries blocked worktrees on the next tick', async () => {
    const store = await createStore()
    const { createCleanupService } = await loadCleanupService()
    const id = 'repo1::/path/blocked'
    store.setWorktreeMeta(id, {
      isArchived: true,
      archivedAt: Date.now() - ARCHIVE_TTL_MS - 1000,
      archiveCleanupError: 'previous error'
    })

    let calls = 0
    const service = createCleanupService({
      store,
      runRemoval: async (toRemove) => {
        calls++
        if (calls === 1) {
          throw new Error('still blocked')
        }
        // Why: mimic the real pipeline — successful removal drops the meta.
        store.removeWorktreeMeta(toRemove)
      }
    })

    await service.runOnce()
    expect(calls).toBe(1)
    await service.runOnce()
    expect(calls).toBe(2)
    expect(store.getWorktreeMeta(id)).toBeUndefined()
  })

  it('removes meta on successful run when runRemoval mimics the real pipeline', async () => {
    const store = await createStore()
    const { createCleanupService } = await loadCleanupService()
    const id = 'repo1::/path/ok'
    store.setWorktreeMeta(id, {
      isArchived: true,
      archivedAt: Date.now() - ARCHIVE_TTL_MS - 1000,
      archiveCleanupError: 'old error'
    })

    const service = createCleanupService({
      store,
      runRemoval: async (toRemove) => {
        store.removeWorktreeMeta(toRemove)
      }
    })

    await service.runOnce()
    expect(store.getWorktreeMeta(id)).toBeUndefined()
  })
})
