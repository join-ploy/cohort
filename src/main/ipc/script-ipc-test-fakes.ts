// Why: shared test fakes for the run-script and setup-script IPC tests so
// each test file stays under the 300-line lint cap. Production code does not
// import this module — only the *.test.ts files do.

import { vi } from 'vitest'
import type { Repo } from '../../shared/types'
import { LocalPtyProvider } from '../providers/local-pty-provider'

type ExitListener = (payload: { id: string; code: number }) => void

export type FakeProvider = {
  spawn: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
  fireExit: (payload: { id: string; code: number }) => void
  markPtyExemptFromOrphanKill: ReturnType<typeof vi.fn>
  unmarkPtyExemptFromOrphanKill: ReturnType<typeof vi.fn>
}

export function makeProvider(opts?: {
  spawnIds?: string[]
  /** Default true: fake masquerades as LocalPtyProvider so handlers'
   *  `provider instanceof LocalPtyProvider` orphan-exempt branch runs.
   *  Set false for SSH-style fakes. */
  asLocal?: boolean
}): FakeProvider {
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
  // Why: handlers gate their orphan-exempt calls on `provider instanceof
  // LocalPtyProvider`. Re-parent the fake onto LocalPtyProvider.prototype so
  // the runtime check passes without spinning up node-pty or its native side.
  // SSH-style providers opt out via asLocal:false so their tests still mirror
  // production (the SSH provider never sees mark/unmark calls).
  const asLocal = opts?.asLocal ?? true
  const fake = (asLocal ? Object.create(LocalPtyProvider.prototype) : {}) as FakeProvider
  Object.assign(fake, {
    spawn,
    shutdown,
    onExit,
    markPtyExemptFromOrphanKill: vi.fn(),
    unmarkPtyExemptFromOrphanKill: vi.fn(),
    fireExit: (payload: { id: string; code: number }) => {
      // Snapshot to allow listeners to unsubscribe themselves during iteration.
      const snapshot = Array.from(exitListeners)
      for (const listener of snapshot) {
        listener(payload)
      }
    }
  })
  return fake
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
    getWorktreeMeta: vi.fn(() => ({ workspaceName: 'wise_panther' })),
    // Why: setup/run handlers look up the enclosing group to emit
    // CONDUCTOR_WORKSPACE_REPOS. Default to no groups so single-repo
    // tests stay focused on the non-grouped behavior.
    getWorkspaceGroups: vi.fn(() => [])
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
    getWorktreeMeta: vi.fn(() => ({ workspaceName: 'wise_panther' })),
    // Why: same default as makeSingleRepoStore — handlers call
    // getWorkspaceGroups() to derive CONDUCTOR_WORKSPACE_REPOS. Empty list
    // keeps every existing assertion shape unchanged.
    getWorkspaceGroups: vi.fn(() => [])
  }
}

// Why: the explicit return type (mirroring FakeProvider's `ReturnType<typeof
// vi.fn>` above) is required because `composite: true` turns on declaration
// emit, and an inferred return type containing `vi.fn()` references @vitest/spy
// internals that can't be named portably (TS2883).
export function makeWindow(): {
  isDestroyed: () => boolean
  webContents: { send: ReturnType<typeof vi.fn> }
} {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }
}
