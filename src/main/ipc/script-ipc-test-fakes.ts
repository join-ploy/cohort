// Why: shared test fakes for the run-script and setup-script IPC tests so
// each test file stays under the 300-line lint cap. Production code does not
// import this module — only the *.test.ts files do.

import { vi } from 'vitest'
import type { Repo } from '../../shared/types'

type ExitListener = (payload: { id: string; code: number }) => void

export type FakeProvider = {
  spawn: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
  fireExit: (payload: { id: string; code: number }) => void
}

export function makeProvider(opts?: { spawnIds?: string[] }): FakeProvider {
  const exitListeners = new Set<ExitListener>()
  const ids = opts?.spawnIds ? [...opts.spawnIds] : []
  let counter = 0
  const spawn = vi.fn(async () => {
    const id = ids.length > 0 ? (ids.shift() as string) : `pty-${++counter}`
    return { id }
  })
  const shutdown = vi.fn(async () => {})
  const onExit = vi.fn((cb: ExitListener) => {
    exitListeners.add(cb)
    return () => exitListeners.delete(cb)
  })
  return {
    spawn,
    shutdown,
    onExit,
    fireExit: (payload) => {
      // Snapshot to allow listeners to unsubscribe themselves during iteration.
      const snapshot = Array.from(exitListeners)
      for (const listener of snapshot) {
        listener(payload)
      }
    }
  }
}

export function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/test/repo',
    displayName: 'Test Repo',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  } as Repo
}

export function makeSingleRepoStore(repo: Repo | null) {
  return {
    getRepo: vi.fn(() => repo ?? undefined),
    getWorktreeMeta: vi.fn(() => ({ workspaceName: 'wise_panther' }))
  }
}

export function makeMultiRepoStore(repos: Repo[]) {
  const map = new Map(repos.map((r) => [r.id, r] as const))
  return {
    getRepo: vi.fn((id: string) => map.get(id)),
    // Why: setup-script handler reads workspaceName via getWorktreeMeta to
    // forward CONDUCTOR_WORKSPACE_NAME into the wrapper. Provide a stable
    // value across all worktrees so existing tests don't have to seed
    // per-worktree meta.
    getWorktreeMeta: vi.fn(() => ({ workspaceName: 'wise_panther' }))
  }
}

export function makeWindow() {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }
}
