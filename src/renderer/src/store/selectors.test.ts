import { describe, it, expect } from 'vitest'
import {
  getGroupById,
  getGroupByWorktreeId,
  getMemberWorktreesForGroup,
  getSiblingWorktreeIdsForGroupMember,
  isWorktreeGrouped
} from './selectors'
import type { Worktree, WorkspaceGroup } from '../../../shared/types'

function makeGroup(id: string, memberIds: string[]): WorkspaceGroup {
  return {
    id,
    workspaceName: id,
    displayName: id,
    parentPath: `/x/${id}`,
    memberWorktreeIds: memberIds,
    branchName: id,
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

function makeWorktree(id: string, repoId: string): Worktree {
  return {
    id,
    repoId,
    displayName: id,
    workspaceName: id,
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
    path: `/repos/${repoId}/${id}`,
    head: 'deadbeef',
    branch: `branch-${id}`,
    isBare: false,
    isMainWorktree: false
  }
}

describe('group selectors', () => {
  describe('getGroupById', () => {
    it('returns the group matching the id', () => {
      const g1 = makeGroup('group:a', ['repoA::/wt1'])
      const g2 = makeGroup('group:b', ['repoB::/wt2'])
      const state = { workspaceGroups: [g1, g2] }
      expect(getGroupById(state, 'group:b')).toBe(g2)
    })

    it('returns null when no group matches', () => {
      const state = { workspaceGroups: [makeGroup('group:a', [])] }
      expect(getGroupById(state, 'group:missing')).toBeNull()
    })
  })

  describe('getGroupByWorktreeId', () => {
    it('returns the group containing the worktree id', () => {
      const g1 = makeGroup('group:a', ['repoA::/wt1', 'repoB::/wt2'])
      const g2 = makeGroup('group:b', ['repoC::/wt3'])
      const state = { workspaceGroups: [g1, g2] }
      expect(getGroupByWorktreeId(state, 'repoB::/wt2')).toBe(g1)
      expect(getGroupByWorktreeId(state, 'repoC::/wt3')).toBe(g2)
    })

    it('returns null when no group contains the worktree id', () => {
      const g1 = makeGroup('group:a', ['repoA::/wt1'])
      const state = { workspaceGroups: [g1] }
      expect(getGroupByWorktreeId(state, 'repoZ::/none')).toBeNull()
    })
  })

  describe('getMemberWorktreesForGroup', () => {
    it('returns worktrees in the order specified by memberWorktreeIds', () => {
      const wtA = makeWorktree('repoA::/wt1', 'repoA')
      const wtB = makeWorktree('repoB::/wt2', 'repoB')
      const wtC = makeWorktree('repoC::/wt3', 'repoC')
      const group = makeGroup('group:a', [wtC.id, wtA.id, wtB.id])
      const state = {
        workspaceGroups: [group],
        worktreesByRepo: {
          repoA: [wtA],
          repoB: [wtB],
          repoC: [wtC]
        }
      }
      expect(getMemberWorktreesForGroup(state, 'group:a')).toEqual([wtC, wtA, wtB])
    })

    it('drops members whose worktree cannot be resolved', () => {
      const wtA = makeWorktree('repoA::/wt1', 'repoA')
      const group = makeGroup('group:a', [wtA.id, 'repoX::/missing'])
      const state = {
        workspaceGroups: [group],
        worktreesByRepo: { repoA: [wtA] }
      }
      expect(getMemberWorktreesForGroup(state, 'group:a')).toEqual([wtA])
    })

    it('returns an empty array when the group does not exist', () => {
      const state = { workspaceGroups: [], worktreesByRepo: {} }
      expect(getMemberWorktreesForGroup(state, 'group:missing')).toEqual([])
    })
  })

  describe('getSiblingWorktreeIdsForGroupMember', () => {
    it('returns the other members of the active worktree’s group, preserving group order', () => {
      const wtA = makeWorktree('repoA::/wt1', 'repoA')
      const wtB = makeWorktree('repoB::/wt2', 'repoB')
      const wtC = makeWorktree('repoC::/wt3', 'repoC')
      const group = makeGroup('group:a', [wtA.id, wtB.id, wtC.id])
      const state = {
        workspaceGroups: [group],
        worktreesByRepo: { repoA: [wtA], repoB: [wtB], repoC: [wtC] }
      }
      expect(getSiblingWorktreeIdsForGroupMember(state, wtA.id)).toEqual([wtB.id, wtC.id])
      expect(getSiblingWorktreeIdsForGroupMember(state, wtB.id)).toEqual([wtA.id, wtC.id])
    })

    it('returns an empty array when the worktree is not in any group', () => {
      const wtA = makeWorktree('repoA::/wt1', 'repoA')
      const state = {
        workspaceGroups: [],
        worktreesByRepo: { repoA: [wtA] }
      }
      expect(getSiblingWorktreeIdsForGroupMember(state, wtA.id)).toEqual([])
    })

    it('omits archived sibling worktrees — they have no surface to host tabs anymore', () => {
      const wtA = makeWorktree('repoA::/wt1', 'repoA')
      const wtB = { ...makeWorktree('repoB::/wt2', 'repoB'), isArchived: true }
      const wtC = makeWorktree('repoC::/wt3', 'repoC')
      const group = makeGroup('group:a', [wtA.id, wtB.id, wtC.id])
      const state = {
        workspaceGroups: [group],
        worktreesByRepo: { repoA: [wtA], repoB: [wtB], repoC: [wtC] }
      }
      expect(getSiblingWorktreeIdsForGroupMember(state, wtA.id)).toEqual([wtC.id])
    })

    it('omits sibling members whose worktree record cannot be resolved', () => {
      const wtA = makeWorktree('repoA::/wt1', 'repoA')
      const group = makeGroup('group:a', [wtA.id, 'repoX::/ghost'])
      const state = {
        workspaceGroups: [group],
        worktreesByRepo: { repoA: [wtA] }
      }
      expect(getSiblingWorktreeIdsForGroupMember(state, wtA.id)).toEqual([])
    })
  })

  describe('isWorktreeGrouped', () => {
    it('returns true when the worktree is a member of some group', () => {
      const g = makeGroup('group:a', ['repoA::/wt1'])
      const state = { workspaceGroups: [g] }
      expect(isWorktreeGrouped(state, 'repoA::/wt1')).toBe(true)
    })

    it('returns false when no group contains the worktree id', () => {
      const g = makeGroup('group:a', ['repoA::/wt1'])
      const state = { workspaceGroups: [g] }
      expect(isWorktreeGrouped(state, 'repoB::/wt2')).toBe(false)
    })
  })
})
