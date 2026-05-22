import { describe, it, expect, beforeEach, vi } from 'vitest'
import type * as StoreModule from '../index'

// We test the slice via the real store so type-narrowing flows through AppState.
// Tests focus on slice logic, not on the preload bridge.

describe('workspace-groups slice', () => {
  let useAppStore: typeof StoreModule.useAppStore

  beforeEach(async () => {
    vi.resetModules()
    // Stub window.api before importing the store
    ;(globalThis as unknown as { window: { api: unknown } }).window = {
      api: {
        workspaceGroups: {
          list: vi.fn().mockResolvedValue([]),
          create: vi.fn()
        }
      }
    }
    const mod = await import('../index')
    useAppStore = mod.useAppStore
  })

  function makeGroup(id: string, workspaceName: string) {
    return {
      id,
      workspaceName,
      displayName: workspaceName,
      parentPath: `/x/${workspaceName}`,
      memberWorktreeIds: [],
      branchName: workspaceName,
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
  }

  it('starts with empty list', () => {
    expect(useAppStore.getState().workspaceGroups).toEqual([])
  })

  it('setWorkspaceGroups replaces the list', () => {
    const groups = [makeGroup('group:a', 'daring_tiger')]
    useAppStore.getState().setWorkspaceGroups(groups)
    expect(useAppStore.getState().workspaceGroups).toEqual(groups)
  })

  it('upsertWorkspaceGroup adds a new group', () => {
    const g = makeGroup('group:a', 'daring_tiger')
    useAppStore.getState().upsertWorkspaceGroup(g)
    expect(useAppStore.getState().workspaceGroups).toHaveLength(1)
  })

  it('upsertWorkspaceGroup replaces an existing group by id', () => {
    const g1 = makeGroup('group:a', 'name1')
    useAppStore.getState().upsertWorkspaceGroup(g1)
    const g2 = { ...g1, workspaceName: 'name2' }
    useAppStore.getState().upsertWorkspaceGroup(g2)
    expect(useAppStore.getState().workspaceGroups).toHaveLength(1)
    expect(useAppStore.getState().workspaceGroups[0].workspaceName).toBe('name2')
  })

  it('removeWorkspaceGroup removes by id', () => {
    const g = makeGroup('group:a', 'daring_tiger')
    useAppStore.getState().setWorkspaceGroups([g])
    useAppStore.getState().removeWorkspaceGroup('group:a')
    expect(useAppStore.getState().workspaceGroups).toEqual([])
  })

  it('fetchWorkspaceGroups pulls from window.api and stores result', async () => {
    const g = makeGroup('group:a', 'daring_tiger')
    ;(window.api.workspaceGroups.list as ReturnType<typeof vi.fn>).mockResolvedValue([g])
    await useAppStore.getState().fetchWorkspaceGroups()
    expect(useAppStore.getState().workspaceGroups).toEqual([g])
  })

  it('createGroup calls the IPC and upserts the result', async () => {
    const newGroup = makeGroup('group:new', 'feature_x')
    const memberWt = {
      id: 'r1::/x/feature_x/r1',
      repoId: 'r1',
      groupId: 'group:new'
    }
    ;(window.api.workspaceGroups.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      group: newGroup,
      memberWorktrees: [memberWt]
    })

    const args = {
      workspaceName: 'feature_x',
      branchName: 'feature_x',
      members: [{ repoId: 'r1', baseRef: null, setupDecision: 'inherit' as const }]
    }
    const result = await useAppStore.getState().createGroup(args as never)

    expect(window.api.workspaceGroups.create).toHaveBeenCalledWith(args)
    expect(result.group).toEqual(newGroup)
    expect(useAppStore.getState().workspaceGroups).toContainEqual(newGroup)
  })
})
