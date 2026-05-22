import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  CreateWorkspaceGroupArgs,
  CreateWorkspaceGroupResult,
  WorkspaceGroup
} from '../../../../shared/types'

export type WorkspaceGroupsSlice = {
  workspaceGroups: WorkspaceGroup[]
  fetchWorkspaceGroups: () => Promise<void>
  setWorkspaceGroups: (groups: WorkspaceGroup[]) => void
  upsertWorkspaceGroup: (group: WorkspaceGroup) => void
  removeWorkspaceGroup: (id: string) => void
  createGroup: (args: CreateWorkspaceGroupArgs) => Promise<CreateWorkspaceGroupResult>
}

export const createWorkspaceGroupsSlice: StateCreator<AppState, [], [], WorkspaceGroupsSlice> = (
  set
) => ({
  workspaceGroups: [],

  fetchWorkspaceGroups: async () => {
    try {
      const groups = await window.api.workspaceGroups.list()
      set({ workspaceGroups: groups })
    } catch (err) {
      console.error('Failed to fetch workspace groups:', err)
    }
  },

  setWorkspaceGroups: (groups) => set({ workspaceGroups: groups }),

  upsertWorkspaceGroup: (group) =>
    set((s) => {
      const existing = s.workspaceGroups.findIndex((g) => g.id === group.id)
      if (existing === -1) {
        return { workspaceGroups: [...s.workspaceGroups, group] }
      }
      const next = [...s.workspaceGroups]
      next[existing] = group
      return { workspaceGroups: next }
    }),

  removeWorkspaceGroup: (id) =>
    set((s) => ({ workspaceGroups: s.workspaceGroups.filter((g) => g.id !== id) })),

  createGroup: async (args) => {
    try {
      const result = await window.api.workspaceGroups.create(args)
      // Why: stamp the new group + groupId on each member's worktree state in
      // a single set() so the sidebar can render the grouped card without
      // waiting for a follow-up worktrees:changed refresh.
      set((s) => {
        const existing = s.workspaceGroups.findIndex((g) => g.id === result.group.id)
        const nextGroups =
          existing === -1
            ? [...s.workspaceGroups, result.group]
            : s.workspaceGroups.map((g) => (g.id === result.group.id ? result.group : g))

        const memberById = new Map(result.memberWorktrees.map((w) => [w.id, w]))
        const nextWorktreesByRepo = { ...s.worktreesByRepo }
        for (const member of result.memberWorktrees) {
          const current = nextWorktreesByRepo[member.repoId] ?? []
          const idx = current.findIndex((w) => w.id === member.id)
          if (idx === -1) {
            nextWorktreesByRepo[member.repoId] = [...current, member]
          } else {
            const next = [...current]
            next[idx] = { ...current[idx], ...memberById.get(member.id)! }
            nextWorktreesByRepo[member.repoId] = next
          }
        }

        return {
          workspaceGroups: nextGroups,
          worktreesByRepo: nextWorktreesByRepo,
          sortEpoch: s.sortEpoch + 1
        }
      })
      return result
    } catch (err) {
      console.error('Failed to create workspace group:', err)
      throw err
    }
  }
})
