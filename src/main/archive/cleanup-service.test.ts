import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ARCHIVE_TTL_MS } from '../../shared/archive-constants'
import type { Store } from '../persistence'
import type { WorkspaceGroup } from '../../shared/types'

function makeGroup(id: string, isArchived: boolean, archivedAt: number | null): WorkspaceGroup {
  return {
    id,
    workspaceName: id.replace('group:', ''),
    displayName: id,
    parentPath: `/tmp/${id}`,
    memberWorktreeIds: [],
    branchName: 'feat',
    isArchived,
    archivedAt,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    isUnread: false,
    comment: '',
    createdAt: 0,
    linkedIssue: null,
    linkedLinearIssue: null
  }
}

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
      runGroupRemoval: async () => {},
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
      runGroupRemoval: async () => {},
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
      runGroupRemoval: async () => {},
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
      runGroupRemoval: async () => {},
      runRemoval: async (toRemove) => {
        store.removeWorktreeMeta(toRemove)
      }
    })

    await service.runOnce()
    expect(store.getWorktreeMeta(id)).toBeUndefined()
  })

  it('selects only archived workspace groups past the TTL', async () => {
    const store = await createStore()
    const { createCleanupService } = await loadCleanupService()
    const now = Date.now()
    store.setWorkspaceGroup(makeGroup('group:old', true, now - ARCHIVE_TTL_MS - 1000))
    store.setWorkspaceGroup(makeGroup('group:young', true, now))
    store.setWorkspaceGroup(makeGroup('group:live', false, null))

    const removedGroups: string[] = []
    const service = createCleanupService({
      store,
      runRemoval: async () => {},
      runGroupRemoval: async (id) => {
        removedGroups.push(id)
      }
    })

    await service.runOnce()

    expect(removedGroups).toEqual(['group:old'])
  })

  it('records archiveCleanupError and leaves the group archived when group removal throws', async () => {
    const store = await createStore()
    const { createCleanupService } = await loadCleanupService()
    const archivedAt = Date.now() - ARCHIVE_TTL_MS - 1000
    store.setWorkspaceGroup(makeGroup('group:blocked', true, archivedAt))

    const service = createCleanupService({
      store,
      runRemoval: async () => {},
      runGroupRemoval: async () => {
        throw new Error('member has uncommitted changes')
      }
    })

    await service.runOnce()

    const group = store.getWorkspaceGroups().find((g) => g.id === 'group:blocked')
    expect(group?.isArchived).toBe(true)
    expect(group?.archivedAt).toBe(archivedAt)
    expect(group?.archiveCleanupError).toContain('uncommitted changes')
  })

  it('uses per-type TTLs from settings (worktree vs group)', async () => {
    const store = await createStore()
    const { createCleanupService } = await loadCleanupService()
    const now = Date.now()
    // Worktree TTL short (1h), group TTL long (1 week).
    store.updateSettings({
      archiveWorktreeTtlMs: 60 * 60 * 1000,
      archiveGroupTtlMs: 7 * 24 * 60 * 60 * 1000
    })
    const wtId = 'repo1::/path/wt'
    store.setWorktreeMeta(wtId, { isArchived: true, archivedAt: now - 2 * 60 * 60 * 1000 }) // 2h old > 1h
    store.setWorkspaceGroup(makeGroup('group:young', true, now - 2 * 60 * 60 * 1000)) // 2h old < 1 week

    const removed: string[] = []
    const removedGroups: string[] = []
    const service = createCleanupService({
      store,
      runRemoval: async (id) => {
        removed.push(id)
      },
      runGroupRemoval: async (id) => {
        removedGroups.push(id)
      }
    })

    await service.runOnce()

    expect(removed).toEqual([wtId])
    expect(removedGroups).toEqual([])
  })

  it('reads TTL settings live on each tick', async () => {
    const store = await createStore()
    const { createCleanupService } = await loadCleanupService()
    const now = Date.now()
    const wtId = 'repo1::/path/wt'
    store.setWorktreeMeta(wtId, { isArchived: true, archivedAt: now - 2 * 60 * 60 * 1000 }) // 2h old
    store.updateSettings({ archiveWorktreeTtlMs: 24 * 60 * 60 * 1000 }) // 1 day -> not expired

    const removed: string[] = []
    const service = createCleanupService({
      store,
      runGroupRemoval: async () => {},
      runRemoval: async (id) => {
        removed.push(id)
      }
    })

    await service.runOnce()
    expect(removed).toEqual([]) // within 1-day TTL

    store.updateSettings({ archiveWorktreeTtlMs: 60 * 60 * 1000 }) // now 1h -> expired
    await service.runOnce()
    expect(removed).toEqual([wtId])
  })

  it('ignoreTtl removes freshly-archived items regardless of duration', async () => {
    const store = await createStore()
    const { createCleanupService } = await loadCleanupService()
    const now = Date.now()
    const wtId = 'repo1::/path/fresh'
    store.setWorktreeMeta(wtId, { isArchived: true, archivedAt: now }) // just archived
    store.setWorkspaceGroup(makeGroup('group:fresh', true, now))

    const removed: string[] = []
    const removedGroups: string[] = []
    const service = createCleanupService({
      store,
      runRemoval: async (id) => {
        removed.push(id)
      },
      runGroupRemoval: async (id) => {
        removedGroups.push(id)
      }
    })

    await service.runOnce({ ignoreTtl: true })

    expect(removed).toEqual([wtId])
    expect(removedGroups).toEqual(['group:fresh'])
  })

  it('threads force through to the removal callbacks', async () => {
    const store = await createStore()
    const { createCleanupService } = await loadCleanupService()
    const now = Date.now()
    store.setWorktreeMeta('repo1::/path/wt', { isArchived: true, archivedAt: now })
    store.setWorkspaceGroup(makeGroup('group:g', true, now))

    const wtForce: (boolean | undefined)[] = []
    const groupForce: (boolean | undefined)[] = []
    const service = createCleanupService({
      store,
      runRemoval: async (_id, opts) => {
        wtForce.push(opts?.force)
      },
      runGroupRemoval: async (_id, opts) => {
        groupForce.push(opts?.force)
      }
    })

    await service.runOnce({ ignoreTtl: true, force: true })
    expect(wtForce).toEqual([true])
    expect(groupForce).toEqual([true])
  })

  it('passes force=false by default (ignoreTtl does not imply force)', async () => {
    const store = await createStore()
    const { createCleanupService } = await loadCleanupService()
    const now = Date.now()
    store.setWorktreeMeta('repo1::/path/wt', { isArchived: true, archivedAt: now })
    store.setWorkspaceGroup(makeGroup('group:g', true, now))

    const wtForce: (boolean | undefined)[] = []
    const groupForce: (boolean | undefined)[] = []
    const service = createCleanupService({
      store,
      runRemoval: async (_id, opts) => {
        wtForce.push(opts?.force)
      },
      runGroupRemoval: async (_id, opts) => {
        groupForce.push(opts?.force)
      }
    })

    await service.runOnce({ ignoreTtl: true })
    expect(wtForce).toEqual([false])
    expect(groupForce).toEqual([false])
  })

  it('serializes overlapping runs so an id is not removed twice', async () => {
    const store = await createStore()
    const { createCleanupService } = await loadCleanupService()
    const id = 'repo1::/path/wt'
    store.setWorktreeMeta(id, { isArchived: true, archivedAt: Date.now() })

    let calls = 0
    const service = createCleanupService({
      store,
      runGroupRemoval: async () => {},
      runRemoval: async (toRemove) => {
        calls++
        // Why: yield so a non-serialized second run could snapshot the same id
        // before this run drops its meta — the guard must prevent that.
        await Promise.resolve()
        store.removeWorktreeMeta(toRemove)
      }
    })

    // Fire two overlapping prune-all runs without awaiting the first.
    await Promise.all([service.runOnce({ ignoreTtl: true }), service.runOnce({ ignoreTtl: true })])

    expect(calls).toBe(1)
    expect(store.getWorktreeMeta(id)).toBeUndefined()
  })

  it('deps.ttlMs override wins over settings for both types', async () => {
    const store = await createStore()
    const { createCleanupService } = await loadCleanupService()
    const now = Date.now()
    // Settings say "never expire soon" (1 week) but the override forces 0ms.
    store.updateSettings({
      archiveWorktreeTtlMs: 7 * 24 * 60 * 60 * 1000,
      archiveGroupTtlMs: 7 * 24 * 60 * 60 * 1000
    })
    store.setWorktreeMeta('repo1::/path/wt', { isArchived: true, archivedAt: now - 1000 })
    store.setWorkspaceGroup(makeGroup('group:g', true, now - 1000))

    const removed: string[] = []
    const removedGroups: string[] = []
    const service = createCleanupService({
      store,
      ttlMs: 0,
      runRemoval: async (id) => {
        removed.push(id)
      },
      runGroupRemoval: async (id) => {
        removedGroups.push(id)
      }
    })

    await service.runOnce()
    expect(removed).toEqual(['repo1::/path/wt'])
    expect(removedGroups).toEqual(['group:g'])
  })
})
