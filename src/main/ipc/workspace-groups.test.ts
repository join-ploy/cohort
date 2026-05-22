import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, removeHandlerMock, mkdirSyncMock, rmSyncMock, runWorktreeRemovalMock } =
  vi.hoisted(() => ({
    handleMock: vi.fn(),
    removeHandlerMock: vi.fn(),
    mkdirSyncMock: vi.fn(),
    rmSyncMock: vi.fn(),
    runWorktreeRemovalMock: vi.fn()
  }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
    removeHandler: removeHandlerMock
  }
}))

vi.mock('fs', () => ({
  mkdirSync: mkdirSyncMock,
  rmSync: rmSyncMock
}))

vi.mock('./worktree-remote', () => ({
  createLocalWorktree: vi.fn(),
  createRemoteWorktree: vi.fn()
}))

vi.mock('../worktree-removal/run-worktree-removal', () => ({
  runWorktreeRemoval: runWorktreeRemovalMock
}))

import { createLocalWorktree, createRemoteWorktree } from './worktree-remote'
import { registerWorkspaceGroupHandlers } from './workspace-groups'
import type {
  CreateWorkspaceGroupArgs,
  CreateWorkspaceGroupResult,
  Repo,
  Worktree
} from '../../shared/types'

type Handler = (
  _event: unknown,
  args: CreateWorkspaceGroupArgs
) => Promise<CreateWorkspaceGroupResult>

function buildRepo(id: string, path: string): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: '#000',
    addedAt: 0
  }
}

function buildWorktree(repoId: string, worktreePath: string, workspaceName: string): Worktree {
  return {
    id: `${repoId}::${worktreePath}`,
    repoId,
    displayName: workspaceName,
    workspaceName,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    archivedAt: null,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    path: worktreePath,
    head: 'deadbeef',
    branch: workspaceName,
    isBare: false,
    isMainWorktree: false
  }
}

describe('registerWorkspaceGroupHandlers — workspace-groups:create', () => {
  const mainWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  } as never
  const runtime = {} as never
  const handlers: Record<string, Handler> = {}

  // Why: Store is exercised through a narrow surface, so a hand-rolled stub
  // captures the calls we want to assert without dragging in real persistence.
  const store = {
    getRepo: vi.fn(),
    getSettings: vi.fn(),
    setWorktreeMeta: vi.fn(),
    setWorkspaceGroup: vi.fn(),
    getWorkspaceGroups: vi.fn()
  }

  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    mkdirSyncMock.mockReset()
    rmSyncMock.mockReset()
    runWorktreeRemovalMock.mockReset()
    runWorktreeRemovalMock.mockResolvedValue(undefined)
    store.getRepo.mockReset()
    store.getSettings.mockReset()
    store.setWorktreeMeta.mockReset()
    store.setWorkspaceGroup.mockReset()
    store.getWorkspaceGroups.mockReset()
    vi.mocked(createLocalWorktree).mockReset()
    vi.mocked(createRemoteWorktree).mockReset()
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }

    handleMock.mockImplementation((channel: string, handler: Handler) => {
      handlers[channel] = handler
    })

    store.getSettings.mockReturnValue({ workspaceDir: '/workspace' })
    store.setWorkspaceGroup.mockImplementation((group) => group)
    store.setWorktreeMeta.mockReturnValue({})
    store.getWorkspaceGroups.mockReturnValue([])
  })

  it('creates members in parallel and persists the group with stamped memberWorktreeIds', async () => {
    const repoA = buildRepo('repo-a', '/workspace/repo-a')
    const repoB = buildRepo('repo-b', '/workspace/repo-b')
    store.getRepo.mockImplementation((id: string) => (id === 'repo-a' ? repoA : repoB))

    const worktreeA = buildWorktree('repo-a', '/workspace/daring_tiger/repo-a', 'daring_tiger')
    const worktreeB = buildWorktree('repo-b', '/workspace/daring_tiger/repo-b', 'daring_tiger')
    vi.mocked(createLocalWorktree).mockImplementation(async (args) => ({
      worktree: args.repoId === 'repo-a' ? worktreeA : worktreeB
    }))

    registerWorkspaceGroupHandlers(mainWindow, store as never, runtime)
    const handler = handlers['workspace-groups:create']
    expect(handler).toBeDefined()

    const result = await handler(
      {},
      {
        workspaceName: 'daring_tiger',
        branchName: 'daring_tiger',
        members: [
          { repoId: 'repo-a', baseRef: 'origin/main', setupDecision: 'inherit' },
          { repoId: 'repo-b', baseRef: null, setupDecision: 'skip' }
        ]
      }
    )

    // 1. Group shape — id namespace, workspace + branch names, ordered members.
    expect(result.group.id).toMatch(/^group:[0-9a-f-]{36}$/)
    expect(result.group.workspaceName).toBe('daring_tiger')
    expect(result.group.branchName).toBe('daring_tiger')
    expect(result.group.parentPath).toBe('/workspace/daring_tiger')
    expect(result.group.memberWorktreeIds).toEqual([worktreeA.id, worktreeB.id])

    // 2. createLocalWorktree was called once per member with the right path
    //    override and branch name (passed via workspaceName slug).
    expect(createLocalWorktree).toHaveBeenCalledTimes(2)
    expect(createRemoteWorktree).not.toHaveBeenCalled()
    const calls = vi.mocked(createLocalWorktree).mock.calls
    const callForRepoA = calls.find(([args]) => args.repoId === 'repo-a')
    const callForRepoB = calls.find(([args]) => args.repoId === 'repo-b')
    expect(callForRepoA?.[0]).toMatchObject({
      repoId: 'repo-a',
      workspaceName: 'daring_tiger',
      baseBranch: 'origin/main',
      setupDecision: 'inherit',
      pathOverride: '/workspace/daring_tiger/repo-a'
    })
    expect(callForRepoB?.[0]).toMatchObject({
      repoId: 'repo-b',
      workspaceName: 'daring_tiger',
      setupDecision: 'skip',
      pathOverride: '/workspace/daring_tiger/repo-b'
    })
    // baseRef=null on the spec means "let the per-worktree default apply".
    expect(callForRepoB?.[0].baseBranch).toBeUndefined()

    // 3. The group was persisted exactly once.
    expect(store.setWorkspaceGroup).toHaveBeenCalledTimes(1)
    expect(store.setWorkspaceGroup).toHaveBeenCalledWith(result.group)

    // 4. Each member got `groupId` stamped on its meta.
    expect(store.setWorktreeMeta).toHaveBeenCalledTimes(2)
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(worktreeA.id, {
      groupId: result.group.id
    })
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(worktreeB.id, {
      groupId: result.group.id
    })

    // 5. Result carries both created worktrees in member order.
    expect(result.memberWorktrees).toEqual([worktreeA, worktreeB])

    // Parent folder created once, recursive.
    expect(mkdirSyncMock).toHaveBeenCalledWith('/workspace/daring_tiger', {
      recursive: true
    })
  })

  it('rolls back the parent folder and any successful members when a member create fails', async () => {
    const repoA = buildRepo('repo-a', '/workspace/repo-a')
    const repoB = buildRepo('repo-b', '/workspace/repo-b')
    store.getRepo.mockImplementation((id: string) => (id === 'repo-a' ? repoA : repoB))

    const worktreeA = buildWorktree('repo-a', '/workspace/daring_tiger/repo-a', 'daring_tiger')
    const failure = new Error('boom: clone refused for repo-b')
    vi.mocked(createLocalWorktree).mockImplementation(async (args) => {
      if (args.repoId === 'repo-a') {
        return { worktree: worktreeA }
      }
      throw failure
    })

    registerWorkspaceGroupHandlers(mainWindow, store as never, runtime)
    const handler = handlers['workspace-groups:create']
    expect(handler).toBeDefined()

    await expect(
      handler(
        {},
        {
          workspaceName: 'daring_tiger',
          branchName: 'daring_tiger',
          members: [
            { repoId: 'repo-a', baseRef: 'origin/main', setupDecision: 'inherit' },
            { repoId: 'repo-b', baseRef: null, setupDecision: 'skip' }
          ]
        }
      )
    ).rejects.toThrowError(/repo-b|boom: clone refused/)

    // Group must NOT be persisted on partial failure.
    expect(store.setWorkspaceGroup).not.toHaveBeenCalled()
    // No groupId stamping on member meta either — that runs after the group write.
    expect(store.setWorktreeMeta).not.toHaveBeenCalled()

    // The successfully-created member-1 worktree must be cleaned up via the
    // shared per-worktree removal primitive (which handles git worktree remove
    // + WorktreeMeta deletion).
    expect(runWorktreeRemovalMock).toHaveBeenCalledTimes(1)
    expect(runWorktreeRemovalMock).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: worktreeA.id, force: true }),
      expect.objectContaining({ store, runtime, mainWindow })
    )

    // Parent group folder removed recursively after member cleanup.
    expect(rmSyncMock).toHaveBeenCalledWith('/workspace/daring_tiger', {
      recursive: true,
      force: true
    })
  })
})
