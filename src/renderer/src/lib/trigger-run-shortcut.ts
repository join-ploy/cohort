// Why: Cmd+R / Ctrl+R can be invoked from two surfaces — the renderer's
// global keydown listener and the Electron menu accelerator IPC. Centralizing
// the side-effect chain (open sidebar -> switch to Run tab -> call
// runScript.start -> toast on failure) keeps both call sites in lockstep so
// menu and shortcut behavior cannot drift. See
// docs/plans/2026-05-14-per-repo-run-script-design.md §"Phase 8" for the
// design rationale on why menu+shortcut share one entry point.

import { toast as defaultToast } from 'sonner'
import type { RunStartArgs, RunStartResult } from '../../../shared/script-types'
import type { RightSidebarTab } from '../store/slices/editor'

// Why: read only the keys triggerRunShortcut touches. Avoids depending on the
// full `AppState` import chain in tests — pulling that in transitively loads
// the `@/` aliases which vitest resolves only inside renderer-config files.
export type TriggerRunShortcutStoreSlice = {
  activeWorktreeId: string | null
  rightSidebarOpen: boolean
  setRightSidebarOpen: (open: boolean) => void
  setRightSidebarTab: (tab: RightSidebarTab) => void
  repos: readonly { id: string; displayName?: string }[]
  worktreesByRepo: Record<string, readonly { id: string; repoId: string }[]>
}

export type TriggerRunShortcutDeps = {
  /** Store accessor — only `getState()` is read (mirrors Zustand's API). */
  store: { getState: () => TriggerRunShortcutStoreSlice }
  /** `window.api.runScript.start`. Injectable so tests don't need a full preload bridge. */
  start: (args: RunStartArgs) => Promise<RunStartResult>
  /** Sonner toast surface. Injectable for assertion-friendly tests. */
  toast: {
    message: (msg: string) => unknown
    error: (msg: string) => unknown
  }
}

/** Resolve the active worktree + owning repo, open the right-sidebar Run tab,
 *  start the run script, and surface a toast on failure. Returns a promise
 *  that resolves once the start IPC settles so callers (and tests) can await
 *  the full chain. Silent no-op when no active worktree or repo can be
 *  resolved — matches the menu accelerator's "best-effort" semantics. */
export async function triggerRunShortcut(deps: TriggerRunShortcutDeps): Promise<void> {
  const state = deps.store.getState()

  // Why: walk worktreesByRepo directly instead of routing through the cached
  // selectors in store/selectors. Those selectors require the full AppState
  // shape and pull in additional store wiring, which would force this helper
  // to import the live store — preventing the keydown listener and IPC
  // subscriber from sharing a single, easily-testable seam.
  const worktree = state.activeWorktreeId ? findWorktree(state, state.activeWorktreeId) : null
  if (!worktree) {
    return
  }

  const repo = state.repos.find((r) => r.id === worktree.repoId) ?? null
  if (!repo) {
    return
  }

  // Why: opening + switching tab is unconditional so the sidebar reveals the
  // Run panel even when the run fails (so the user sees the empty-state CTA
  // rather than a silent toast with no follow-up surface).
  if (!state.rightSidebarOpen) {
    state.setRightSidebarOpen(true)
  }
  state.setRightSidebarTab('run')

  const result = await deps.start({ repoId: repo.id, worktreeId: worktree.id })
  if (result.ok) {
    return
  }

  if (result.reason === 'no-run-script') {
    deps.toast.message(`No run script configured for ${repo.displayName ?? repo.id}`)
    return
  }
  deps.toast.error(`Could not start run script: ${result.reason}`)
}

/** Build the production-default deps for `triggerRunShortcut`. Exposed so
 *  call sites (App keydown, IPC subscriber) can defer the import of `window`
 *  globals until inside the handler — keeping module-load order simple in
 *  vitest where `window.api` is stubbed per test. */
export function getDefaultTriggerRunShortcutDeps(store: {
  getState: () => TriggerRunShortcutStoreSlice
}): TriggerRunShortcutDeps {
  return {
    store,
    start: (args) => window.api.runScript.start(args),
    toast: {
      message: (msg) => defaultToast.message(msg),
      error: (msg) => defaultToast.error(msg)
    }
  }
}

function findWorktree(
  state: TriggerRunShortcutStoreSlice,
  worktreeId: string
): { id: string; repoId: string } | null {
  for (const list of Object.values(state.worktreesByRepo)) {
    const match = list.find((w) => w.id === worktreeId)
    if (match) {
      return match
    }
  }
  return null
}
