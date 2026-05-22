import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { Worktree } from '../../../../shared/types'
import type {
  RunStartArgs,
  RunStartResult,
  RunStopArgs,
  RunStopResult
} from '../../../../shared/script-types'
import { findWorktreeById } from './worktree-helpers'

// Why: resolve group members inline rather than importing
// getMemberWorktreesForGroup from ../selectors — that module pulls in the
// live store, which would create an import cycle (store → scripts slice →
// selectors → store). Selectors re-export the same semantics for renderer
// consumers; this private duplicate keeps the slice tree-shakable.
function resolveGroupMembers(state: AppState, groupId: string): Worktree[] {
  const group = state.workspaceGroups.find((g) => g.id === groupId)
  if (!group) {
    return []
  }
  const members: Worktree[] = []
  for (const id of group.memberWorktreeIds) {
    const worktree = findWorktreeById(state.worktreesByRepo, id)
    if (worktree) {
      members.push(worktree)
    }
  }
  return members
}

// Why: per-repo run/setup script status lives in renderer memory only — main
// owns the PTY lifecycle (runPtyByRepo registry) and the slice mirrors what
// it needs to drive the activity-bar dot and Run/Setup panels. See
// docs/plans/2026-05-14-per-repo-run-script-design.md §"State and persistence".
export type ScriptStatus = 'idle' | 'running' | 'exited-success' | 'exited-failure'

export type ScriptState = {
  ptyId: string | null
  status: ScriptStatus
  exitCode: number | null
  startedAt: number | null
}

export type ScriptKind = 'run' | 'setup'

const IDLE_STATE: ScriptState = {
  ptyId: null,
  status: 'idle',
  exitCode: null,
  startedAt: null
}

export type WorktreeScriptsEntry = { run: ScriptState; setup: ScriptState }

export type ScriptsSlice = {
  scriptsByWorktree: Record<string, WorktreeScriptsEntry>
  /** Worktree IDs whose create-time setup spawn is still pending. When the
   *  matching setup:exited fires, useIpcEvents flips the right-sidebar tab
   *  from 'setup' to 'run' (if the user hasn't navigated away). Manual
   *  Re-run does NOT mark, so only the post-create handoff auto-switches. */
  worktreeIdsAwaitingSetupAutoSwitch: Set<string>
  handleRunStarted: (args: { worktreeId: string; ptyId: string }) => void
  handleRunExited: (args: { worktreeId: string; code: number }) => void
  handleSetupStarted: (args: { worktreeId: string; ptyId: string }) => void
  handleSetupExited: (args: { worktreeId: string; code: number }) => void
  markWorktreeForSetupAutoSwitch: (worktreeId: string) => void
  clearWorktreeSetupAutoSwitch: (worktreeId: string) => void
  /** Fan out run-script start to every member of a workspace group. Any
   *  member with an already-running PTY is stopped first so the new start
   *  replaces it cleanly instead of stacking two PTYs on the same repo.
   *  Deps are injectable so tests can stub the IPC layer. */
  startGroupRun: (groupId: string, deps?: GroupRunDeps) => Promise<RunStartResult[]>
  /** Fan out run-script stop to every member of a workspace group that
   *  currently has a live PTY. Members in idle/exited states are skipped
   *  so we don't toast 'not-running' for every quiet member. */
  stopGroupRun: (groupId: string, deps?: GroupRunDeps) => Promise<RunStopResult[]>
}

// Why: GroupRunDeps shape mirrors the per-call `callRunStart` injection in
// RunPanel.tsx — keeps the slice action testable without reaching for the
// preload bridge, and gives RunPanelGroupView one place to wire the
// production `window.api.runScript.*` surface.
export type GroupRunDeps = {
  start: (args: RunStartArgs) => Promise<RunStartResult>
  stop: (args: RunStopArgs) => Promise<RunStopResult>
}

function defaultGroupRunDeps(): GroupRunDeps {
  return {
    start: (args) => window.api.runScript.start(args),
    stop: (args) => window.api.runScript.stop(args)
  }
}

function ensureWorktreeEntry(
  state: Record<string, WorktreeScriptsEntry>,
  worktreeId: string
): WorktreeScriptsEntry {
  return state[worktreeId] ?? { run: IDLE_STATE, setup: IDLE_STATE }
}

function applyStarted(ptyId: string): ScriptState {
  // Why: a re-run while still 'running' replaces ptyId and restamps startedAt
  // so the UI's elapsed counter resets. exitCode is also cleared so a stale
  // value from a prior exit can't bleed into the new run window.
  return {
    ptyId,
    status: 'running',
    exitCode: null,
    startedAt: Date.now()
  }
}

function applyExited(prev: ScriptState, code: number): ScriptState {
  return {
    ...prev,
    status: code === 0 ? 'exited-success' : 'exited-failure',
    exitCode: code
  }
}

export const createScriptsSlice: StateCreator<AppState, [], [], ScriptsSlice> = (set, get) => ({
  scriptsByWorktree: {},
  worktreeIdsAwaitingSetupAutoSwitch: new Set<string>(),

  handleRunStarted: ({ worktreeId, ptyId }) => {
    set((s) => {
      const entry = ensureWorktreeEntry(s.scriptsByWorktree, worktreeId)
      return {
        scriptsByWorktree: {
          ...s.scriptsByWorktree,
          [worktreeId]: {
            ...entry,
            run: applyStarted(ptyId)
          }
        }
      }
    })
  },

  handleRunExited: ({ worktreeId, code }) => {
    set((s) => {
      const entry = ensureWorktreeEntry(s.scriptsByWorktree, worktreeId)
      return {
        scriptsByWorktree: {
          ...s.scriptsByWorktree,
          [worktreeId]: {
            ...entry,
            run: applyExited(entry.run, code)
          }
        }
      }
    })
  },

  handleSetupStarted: ({ worktreeId, ptyId }) => {
    set((s) => {
      const entry = ensureWorktreeEntry(s.scriptsByWorktree, worktreeId)
      return {
        scriptsByWorktree: {
          ...s.scriptsByWorktree,
          [worktreeId]: {
            ...entry,
            setup: applyStarted(ptyId)
          }
        }
      }
    })
  },

  handleSetupExited: ({ worktreeId, code }) => {
    set((s) => {
      const entry = ensureWorktreeEntry(s.scriptsByWorktree, worktreeId)
      return {
        scriptsByWorktree: {
          ...s.scriptsByWorktree,
          [worktreeId]: {
            ...entry,
            setup: applyExited(entry.setup, code)
          }
        }
      }
    })
  },

  markWorktreeForSetupAutoSwitch: (worktreeId) => {
    set((s) => {
      // Why: re-marking an already-marked id should be a no-op so we don't
      // mint a new Set (and trigger subscriber fan-out) on every composer
      // re-render that happens to land on the same worktree.
      if (s.worktreeIdsAwaitingSetupAutoSwitch.has(worktreeId)) {
        return s
      }
      const next = new Set(s.worktreeIdsAwaitingSetupAutoSwitch)
      next.add(worktreeId)
      return { worktreeIdsAwaitingSetupAutoSwitch: next }
    })
  },

  clearWorktreeSetupAutoSwitch: (worktreeId) => {
    set((s) => {
      if (!s.worktreeIdsAwaitingSetupAutoSwitch.has(worktreeId)) {
        return s
      }
      const next = new Set(s.worktreeIdsAwaitingSetupAutoSwitch)
      next.delete(worktreeId)
      return { worktreeIdsAwaitingSetupAutoSwitch: next }
    })
  },

  startGroupRun: async (groupId, deps = defaultGroupRunDeps()) => {
    const state = get()
    const members = resolveGroupMembers(state, groupId)
    if (members.length === 0) {
      return []
    }
    // Why: pre-stop any member with a live PTY so the upcoming start replaces
    // it cleanly. Without this, main's per-repo PTY registry would refuse the
    // new spawn (or leave the old one orphaned) and we'd silently fail to
    // restart the group. 'not-running' from a benign race is ignored.
    const liveMembers = members.filter(
      (m) => state.scriptsByWorktree[m.id]?.run.status === 'running'
    )
    await Promise.all(liveMembers.map((m) => deps.stop({ repoId: m.repoId })))
    // Why: kick all members in parallel so a slow start on one repo doesn't
    // delay the others. Each promise resolves to a RunStartResult so the
    // caller can decide whether to surface a toast per failure.
    return Promise.all(members.map((m) => deps.start({ repoId: m.repoId, worktreeId: m.id })))
  },

  stopGroupRun: async (groupId, deps = defaultGroupRunDeps()) => {
    const state = get()
    const members = resolveGroupMembers(state, groupId)
    if (members.length === 0) {
      return []
    }
    // Why: only stop members with a live PTY — calling stop on an idle/exited
    // repo would surface 'not-running' from main for every quiet member.
    const liveMembers = members.filter(
      (m) => state.scriptsByWorktree[m.id]?.run.status === 'running'
    )
    return Promise.all(liveMembers.map((m) => deps.stop({ repoId: m.repoId })))
  }
})
