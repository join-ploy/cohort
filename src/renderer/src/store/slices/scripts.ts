import type { StateCreator } from 'zustand'
import type { AppState } from '../types'

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
  handleRunStarted: (args: { worktreeId: string; ptyId: string }) => void
  handleRunExited: (args: { worktreeId: string; code: number }) => void
  handleSetupStarted: (args: { worktreeId: string; ptyId: string }) => void
  handleSetupExited: (args: { worktreeId: string; code: number }) => void
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

export const createScriptsSlice: StateCreator<AppState, [], [], ScriptsSlice> = (set) => ({
  scriptsByWorktree: {},

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
  }
})
