import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    worktreeMap: new Map<string, { id: string; displayName: string; isMainWorktree: boolean }>(),
    archiveWorktree: vi.fn().mockResolvedValue(undefined),
    restoreWorktree: vi.fn().mockResolvedValue(undefined)
  }
  const runSleepWorktrees = vi.fn().mockResolvedValue(undefined)
  return { state, runSleepWorktrees }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.state
  }
}))

vi.mock('@/store/selectors', () => ({
  getWorktreeMapFromState: () => mocks.state.worktreeMap
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn()
  }
}))

vi.mock('./sleep-worktree-flow', () => ({
  runSleepWorktrees: mocks.runSleepWorktrees,
  runSleepWorktree: vi.fn().mockResolvedValue(undefined)
}))

import { toast } from 'sonner'
import { runWorktreeArchive, runWorktreeBatchArchive } from './archive-worktree-flow'

function setWorktrees(
  worktrees: { id: string; displayName?: string; isMainWorktree?: boolean }[]
): void {
  mocks.state.worktreeMap = new Map(
    worktrees.map((worktree) => [
      worktree.id,
      {
        id: worktree.id,
        displayName: worktree.displayName ?? worktree.id,
        isMainWorktree: worktree.isMainWorktree ?? false
      }
    ])
  )
}

async function flushMicrotasks(): Promise<void> {
  // Why: the flow chains sleep -> archive -> toast across multiple promise
  // hops; drain enough microtasks for the deepest chain to settle before
  // assertions.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('runWorktreeArchive', () => {
  beforeEach(() => {
    mocks.state.archiveWorktree.mockClear().mockResolvedValue(undefined)
    mocks.state.restoreWorktree.mockClear().mockResolvedValue(undefined)
    mocks.runSleepWorktrees.mockClear().mockResolvedValue(undefined)
    vi.mocked(toast.info).mockClear()
    vi.mocked(toast.error).mockClear()
    setWorktrees([])
  })

  it('closes terminals (sleeps) before flipping the archive flag', async () => {
    setWorktrees([{ id: 'wt-1', displayName: 'My Worktree' }])
    const order: string[] = []
    mocks.runSleepWorktrees.mockImplementationOnce(async () => {
      order.push('sleep')
    })
    mocks.state.archiveWorktree.mockImplementationOnce(async () => {
      order.push('archive')
    })

    runWorktreeArchive('wt-1')
    await flushMicrotasks()

    expect(mocks.runSleepWorktrees).toHaveBeenCalledWith(['wt-1'])
    expect(order).toEqual(['sleep', 'archive'])
  })

  it('calls archive, shows toast with undo action that restores', async () => {
    setWorktrees([{ id: 'wt-1', displayName: 'My Worktree' }])

    runWorktreeArchive('wt-1')
    await flushMicrotasks()

    expect(mocks.state.archiveWorktree).toHaveBeenCalledWith('wt-1')
    expect(toast.info).toHaveBeenCalledWith(
      "Archived 'My Worktree' — will be deleted in 30 days",
      expect.objectContaining({
        duration: 10000,
        action: expect.objectContaining({ label: 'Undo' })
      })
    )

    const infoCall = vi.mocked(toast.info).mock.calls[0]
    const options = infoCall[1] as unknown as { action: { onClick: () => void } }
    options.action.onClick()
    expect(mocks.state.restoreWorktree).toHaveBeenCalledWith('wt-1')
  })

  it('no-ops for main worktree', () => {
    setWorktrees([{ id: 'wt-main', isMainWorktree: true }])

    runWorktreeArchive('wt-main')

    expect(mocks.state.archiveWorktree).not.toHaveBeenCalled()
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('surfaces destructive toast on archive failure', async () => {
    setWorktrees([{ id: 'wt-1', displayName: 'My Worktree' }])
    mocks.state.archiveWorktree.mockRejectedValueOnce(new Error('IPC down'))

    runWorktreeArchive('wt-1')
    await flushMicrotasks()

    expect(toast.error).toHaveBeenCalledWith(
      'Failed to archive worktree',
      expect.objectContaining({ description: 'IPC down' })
    )
    expect(toast.info).not.toHaveBeenCalled()
  })
})

describe('runWorktreeBatchArchive', () => {
  beforeEach(() => {
    mocks.state.archiveWorktree.mockClear().mockResolvedValue(undefined)
    mocks.state.restoreWorktree.mockClear().mockResolvedValue(undefined)
    mocks.runSleepWorktrees.mockClear().mockResolvedValue(undefined)
    vi.mocked(toast.info).mockClear()
    vi.mocked(toast.error).mockClear()
    setWorktrees([])
  })

  it('filters main worktrees and archives the rest', async () => {
    setWorktrees([{ id: 'main', isMainWorktree: true }, { id: 'wt-1' }, { id: 'wt-2' }])

    runWorktreeBatchArchive(['main', 'wt-1', 'wt-2'])
    await flushMicrotasks()

    expect(mocks.state.archiveWorktree).toHaveBeenCalledWith('wt-1')
    expect(mocks.state.archiveWorktree).toHaveBeenCalledWith('wt-2')
    expect(mocks.state.archiveWorktree).not.toHaveBeenCalledWith('main')
  })

  it('no-ops when no eligible targets', () => {
    setWorktrees([{ id: 'main', isMainWorktree: true }])

    runWorktreeBatchArchive(['main'])

    expect(mocks.state.archiveWorktree).not.toHaveBeenCalled()
  })
})
