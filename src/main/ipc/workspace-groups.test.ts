import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  removeHandlerMock,
  mkdirSyncMock,
  rmSyncMock,
  runWorktreeRemovalMock,
  addWorktreeForExistingBranchMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  rmSyncMock: vi.fn(),
  runWorktreeRemovalMock: vi.fn(),
  addWorktreeForExistingBranchMock: vi.fn()
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
  createRemoteWorktree: vi.fn(),
  // Why: createWorkspaceGroup broadcasts worktrees:changed per member after
  // successful create so the renderer's onChanged handler refetches each
  // affected repo's worktrees (and picks up the newly-stamped groupId).
  notifyWorktreesChanged: vi.fn()
}))

vi.mock('../worktree-removal/run-worktree-removal', () => ({
  runWorktreeRemoval: runWorktreeRemovalMock
}))

vi.mock('../git/worktree', () => ({
  addWorktreeForExistingBranch: addWorktreeForExistingBranchMock
}))

import { createLocalWorktree, createRemoteWorktree } from './worktree-remote'
import { registerWorkspaceGroupHandlers } from './workspace-groups'
import type {
  CreateWorkspaceGroupArgs,
  CreateWorkspaceGroupResult,
  Repo,
  WorkspaceGroup,
  Worktree
} from '../../shared/types'

type Handler = (
  _event: unknown,
  args: CreateWorkspaceGroupArgs
) => Promise<CreateWorkspaceGroupResult>

type AnyHandler = (_event: unknown, args: unknown) => Promise<unknown>

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
    getRepos: vi.fn(),
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
    store.getRepos.mockReset()
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
    store.getRepos.mockReturnValue([])
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

  it('rejects when fewer than 2 members', async () => {
    registerWorkspaceGroupHandlers(mainWindow, store as never, runtime)
    const handler = handlers['workspace-groups:create']

    await expect(
      handler(
        {},
        {
          workspaceName: 'daring_tiger',
          branchName: 'daring_tiger',
          members: [{ repoId: 'repo-a', baseRef: null, setupDecision: 'inherit' }]
        }
      )
    ).rejects.toThrowError(/at least 2 member repos/i)

    expect(createLocalWorktree).not.toHaveBeenCalled()
    expect(createRemoteWorktree).not.toHaveBeenCalled()
    expect(store.setWorkspaceGroup).not.toHaveBeenCalled()
    expect(mkdirSyncMock).not.toHaveBeenCalled()
  })

  it('rejects when members include duplicate repoIds', async () => {
    const repoA = buildRepo('repo-a', '/workspace/repo-a')
    store.getRepo.mockImplementation((id: string) => (id === 'repo-a' ? repoA : undefined))

    registerWorkspaceGroupHandlers(mainWindow, store as never, runtime)
    const handler = handlers['workspace-groups:create']

    await expect(
      handler(
        {},
        {
          workspaceName: 'daring_tiger',
          branchName: 'daring_tiger',
          members: [
            { repoId: 'repo-a', baseRef: null, setupDecision: 'inherit' },
            { repoId: 'repo-a', baseRef: null, setupDecision: 'inherit' }
          ]
        }
      )
    ).rejects.toThrowError(/repo-a.*(twice|once)|appear at most once/i)

    expect(createLocalWorktree).not.toHaveBeenCalled()
    expect(createRemoteWorktree).not.toHaveBeenCalled()
    expect(store.setWorkspaceGroup).not.toHaveBeenCalled()
    expect(mkdirSyncMock).not.toHaveBeenCalled()
  })

  it('rejects an unknown repoId', async () => {
    const repoA = buildRepo('repo-a', '/workspace/repo-a')
    store.getRepo.mockImplementation((id: string) => (id === 'repo-a' ? repoA : undefined))

    registerWorkspaceGroupHandlers(mainWindow, store as never, runtime)
    const handler = handlers['workspace-groups:create']

    await expect(
      handler(
        {},
        {
          workspaceName: 'daring_tiger',
          branchName: 'daring_tiger',
          members: [
            { repoId: 'repo-a', baseRef: null, setupDecision: 'inherit' },
            { repoId: 'repo-missing', baseRef: null, setupDecision: 'inherit' }
          ]
        }
      )
    ).rejects.toThrowError(/Repo not found: repo-missing/i)

    expect(createLocalWorktree).not.toHaveBeenCalled()
    expect(createRemoteWorktree).not.toHaveBeenCalled()
    expect(store.setWorkspaceGroup).not.toHaveBeenCalled()
    expect(mkdirSyncMock).not.toHaveBeenCalled()
  })

  it('rejects a name that collides with a repo folder', async () => {
    // Repo folder name is derived from basename(path); use `/workspace/orca`
    // so the folder name is `orca` regardless of `displayName`.
    const repoA = buildRepo('repo-a', '/workspace/orca')
    const repoB = buildRepo('repo-b', '/workspace/repo-b')
    store.getRepo.mockImplementation((id: string) => (id === 'repo-a' ? repoA : repoB))
    store.getRepos.mockReturnValue([repoA, repoB])

    registerWorkspaceGroupHandlers(mainWindow, store as never, runtime)
    const handler = handlers['workspace-groups:create']

    await expect(
      handler(
        {},
        {
          workspaceName: 'orca',
          branchName: 'orca',
          members: [
            { repoId: 'repo-a', baseRef: null, setupDecision: 'inherit' },
            { repoId: 'repo-b', baseRef: null, setupDecision: 'inherit' }
          ]
        }
      )
    ).rejects.toThrowError(/collides with an existing repo folder/i)

    expect(createLocalWorktree).not.toHaveBeenCalled()
    expect(createRemoteWorktree).not.toHaveBeenCalled()
    expect(store.setWorkspaceGroup).not.toHaveBeenCalled()
    expect(mkdirSyncMock).not.toHaveBeenCalled()
  })

  it('rejects a name that collides with an existing group', async () => {
    const repoA = buildRepo('repo-a', '/workspace/repo-a')
    const repoB = buildRepo('repo-b', '/workspace/repo-b')
    store.getRepo.mockImplementation((id: string) => (id === 'repo-a' ? repoA : repoB))
    store.getRepos.mockReturnValue([repoA, repoB])
    store.getWorkspaceGroups.mockReturnValue([
      {
        id: 'group:existing',
        workspaceName: 'cozy_leopard',
        displayName: 'cozy_leopard',
        parentPath: '/workspace/cozy_leopard',
        memberWorktreeIds: [],
        branchName: 'cozy_leopard',
        isArchived: false,
        archivedAt: null,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        isUnread: false,
        comment: '',
        createdAt: 0,
        linkedIssue: null,
        linkedLinearIssue: null
      }
    ])

    registerWorkspaceGroupHandlers(mainWindow, store as never, runtime)
    const handler = handlers['workspace-groups:create']

    await expect(
      handler(
        {},
        {
          workspaceName: 'cozy_leopard',
          branchName: 'cozy_leopard',
          members: [
            { repoId: 'repo-a', baseRef: null, setupDecision: 'inherit' },
            { repoId: 'repo-b', baseRef: null, setupDecision: 'inherit' }
          ]
        }
      )
    ).rejects.toThrowError(/collides with an existing group/i)

    expect(createLocalWorktree).not.toHaveBeenCalled()
    expect(createRemoteWorktree).not.toHaveBeenCalled()
    expect(store.setWorkspaceGroup).not.toHaveBeenCalled()
    expect(mkdirSyncMock).not.toHaveBeenCalled()
  })

  it('rejects mixed local and SSH members', async () => {
    const repoLocal: Repo = {
      ...buildRepo('repo-a', '/workspace/repo-a'),
      connectionId: null
    }
    const repoRemote: Repo = {
      ...buildRepo('repo-b', '/workspace/repo-b'),
      connectionId: 'ssh-host-1'
    }
    store.getRepo.mockImplementation((id: string) => (id === 'repo-a' ? repoLocal : repoRemote))
    store.getRepos.mockReturnValue([repoLocal, repoRemote])

    registerWorkspaceGroupHandlers(mainWindow, store as never, runtime)
    const handler = handlers['workspace-groups:create']

    await expect(
      handler(
        {},
        {
          workspaceName: 'daring_tiger',
          branchName: 'daring_tiger',
          members: [
            { repoId: 'repo-a', baseRef: null, setupDecision: 'inherit' },
            { repoId: 'repo-b', baseRef: null, setupDecision: 'inherit' }
          ]
        }
      )
    ).rejects.toThrowError(/cannot mix local and SSH repos/i)

    expect(createLocalWorktree).not.toHaveBeenCalled()
    expect(createRemoteWorktree).not.toHaveBeenCalled()
    expect(store.setWorkspaceGroup).not.toHaveBeenCalled()
    expect(mkdirSyncMock).not.toHaveBeenCalled()
  })
})

describe('registerWorkspaceGroupHandlers — workspace-groups:archive (soft)', () => {
  const mainWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  } as never
  const runtime = {} as never
  const handlers: Record<string, AnyHandler> = {}

  const store = {
    getRepo: vi.fn(),
    getRepos: vi.fn(),
    getSettings: vi.fn(),
    getWorktreeMeta: vi.fn(),
    setWorktreeMeta: vi.fn(),
    setWorkspaceGroup: vi.fn(),
    getWorkspaceGroups: vi.fn()
  }

  function makeGroup(overrides: Partial<WorkspaceGroup>): WorkspaceGroup {
    return {
      id: 'group:abc',
      workspaceName: 'daring_tiger',
      displayName: 'daring_tiger',
      parentPath: '/workspace/daring_tiger',
      memberWorktreeIds: ['repo-a::/workspace/daring_tiger/repo-a'],
      branchName: 'daring_tiger',
      isArchived: false,
      archivedAt: null,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      isUnread: false,
      comment: '',
      createdAt: 0,
      linkedIssue: null,
      linkedLinearIssue: null,
      ...overrides
    }
  }

  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    mkdirSyncMock.mockReset()
    rmSyncMock.mockReset()
    runWorktreeRemovalMock.mockReset()
    runWorktreeRemovalMock.mockResolvedValue(undefined)
    store.getRepo.mockReset()
    store.getRepos.mockReset()
    store.getSettings.mockReset()
    store.getWorktreeMeta.mockReset()
    store.setWorktreeMeta.mockReset()
    store.setWorkspaceGroup.mockReset()
    store.getWorkspaceGroups.mockReset()
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }

    handleMock.mockImplementation((channel: string, handler: AnyHandler) => {
      handlers[channel] = handler
    })

    store.setWorkspaceGroup.mockImplementation((group) => group)
    store.getRepos.mockReturnValue([])
  })

  it('soft-archives every member (flag-flip) and flips the group, without removing worktrees or the parent folder', async () => {
    const memberA = 'repo-a::/workspace/daring_tiger/repo-a'
    const memberB = 'repo-b::/workspace/daring_tiger/repo-b'
    const group = makeGroup({ memberWorktreeIds: [memberA, memberB] })
    store.getWorkspaceGroups.mockReturnValue([group])

    registerWorkspaceGroupHandlers(mainWindow, store as never, runtime)
    const handler = handlers['workspace-groups:archive']
    expect(handler).toBeDefined()

    const before = Date.now()
    const result = (await handler({}, { groupId: group.id })) as ReturnType<typeof makeGroup>
    const after = Date.now()

    // Soft archive is metadata-only: no worktree removal, no parent rmSync.
    expect(runWorktreeRemovalMock).not.toHaveBeenCalled()
    expect(rmSyncMock).not.toHaveBeenCalled()

    // Each member's meta is flipped to archived (dirs left on disk for TTL).
    expect(store.setWorktreeMeta).toHaveBeenCalledTimes(2)
    for (const id of [memberA, memberB]) {
      expect(store.setWorktreeMeta).toHaveBeenCalledWith(
        id,
        expect.objectContaining({ isArchived: true, archiveCleanupError: null })
      )
    }
    const memberArchivedAt = store.setWorktreeMeta.mock.calls[0][1].archivedAt as number
    expect(memberArchivedAt).toBeGreaterThanOrEqual(before)
    expect(memberArchivedAt).toBeLessThanOrEqual(after)

    // Group flipped to archived once, cleanup error cleared.
    expect(store.setWorkspaceGroup).toHaveBeenCalledTimes(1)
    const persisted = store.setWorkspaceGroup.mock.calls[0][0] as ReturnType<typeof makeGroup>
    expect(persisted.id).toBe(group.id)
    expect(persisted.isArchived).toBe(true)
    expect(persisted.archiveCleanupError).toBeNull()
    expect(persisted.archivedAt as number).toBeGreaterThanOrEqual(before)
    expect(persisted.archivedAt as number).toBeLessThanOrEqual(after)

    expect(result.isArchived).toBe(true)
    expect(result.id).toBe(group.id)
  })

  it('returns existing state without re-archiving when the group is already archived', async () => {
    const memberA = 'repo-a::/workspace/daring_tiger/repo-a'
    const group = makeGroup({
      memberWorktreeIds: [memberA],
      isArchived: true,
      archivedAt: 123
    })
    store.getWorkspaceGroups.mockReturnValue([group])

    registerWorkspaceGroupHandlers(mainWindow, store as never, runtime)
    const handler = handlers['workspace-groups:archive']

    const result = (await handler({}, { groupId: group.id })) as ReturnType<typeof makeGroup>

    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
    expect(store.setWorkspaceGroup).not.toHaveBeenCalled()
    expect(rmSyncMock).not.toHaveBeenCalled()
    expect(result).toBe(group)
  })

  it('rejects when the group id is unknown', async () => {
    store.getWorkspaceGroups.mockReturnValue([])

    registerWorkspaceGroupHandlers(mainWindow, store as never, runtime)
    const handler = handlers['workspace-groups:archive']

    await expect(handler({}, { groupId: 'group:missing' })).rejects.toThrowError(
      /Workspace group not found: group:missing/
    )

    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
    expect(store.setWorkspaceGroup).not.toHaveBeenCalled()
  })
})

describe('registerWorkspaceGroupHandlers — workspace-groups:restore', () => {
  const mainWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  } as never
  const runtime = {} as never
  const handlers: Record<string, AnyHandler> = {}

  const store = {
    getRepo: vi.fn(),
    getRepos: vi.fn(),
    getSettings: vi.fn(),
    getWorktreeMeta: vi.fn(),
    setWorktreeMeta: vi.fn(),
    setWorkspaceGroup: vi.fn(),
    getWorkspaceGroups: vi.fn()
  }

  function makeGroup(overrides: Partial<WorkspaceGroup>): WorkspaceGroup {
    return {
      id: 'group:abc',
      workspaceName: 'daring_tiger',
      displayName: 'daring_tiger',
      parentPath: '/workspace/daring_tiger',
      memberWorktreeIds: ['repo-a::/workspace/daring_tiger/repo-a'],
      branchName: 'daring_tiger',
      isArchived: true,
      archivedAt: 1000,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      isUnread: false,
      comment: '',
      createdAt: 0,
      linkedIssue: null,
      linkedLinearIssue: null,
      ...overrides
    }
  }

  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    mkdirSyncMock.mockReset()
    addWorktreeForExistingBranchMock.mockReset()
    addWorktreeForExistingBranchMock.mockResolvedValue(undefined)
    store.getRepo.mockReset()
    store.getRepos.mockReset()
    store.getSettings.mockReset()
    store.getWorktreeMeta.mockReset()
    store.setWorktreeMeta.mockReset()
    store.setWorkspaceGroup.mockReset()
    store.getWorkspaceGroups.mockReset()
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }
    handleMock.mockImplementation((channel: string, handler: AnyHandler) => {
      handlers[channel] = handler
    })
    store.setWorkspaceGroup.mockImplementation((group) => group)
    store.getRepos.mockReturnValue([])
  })

  it('flag-flips members that still exist and flips the group active', async () => {
    const memberA = 'repo-a::/workspace/daring_tiger/repo-a'
    const memberB = 'repo-b::/workspace/daring_tiger/repo-b'
    const group = makeGroup({ memberWorktreeIds: [memberA, memberB] })
    store.getWorkspaceGroups.mockReturnValue([group])
    // Both members still have meta on disk → soft-archived, recover by flip.
    store.getWorktreeMeta.mockReturnValue({ isArchived: true, archivedAt: 1000 })

    registerWorkspaceGroupHandlers(mainWindow, store as never, runtime)
    const handler = handlers['workspace-groups:restore']
    expect(handler).toBeDefined()

    const result = (await handler({}, { groupId: group.id })) as ReturnType<typeof makeGroup>

    // No git recreation when the worktrees are still present.
    expect(addWorktreeForExistingBranchMock).not.toHaveBeenCalled()
    for (const id of [memberA, memberB]) {
      expect(store.setWorktreeMeta).toHaveBeenCalledWith(
        id,
        expect.objectContaining({ isArchived: false, archivedAt: null, archiveCleanupError: null })
      )
    }
    expect(store.setWorkspaceGroup).toHaveBeenCalledTimes(1)
    const persisted = store.setWorkspaceGroup.mock.calls[0][0] as ReturnType<typeof makeGroup>
    expect(persisted.isArchived).toBe(false)
    expect(persisted.archivedAt).toBeNull()
    expect(persisted.archiveCleanupError).toBeNull()
    expect(result.isArchived).toBe(false)
  })

  it('recreates a member whose worktree was destroyed, from the group branch', async () => {
    const memberA = 'repo-a::/workspace/daring_tiger/repo-a'
    const group = makeGroup({ memberWorktreeIds: [memberA] })
    store.getWorkspaceGroups.mockReturnValue([group])
    // Meta is gone (destructive archive / post-TTL) → must recreate.
    store.getWorktreeMeta.mockReturnValue(undefined)
    store.getRepo.mockReturnValue({ id: 'repo-a', path: '/repos/repo-a', connectionId: undefined })

    registerWorkspaceGroupHandlers(mainWindow, store as never, runtime)
    const handler = handlers['workspace-groups:restore']

    const result = (await handler({}, { groupId: group.id })) as ReturnType<typeof makeGroup>

    // Parent dir ensured, then git worktree add for the existing branch.
    expect(mkdirSyncMock).toHaveBeenCalledWith('/workspace/daring_tiger', { recursive: true })
    expect(addWorktreeForExistingBranchMock).toHaveBeenCalledWith(
      '/repos/repo-a',
      '/workspace/daring_tiger/repo-a',
      'daring_tiger'
    )
    // Recreated member's meta is re-stamped with the group identity, active.
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      memberA,
      expect.objectContaining({
        groupId: group.id,
        workspaceName: group.workspaceName,
        isArchived: false
      })
    )
    expect(result.isArchived).toBe(false)
  })

  it('flips the group active but rejects with a summary when a member branch is gone', async () => {
    const memberA = 'repo-a::/workspace/daring_tiger/repo-a'
    const group = makeGroup({ memberWorktreeIds: [memberA] })
    store.getWorkspaceGroups.mockReturnValue([group])
    store.getWorktreeMeta.mockReturnValue(undefined)
    store.getRepo.mockReturnValue({ id: 'repo-a', path: '/repos/repo-a', connectionId: undefined })
    addWorktreeForExistingBranchMock.mockRejectedValue(
      new Error('Branch "daring_tiger" no longer exists; cannot recreate worktree.')
    )

    registerWorkspaceGroupHandlers(mainWindow, store as never, runtime)
    const handler = handlers['workspace-groups:restore']

    await expect(handler({}, { groupId: group.id })).rejects.toThrowError(/no longer exists/i)
    // Group is still flipped active (recover what we can), error surfaced via throw.
    const persisted = store.setWorkspaceGroup.mock.calls[0][0] as ReturnType<typeof makeGroup>
    expect(persisted.isArchived).toBe(false)
  })

  it('does not run git for SSH members and reports them as unsupported', async () => {
    const memberA = 'repo-a::/workspace/daring_tiger/repo-a'
    const group = makeGroup({ memberWorktreeIds: [memberA] })
    store.getWorkspaceGroups.mockReturnValue([group])
    store.getWorktreeMeta.mockReturnValue(undefined)
    store.getRepo.mockReturnValue({ id: 'repo-a', path: '/repos/repo-a', connectionId: 'ssh-1' })

    registerWorkspaceGroupHandlers(mainWindow, store as never, runtime)
    const handler = handlers['workspace-groups:restore']

    await expect(handler({}, { groupId: group.id })).rejects.toThrowError(/SSH/i)
    expect(addWorktreeForExistingBranchMock).not.toHaveBeenCalled()
  })

  it('returns existing state without changes when the group is not archived', async () => {
    const group = makeGroup({ isArchived: false, archivedAt: null })
    store.getWorkspaceGroups.mockReturnValue([group])

    registerWorkspaceGroupHandlers(mainWindow, store as never, runtime)
    const handler = handlers['workspace-groups:restore']

    const result = (await handler({}, { groupId: group.id })) as ReturnType<typeof makeGroup>

    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
    expect(store.setWorkspaceGroup).not.toHaveBeenCalled()
    expect(addWorktreeForExistingBranchMock).not.toHaveBeenCalled()
    expect(result).toBe(group)
  })

  it('rejects when the group id is unknown', async () => {
    store.getWorkspaceGroups.mockReturnValue([])

    registerWorkspaceGroupHandlers(mainWindow, store as never, runtime)
    const handler = handlers['workspace-groups:restore']

    await expect(handler({}, { groupId: 'group:missing' })).rejects.toThrowError(
      /Workspace group not found: group:missing/
    )
    expect(store.setWorkspaceGroup).not.toHaveBeenCalled()
  })
})

describe('registerWorkspaceGroupHandlers — workspace-groups:update', () => {
  const mainWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  } as never
  const runtime = {} as never
  const handlers: Record<string, AnyHandler> = {}

  const store = {
    getRepo: vi.fn(),
    getRepos: vi.fn(),
    getSettings: vi.fn(),
    setWorktreeMeta: vi.fn(),
    setWorkspaceGroup: vi.fn(),
    getWorkspaceGroups: vi.fn()
  }

  function makeGroup(overrides: Partial<WorkspaceGroup>): WorkspaceGroup {
    return {
      id: 'group:abc',
      workspaceName: 'daring_tiger',
      displayName: 'daring_tiger',
      parentPath: '/workspace/daring_tiger',
      memberWorktreeIds: [],
      branchName: 'daring_tiger',
      isArchived: false,
      archivedAt: null,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      isUnread: false,
      comment: '',
      createdAt: 0,
      linkedIssue: null,
      linkedLinearIssue: null,
      ...overrides
    }
  }

  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    store.setWorkspaceGroup.mockReset()
    store.getWorkspaceGroups.mockReset()
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }

    handleMock.mockImplementation((channel: string, handler: AnyHandler) => {
      handlers[channel] = handler
    })

    store.setWorkspaceGroup.mockImplementation((group) => group)
  })

  it('applies displayName, comment, and isPinned changes via the allow-list', async () => {
    const group = makeGroup({ displayName: 'old', comment: '', isPinned: false })
    store.getWorkspaceGroups.mockReturnValue([group])

    registerWorkspaceGroupHandlers(mainWindow, store as never, runtime)
    const handler = handlers['workspace-groups:update']
    expect(handler).toBeDefined()

    const result = (await handler(
      {},
      {
        groupId: group.id,
        partial: { displayName: 'new label', comment: 'hello', isPinned: true }
      }
    )) as WorkspaceGroup

    expect(result.displayName).toBe('new label')
    expect(result.comment).toBe('hello')
    expect(result.isPinned).toBe(true)
    // Unmodified fields stay intact.
    expect(result.id).toBe(group.id)
    expect(result.workspaceName).toBe(group.workspaceName)
    expect(result.parentPath).toBe(group.parentPath)

    expect(store.setWorkspaceGroup).toHaveBeenCalledWith(result)
  })

  it('ignores empty/whitespace displayName (treats it as a no-op for that field)', async () => {
    // Why: matches the WorktreeMeta allow-list — blank displayName falls back
    // to the persisted value so the user can't accidentally erase the label
    // by submitting the rename dialog with an empty input.
    const group = makeGroup({ displayName: 'kept', comment: 'kept comment' })
    store.getWorkspaceGroups.mockReturnValue([group])

    registerWorkspaceGroupHandlers(mainWindow, store as never, runtime)
    const handler = handlers['workspace-groups:update']

    const result = (await handler(
      {},
      { groupId: group.id, partial: { displayName: '   ', comment: 'updated comment' } }
    )) as WorkspaceGroup

    expect(result.displayName).toBe('kept')
    expect(result.comment).toBe('updated comment')
  })

  it('rejects when the group id is unknown', async () => {
    store.getWorkspaceGroups.mockReturnValue([])

    registerWorkspaceGroupHandlers(mainWindow, store as never, runtime)
    const handler = handlers['workspace-groups:update']

    await expect(
      handler({}, { groupId: 'group:missing', partial: { displayName: 'x' } })
    ).rejects.toThrowError(/Workspace group not found: group:missing/)
    expect(store.setWorkspaceGroup).not.toHaveBeenCalled()
  })

  it('ignores keys outside the allow-list (e.g. memberWorktreeIds, isArchived)', async () => {
    const group = makeGroup({ displayName: 'old', isArchived: false })
    store.getWorkspaceGroups.mockReturnValue([group])

    registerWorkspaceGroupHandlers(mainWindow, store as never, runtime)
    const handler = handlers['workspace-groups:update']

    const result = (await handler(
      {},
      {
        groupId: group.id,
        // Cast through unknown — the handler signature constrains callers, but
        // a misbehaving renderer could send extra keys at runtime.
        partial: {
          displayName: 'new',
          isArchived: true,
          memberWorktreeIds: ['x']
        } as unknown as { displayName?: string }
      }
    )) as WorkspaceGroup

    expect(result.displayName).toBe('new')
    expect(result.isArchived).toBe(false)
    expect(result.memberWorktreeIds).toEqual(group.memberWorktreeIds)
  })
})
