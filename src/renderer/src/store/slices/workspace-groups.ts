import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { WorkspaceGroup } from '../../../../shared/types'

export type WorkspaceGroupsSlice = {
  workspaceGroups: WorkspaceGroup[]
  fetchWorkspaceGroups: () => Promise<void>
  setWorkspaceGroups: (groups: WorkspaceGroup[]) => void
  upsertWorkspaceGroup: (group: WorkspaceGroup) => void
  removeWorkspaceGroup: (id: string) => void
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
    set((s) => ({ workspaceGroups: s.workspaceGroups.filter((g) => g.id !== id) }))
})
