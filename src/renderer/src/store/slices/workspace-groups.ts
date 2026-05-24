import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  CreateWorkspaceGroupArgs,
  CreateWorkspaceGroupResult,
  WorkspaceGroup
} from '../../../../shared/types'

export type UpdateWorkspaceGroupPartial = {
  displayName?: string
  comment?: string
  isPinned?: boolean
}

export type WorkspaceGroupsSlice = {
  workspaceGroups: WorkspaceGroup[]
  /** Transient set of groupIds whose archive IPC is in flight. The GroupCard
   *  reads this to render a dim overlay + spinner — group archive runs cleanup
   *  scripts in parallel per member and can take real seconds, so the user
   *  needs visible feedback that the action is still in progress. */
  archivingGroupIds: ReadonlySet<string>
  fetchWorkspaceGroups: () => Promise<void>
  setWorkspaceGroups: (groups: WorkspaceGroup[]) => void
  upsertWorkspaceGroup: (group: WorkspaceGroup) => void
  removeWorkspaceGroup: (id: string) => void
  createGroup: (args: CreateWorkspaceGroupArgs) => Promise<CreateWorkspaceGroupResult>
  archiveGroup: (groupId: string) => Promise<WorkspaceGroup>
  updateWorkspaceGroup: (
    groupId: string,
    partial: UpdateWorkspaceGroupPartial
  ) => Promise<WorkspaceGroup>
}

export const createWorkspaceGroupsSlice: StateCreator<AppState, [], [], WorkspaceGroupsSlice> = (
  set
) => ({
  workspaceGroups: [],
  archivingGroupIds: new Set<string>(),

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

  // Why: archive cascades through every member's runWorktreeRemoval in main.
  // On success the main process returns the updated group; we upsert it so the
  // visible Groups section drops the row and ArchivedSection picks it up
  // without a follow-up list refresh. On failure (cleanup blocked) main also
  // persists the per-member error string — refetch so the visible card shows
  // the latest archiveCleanupError before we re-throw to the caller.
  archiveGroup: async (groupId) => {
    // Why: stamp the in-flight id immediately so the GroupCard overlay paints
    // on the same React tick the user clicked Archive. Cleared in finally so
    // both success and failure paths reset the visual state.
    set((s) => {
      const next = new Set(s.archivingGroupIds)
      next.add(groupId)
      return { archivingGroupIds: next }
    })
    try {
      const updated = await window.api.workspaceGroups.archive({ groupId })
      set((s) => ({
        workspaceGroups: s.workspaceGroups.map((g) => (g.id === updated.id ? updated : g))
      }))
      return updated
    } catch (err) {
      // Why: the handler stamps archiveCleanupError on the group before
      // throwing, so a refresh here surfaces the per-member error in the UI
      // even though the action itself rejected.
      try {
        const groups = await window.api.workspaceGroups.list()
        set({ workspaceGroups: groups })
      } catch (refreshErr) {
        console.error('Failed to refresh workspace groups after archive error:', refreshErr)
      }
      throw err
    } finally {
      set((s) => {
        if (!s.archivingGroupIds.has(groupId)) {
          return {}
        }
        const next = new Set(s.archivingGroupIds)
        next.delete(groupId)
        return { archivingGroupIds: next }
      })
    }
  },

  // Why: optimistic upsert keeps the rename/pin UI snappy — main echoes back
  // the canonical record so any allow-list clamping (e.g. blank displayName)
  // converges before the user sees a stale value.
  updateWorkspaceGroup: async (groupId, partial) => {
    const updated = await window.api.workspaceGroups.update({ groupId, partial })
    set((s) => ({
      workspaceGroups: s.workspaceGroups.map((g) => (g.id === updated.id ? updated : g))
    }))
    return updated
  },

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
