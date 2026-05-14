import { createStore, type StoreApi } from 'zustand/vanilla'
import { describe, expect, it } from 'vitest'
import { createScriptsSlice, type ScriptsSlice } from './scripts'

// Why: this slice is self-contained — it does not read other slice state,
// so the test store provides only the scripts surface. Mirrors the isolated
// pattern used in worktree-nav-history.test.ts for the same reason.
function createScriptsStore(): StoreApi<ScriptsSlice> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((set, get, api) => ({
    ...createScriptsSlice(
      set as Parameters<typeof createScriptsSlice>[0],
      get as Parameters<typeof createScriptsSlice>[1],
      api as Parameters<typeof createScriptsSlice>[2]
    )
  })) as unknown as StoreApi<ScriptsSlice>
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
})
