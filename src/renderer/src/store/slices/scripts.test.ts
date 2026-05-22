import { createStore, type StoreApi } from 'zustand/vanilla'
import { describe, expect, it, vi } from 'vitest'
import { createScriptsSlice, type GroupRunDeps, type ScriptsSlice } from './scripts'
import type { WorkspaceGroup, Worktree } from '../../../../shared/types'

// Why: most of this slice's actions are self-contained, but startGroupRun /
// stopGroupRun read workspace-groups + worktreesByRepo via the cross-slice
// selectors. The store-shape stub stays narrow — only the keys those
// selectors touch — so unrelated slices don't have to be wired up.
type ScriptsStoreShape = ScriptsSlice & {
  workspaceGroups: WorkspaceGroup[]
  worktreesByRepo: Record<string, Worktree[]>
}

function createScriptsStore(
  seed: { workspaceGroups?: WorkspaceGroup[]; worktreesByRepo?: Record<string, Worktree[]> } = {}
): StoreApi<ScriptsStoreShape> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((set, get, api) => ({
    workspaceGroups: seed.workspaceGroups ?? [],
    worktreesByRepo: seed.worktreesByRepo ?? {},
    ...createScriptsSlice(
      set as Parameters<typeof createScriptsSlice>[0],
      get as Parameters<typeof createScriptsSlice>[1],
      api as Parameters<typeof createScriptsSlice>[2]
    )
  })) as unknown as StoreApi<ScriptsStoreShape>
}

// Why: cast through `unknown` keeps the test fixtures minimal — we only need
// the fields the cross-slice selectors read (id, repoId, memberWorktreeIds);
// other slice tests use the same shortcut to avoid mirroring the full
// persisted shape inside the test file.
function makeWorktree(id: string, repoId: string): Worktree {
  return { id, repoId, path: `/tmp/${id}`, branch: `refs/heads/${id}` } as unknown as Worktree
}

function makeGroup(id: string, memberIds: string[]): WorkspaceGroup {
  return { id, memberWorktreeIds: memberIds } as unknown as WorkspaceGroup
}

describe('scripts slice', () => {
  it('starts with an empty scriptsByWorktree map', () => {
    const store = createScriptsStore()
    expect(store.getState().scriptsByWorktree).toEqual({})
  })

  it('handleRunStarted sets running state with ptyId and a startedAt timestamp', () => {
    const store = createScriptsStore()
    const before = Date.now()
    store.getState().handleRunStarted({ worktreeId: 'wt-1', ptyId: 'p-1' })
    const state = store.getState().scriptsByWorktree['wt-1'].run
    expect(state.status).toBe('running')
    expect(state.ptyId).toBe('p-1')
    expect(state.exitCode).toBeNull()
    expect(state.startedAt).not.toBeNull()
    expect(state.startedAt!).toBeGreaterThanOrEqual(before)
  })

  it('initializes the worktree entry with an idle setup state on first run event', () => {
    const store = createScriptsStore()
    store.getState().handleRunStarted({ worktreeId: 'wt-1', ptyId: 'p-1' })
    const setup = store.getState().scriptsByWorktree['wt-1'].setup
    expect(setup.status).toBe('idle')
    expect(setup.ptyId).toBeNull()
    expect(setup.exitCode).toBeNull()
    expect(setup.startedAt).toBeNull()
  })

  it('handleRunExited(0) flips status to exited-success and records exitCode', () => {
    const store = createScriptsStore()
    store.getState().handleRunStarted({ worktreeId: 'wt-1', ptyId: 'p-1' })
    store.getState().handleRunExited({ worktreeId: 'wt-1', code: 0 })
    const state = store.getState().scriptsByWorktree['wt-1'].run
    expect(state.status).toBe('exited-success')
    expect(state.exitCode).toBe(0)
  })

  it('handleRunExited(non-zero) flips status to exited-failure', () => {
    const store = createScriptsStore()
    store.getState().handleRunStarted({ worktreeId: 'wt-1', ptyId: 'p-1' })
    store.getState().handleRunExited({ worktreeId: 'wt-1', code: 137 })
    const state = store.getState().scriptsByWorktree['wt-1'].run
    expect(state.status).toBe('exited-failure')
    expect(state.exitCode).toBe(137)
  })

  it('re-running replaces ptyId and refreshes startedAt while status stays running', async () => {
    const store = createScriptsStore()
    store.getState().handleRunStarted({ worktreeId: 'wt-1', ptyId: 'p-1' })
    const firstStartedAt = store.getState().scriptsByWorktree['wt-1'].run.startedAt!
    // Why: Date.now() resolution can collapse two same-tick events to the
    // same millisecond, so wait one ms before the second start to assert the
    // refresh actually moved forward rather than relying on coincidence.
    await new Promise((resolve) => setTimeout(resolve, 2))
    store.getState().handleRunStarted({ worktreeId: 'wt-1', ptyId: 'p-2' })
    const state = store.getState().scriptsByWorktree['wt-1'].run
    expect(state.status).toBe('running')
    expect(state.ptyId).toBe('p-2')
    expect(state.startedAt!).toBeGreaterThan(firstStartedAt)
    // Re-run should clear the prior exitCode so stale data doesn't leak.
    expect(state.exitCode).toBeNull()
  })

  it('supports the full run lifecycle including a re-run after exit', () => {
    const store = createScriptsStore()
    store.getState().handleRunStarted({ worktreeId: 'wt-1', ptyId: 'p-1' })
    store.getState().handleRunExited({ worktreeId: 'wt-1', code: 0 })
    expect(store.getState().scriptsByWorktree['wt-1'].run.status).toBe('exited-success')

    store.getState().handleRunStarted({ worktreeId: 'wt-1', ptyId: 'p-2' })
    expect(store.getState().scriptsByWorktree['wt-1'].run.status).toBe('running')
    expect(store.getState().scriptsByWorktree['wt-1'].run.ptyId).toBe('p-2')

    store.getState().handleRunExited({ worktreeId: 'wt-1', code: 1 })
    expect(store.getState().scriptsByWorktree['wt-1'].run.status).toBe('exited-failure')
    expect(store.getState().scriptsByWorktree['wt-1'].run.exitCode).toBe(1)
  })

  it('handleSetupStarted / handleSetupExited mirror run behavior on the setup channel', () => {
    const store = createScriptsStore()
    store.getState().handleSetupStarted({ worktreeId: 'wt-1', ptyId: 's-1' })
    const running = store.getState().scriptsByWorktree['wt-1'].setup
    expect(running.status).toBe('running')
    expect(running.ptyId).toBe('s-1')

    store.getState().handleSetupExited({ worktreeId: 'wt-1', code: 0 })
    expect(store.getState().scriptsByWorktree['wt-1'].setup.status).toBe('exited-success')
    expect(store.getState().scriptsByWorktree['wt-1'].setup.exitCode).toBe(0)

    store.getState().handleSetupExited({ worktreeId: 'wt-1', code: 2 })
    expect(store.getState().scriptsByWorktree['wt-1'].setup.status).toBe('exited-failure')
    expect(store.getState().scriptsByWorktree['wt-1'].setup.exitCode).toBe(2)
  })

  it('keeps run and setup channels independent within the same worktree', () => {
    const store = createScriptsStore()
    store.getState().handleRunStarted({ worktreeId: 'wt-1', ptyId: 'p-1' })
    store.getState().handleSetupStarted({ worktreeId: 'wt-1', ptyId: 's-1' })

    store.getState().handleRunExited({ worktreeId: 'wt-1', code: 0 })

    const entry = store.getState().scriptsByWorktree['wt-1']
    expect(entry.run.status).toBe('exited-success')
    expect(entry.setup.status).toBe('running')
    expect(entry.setup.ptyId).toBe('s-1')
  })

  it('keeps run state for two worktrees independent of each other', () => {
    const store = createScriptsStore()
    store.getState().handleRunStarted({ worktreeId: 'wt-1', ptyId: 'p-1' })
    store.getState().handleRunStarted({ worktreeId: 'wt-2', ptyId: 'p-2' })
    store.getState().handleRunExited({ worktreeId: 'wt-1', code: 1 })

    expect(store.getState().scriptsByWorktree['wt-1'].run.status).toBe('exited-failure')
    expect(store.getState().scriptsByWorktree['wt-2'].run.status).toBe('running')
    expect(store.getState().scriptsByWorktree['wt-2'].run.ptyId).toBe('p-2')
  })

  it('handleRunExited on an unseen worktree creates a fresh entry with the exit status', () => {
    const store = createScriptsStore()
    // Why: orphan exit events should be tolerated — they should not crash the
    // slice or silently no-op. The entry is created so downstream consumers
    // can still read a coherent status.
    store.getState().handleRunExited({ worktreeId: 'wt-orphan', code: 0 })
    const entry = store.getState().scriptsByWorktree['wt-orphan']
    expect(entry.run.status).toBe('exited-success')
    expect(entry.run.exitCode).toBe(0)
    expect(entry.setup.status).toBe('idle')
  })

  it('handleSetupExited on an unseen worktree creates a fresh entry with the exit status', () => {
    const store = createScriptsStore()
    store.getState().handleSetupExited({ worktreeId: 'wt-orphan', code: 5 })
    const entry = store.getState().scriptsByWorktree['wt-orphan']
    expect(entry.setup.status).toBe('exited-failure')
    expect(entry.setup.exitCode).toBe(5)
    expect(entry.run.status).toBe('idle')
  })

  describe('worktreeIdsAwaitingSetupAutoSwitch', () => {
    it('starts empty', () => {
      const store = createScriptsStore()
      expect(store.getState().worktreeIdsAwaitingSetupAutoSwitch.size).toBe(0)
    })

    it('mark adds the worktree id to the awaiting set', () => {
      const store = createScriptsStore()
      store.getState().markWorktreeForSetupAutoSwitch('wt-1')
      expect(store.getState().worktreeIdsAwaitingSetupAutoSwitch.has('wt-1')).toBe(true)
    })

    it('clear removes the worktree id from the awaiting set', () => {
      const store = createScriptsStore()
      store.getState().markWorktreeForSetupAutoSwitch('wt-1')
      store.getState().clearWorktreeSetupAutoSwitch('wt-1')
      expect(store.getState().worktreeIdsAwaitingSetupAutoSwitch.has('wt-1')).toBe(false)
    })

    it('mark on an already-marked id is a no-op that does not mint a new Set', () => {
      const store = createScriptsStore()
      store.getState().markWorktreeForSetupAutoSwitch('wt-1')
      const firstSet = store.getState().worktreeIdsAwaitingSetupAutoSwitch
      store.getState().markWorktreeForSetupAutoSwitch('wt-1')
      // Why: the no-op path skips set() so subscribers don't re-render on
      // every composer keystroke when the same worktree id is re-marked.
      expect(store.getState().worktreeIdsAwaitingSetupAutoSwitch).toBe(firstSet)
    })

    it('clear on an unmarked id is a no-op that does not mint a new Set', () => {
      const store = createScriptsStore()
      const firstSet = store.getState().worktreeIdsAwaitingSetupAutoSwitch
      store.getState().clearWorktreeSetupAutoSwitch('wt-ghost')
      expect(store.getState().worktreeIdsAwaitingSetupAutoSwitch).toBe(firstSet)
    })

    it('tracks multiple worktree ids independently', () => {
      const store = createScriptsStore()
      store.getState().markWorktreeForSetupAutoSwitch('wt-1')
      store.getState().markWorktreeForSetupAutoSwitch('wt-2')
      store.getState().clearWorktreeSetupAutoSwitch('wt-1')
      const awaiting = store.getState().worktreeIdsAwaitingSetupAutoSwitch
      expect(awaiting.has('wt-1')).toBe(false)
      expect(awaiting.has('wt-2')).toBe(true)
    })
  })

  describe('startGroupRun / stopGroupRun', () => {
    function seededGroupStore(memberIds: string[]) {
      const worktrees: Worktree[] = memberIds.map((id, i) => makeWorktree(id, `repo-${i + 1}`))
      const worktreesByRepo: Record<string, Worktree[]> = {}
      for (const wt of worktrees) {
        worktreesByRepo[wt.repoId] = [wt]
      }
      const group = makeGroup('group-1', memberIds)
      return createScriptsStore({ workspaceGroups: [group], worktreesByRepo })
    }

    it('startGroupRun fans out start to every member in the group', async () => {
      const store = seededGroupStore(['wt-1', 'wt-2', 'wt-3'])
      const deps: GroupRunDeps = {
        start: vi.fn().mockResolvedValue({ ok: true, ptyId: 'p' }),
        stop: vi.fn().mockResolvedValue({ ok: true })
      }
      await store.getState().startGroupRun('group-1', deps)
      expect(deps.start).toHaveBeenCalledTimes(3)
      // Each member's repoId + worktreeId pair gets forwarded.
      expect(deps.start).toHaveBeenCalledWith({ repoId: 'repo-1', worktreeId: 'wt-1' })
      expect(deps.start).toHaveBeenCalledWith({ repoId: 'repo-2', worktreeId: 'wt-2' })
      expect(deps.start).toHaveBeenCalledWith({ repoId: 'repo-3', worktreeId: 'wt-3' })
    })

    it('startGroupRun stops any already-running member before starting', async () => {
      const store = seededGroupStore(['wt-1', 'wt-2'])
      // Why: simulate wt-1 already running — startGroupRun must pre-stop it
      // so the new spawn replaces the live PTY instead of orphaning it.
      store.getState().handleRunStarted({ worktreeId: 'wt-1', ptyId: 'p-old' })
      const deps: GroupRunDeps = {
        start: vi.fn().mockResolvedValue({ ok: true, ptyId: 'p-new' }),
        stop: vi.fn().mockResolvedValue({ ok: true })
      }
      await store.getState().startGroupRun('group-1', deps)
      expect(deps.stop).toHaveBeenCalledTimes(1)
      expect(deps.stop).toHaveBeenCalledWith({ repoId: 'repo-1' })
      // Every member gets a start, including the one we pre-stopped.
      expect(deps.start).toHaveBeenCalledTimes(2)
    })

    it('startGroupRun returns the per-member RunStartResults in order', async () => {
      const store = seededGroupStore(['wt-1', 'wt-2'])
      const deps: GroupRunDeps = {
        start: vi
          .fn()
          .mockResolvedValueOnce({ ok: true, ptyId: 'p-1' })
          .mockResolvedValueOnce({ ok: false, reason: 'spawn-failed' as const }),
        stop: vi.fn().mockResolvedValue({ ok: true })
      }
      const results = await store.getState().startGroupRun('group-1', deps)
      expect(results).toHaveLength(2)
      expect(results[0]).toEqual({ ok: true, ptyId: 'p-1' })
      expect(results[1]).toEqual({ ok: false, reason: 'spawn-failed' })
    })

    it('stopGroupRun stops only members with a running PTY', async () => {
      const store = seededGroupStore(['wt-1', 'wt-2', 'wt-3'])
      // wt-1: running, wt-2: idle (never started), wt-3: exited
      store.getState().handleRunStarted({ worktreeId: 'wt-1', ptyId: 'p-1' })
      store.getState().handleRunStarted({ worktreeId: 'wt-3', ptyId: 'p-3' })
      store.getState().handleRunExited({ worktreeId: 'wt-3', code: 0 })
      const deps: GroupRunDeps = {
        start: vi.fn().mockResolvedValue({ ok: true, ptyId: 'p' }),
        stop: vi.fn().mockResolvedValue({ ok: true })
      }
      await store.getState().stopGroupRun('group-1', deps)
      expect(deps.stop).toHaveBeenCalledTimes(1)
      expect(deps.stop).toHaveBeenCalledWith({ repoId: 'repo-1' })
    })

    it('startGroupRun / stopGroupRun on an unknown group resolve to empty', async () => {
      const store = createScriptsStore()
      const deps: GroupRunDeps = {
        start: vi.fn(),
        stop: vi.fn()
      }
      const startResults = await store.getState().startGroupRun('group-missing', deps)
      const stopResults = await store.getState().stopGroupRun('group-missing', deps)
      expect(startResults).toEqual([])
      expect(stopResults).toEqual([])
      expect(deps.start).not.toHaveBeenCalled()
      expect(deps.stop).not.toHaveBeenCalled()
    })
  })
})
