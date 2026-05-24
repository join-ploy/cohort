import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runWorktreeBatchArchive: vi.fn(),
  runGroupArchive: vi.fn(),
  archiveGroupDisplayNames: new Map<string, string>()
}))

vi.mock('./archive-worktree-flow', () => ({
  runWorktreeBatchArchive: mocks.runWorktreeBatchArchive
}))

vi.mock('./archive-group-flow', () => ({
  runGroupArchive: mocks.runGroupArchive
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      workspaceGroups: Array.from(mocks.archiveGroupDisplayNames.entries()).map(([id, name]) => ({
        id,
        displayName: name
      }))
    })
  }
}))

import { runBatchSelectionArchive } from './archive-selection-flow'

describe('runBatchSelectionArchive', () => {
  beforeEach(() => {
    mocks.runWorktreeBatchArchive.mockReset()
    mocks.runGroupArchive.mockReset()
    mocks.archiveGroupDisplayNames.clear()
  })

  it('dispatches worktree archive for plain worktree ids', () => {
    runBatchSelectionArchive(new Set(['repoA::/wt1', 'repoB::/wt2']))

    expect(mocks.runWorktreeBatchArchive).toHaveBeenCalledWith(['repoA::/wt1', 'repoB::/wt2'])
    expect(mocks.runGroupArchive).not.toHaveBeenCalled()
  })

  it('dispatches group archive for each group id in the selection', () => {
    mocks.archiveGroupDisplayNames.set('group:abc', 'daring_tiger')
    mocks.archiveGroupDisplayNames.set('group:def', 'wise_panther')

    runBatchSelectionArchive(new Set(['group:abc', 'group:def']))

    expect(mocks.runGroupArchive).toHaveBeenCalledWith('group:abc', 'daring_tiger')
    expect(mocks.runGroupArchive).toHaveBeenCalledWith('group:def', 'wise_panther')
    expect(mocks.runWorktreeBatchArchive).not.toHaveBeenCalled()
  })

  it('dispatches both flows when the selection mixes groups and worktrees', () => {
    mocks.archiveGroupDisplayNames.set('group:abc', 'daring_tiger')

    runBatchSelectionArchive(new Set(['group:abc', 'repoA::/wt1']))

    expect(mocks.runGroupArchive).toHaveBeenCalledWith('group:abc', 'daring_tiger')
    expect(mocks.runWorktreeBatchArchive).toHaveBeenCalledWith(['repoA::/wt1'])
  })

  it('falls back to the group id as the display name when the group is missing', () => {
    // Why: defensive — the renderer's workspaceGroups cache may briefly miss
    // a freshly archived group during a refetch; we'd rather surface a toast
    // labeled with the id than skip the archive call entirely.
    runBatchSelectionArchive(new Set(['group:abc']))

    expect(mocks.runGroupArchive).toHaveBeenCalledWith('group:abc', 'group:abc')
  })

  it('is a no-op on an empty selection', () => {
    runBatchSelectionArchive(new Set())

    expect(mocks.runWorktreeBatchArchive).not.toHaveBeenCalled()
    expect(mocks.runGroupArchive).not.toHaveBeenCalled()
  })
})
