import { describe, expect, it, vi } from 'vitest'
import { triggerRunShortcut } from './trigger-run-shortcut'
import type { TriggerRunShortcutDeps } from './trigger-run-shortcut'
import type { RunStartResult } from '../../../shared/script-types'

type StoreShape = {
  activeWorktreeId: string | null
  rightSidebarOpen: boolean
  setRightSidebarOpen: ReturnType<typeof vi.fn>
  setRightSidebarTab: ReturnType<typeof vi.fn>
  repos: { id: string; displayName?: string }[]
  worktreesByRepo: Record<string, { id: string; repoId: string }[]>
}

function makeStore(overrides: Partial<StoreShape> = {}): StoreShape {
  return {
    activeWorktreeId: 'wt-1',
    rightSidebarOpen: false,
    setRightSidebarOpen: vi.fn(),
    setRightSidebarTab: vi.fn(),
    repos: [{ id: 'repo-1', displayName: 'Repo One' }],
    worktreesByRepo: {
      'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }]
    },
    ...overrides
  }
}

function makeDeps(args: {
  store: StoreShape
  start: ReturnType<typeof vi.fn>
}): TriggerRunShortcutDeps {
  return {
    store: { getState: () => args.store },
    start: args.start,
    toast: {
      message: vi.fn(),
      error: vi.fn()
    }
  }
}

describe('triggerRunShortcut', () => {
  it('opens the right sidebar, switches to Run tab, and calls runScript.start', async () => {
    const store = makeStore()
    const start = vi.fn().mockResolvedValue({ ok: true, ptyId: 'p-1' } satisfies RunStartResult)
    const deps = makeDeps({ store, start })

    await triggerRunShortcut(deps)

    expect(store.setRightSidebarOpen).toHaveBeenCalledWith(true)
    expect(store.setRightSidebarTab).toHaveBeenCalledWith('run')
    expect(start).toHaveBeenCalledWith({ repoId: 'repo-1', worktreeId: 'wt-1' })
  })

  it('does not re-open the sidebar when it is already open', async () => {
    const store = makeStore({ rightSidebarOpen: true })
    const start = vi.fn().mockResolvedValue({ ok: true, ptyId: 'p-1' } satisfies RunStartResult)

    await triggerRunShortcut(makeDeps({ store, start }))

    expect(store.setRightSidebarOpen).not.toHaveBeenCalled()
    expect(store.setRightSidebarTab).toHaveBeenCalledWith('run')
  })

  it('is a silent no-op when no active worktree is set', async () => {
    const store = makeStore({ activeWorktreeId: null })
    const start = vi.fn()

    await triggerRunShortcut(makeDeps({ store, start }))

    expect(start).not.toHaveBeenCalled()
    expect(store.setRightSidebarOpen).not.toHaveBeenCalled()
    expect(store.setRightSidebarTab).not.toHaveBeenCalled()
  })

  it('is a silent no-op when the active worktree id has no matching worktree', async () => {
    const store = makeStore({ activeWorktreeId: 'wt-missing' })
    const start = vi.fn()

    await triggerRunShortcut(makeDeps({ store, start }))

    expect(start).not.toHaveBeenCalled()
    expect(store.setRightSidebarOpen).not.toHaveBeenCalled()
  })

  it('toasts a message — not an error — when the repo has no run script configured', async () => {
    const store = makeStore()
    const start = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: 'no-run-script' } satisfies RunStartResult)
    const deps = makeDeps({ store, start })

    await triggerRunShortcut(deps)

    expect(deps.toast.message).toHaveBeenCalledWith('No run script configured for Repo One')
    expect(deps.toast.error).not.toHaveBeenCalled()
  })

  it('falls back to the repo id when displayName is missing in the no-run-script toast', async () => {
    const store = makeStore({ repos: [{ id: 'repo-1' }] })
    const start = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: 'no-run-script' } satisfies RunStartResult)
    const deps = makeDeps({ store, start })

    await triggerRunShortcut(deps)

    expect(deps.toast.message).toHaveBeenCalledWith('No run script configured for repo-1')
  })

  it('toasts an error for non-no-run-script failure reasons', async () => {
    const store = makeStore()
    const start = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: 'spawn-failed' } satisfies RunStartResult)
    const deps = makeDeps({ store, start })

    await triggerRunShortcut(deps)

    expect(deps.toast.error).toHaveBeenCalledWith('Could not start run script: spawn-failed')
    expect(deps.toast.message).not.toHaveBeenCalled()
  })

  it('still opens the Run tab even when start eventually fails', async () => {
    // Why: design rule — sidebar opens unconditionally so the user always
    // sees the Run panel context after pressing the shortcut, even on failure.
    const store = makeStore()
    const start = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: 'spawn-failed' } satisfies RunStartResult)

    await triggerRunShortcut(makeDeps({ store, start }))

    expect(store.setRightSidebarOpen).toHaveBeenCalledWith(true)
    expect(store.setRightSidebarTab).toHaveBeenCalledWith('run')
  })
})
