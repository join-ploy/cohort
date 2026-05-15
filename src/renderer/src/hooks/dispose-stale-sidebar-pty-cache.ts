import type { ScriptKind, WorktreeScriptsEntry } from '@/store/slices/scripts'

// Why: cache-disposal decisions for the right-sidebar Run/Setup terminals
// live here so useIpcEvents.ts stays thin and the logic is testable in
// isolation. The cache itself (sidebar-pty-terminal-cache.ts) handles
// the destructive xterm calls; these helpers decide WHEN to fire them.
//
// Two triggers:
// 1. Script restart — when run/setup emit `started` with a new ptyId for
//    the same worktree, the prior cached terminal is now orphaned and
//    must go away (the React component re-keys on ptyId, so the prior
//    entry has no live attach surface).
// 2. Worktree delete — purgeWorktreeTerminalState evicts everything else
//    for the deleted worktrees, but it can't reach into the renderer-only
//    sidebar cache; we walk the run/setup entries and dispose their ptyIds
//    before the slice drops them.

export type DisposePriorScriptCachedTerminalArgs = {
  kind: ScriptKind
  worktreeId: string
  newPtyId: string
  scriptsByWorktree: Record<string, WorktreeScriptsEntry>
  dispose: (ptyId: string) => void
}

export function disposePriorScriptCachedTerminal(args: DisposePriorScriptCachedTerminalArgs): void {
  const prior = args.scriptsByWorktree[args.worktreeId]?.[args.kind]?.ptyId
  // Why: idempotent restart events (e.g. main re-broadcasts on reconnect)
  // can carry the same ptyId; only dispose when it actually changed.
  if (prior && prior !== args.newPtyId) {
    args.dispose(prior)
  }
}

export type DisposeWorktreeCachedSidebarTerminalsArgs = {
  worktreeIds: string[]
  scriptsByWorktree: Record<string, WorktreeScriptsEntry>
  dispose: (ptyId: string) => void
}

export function disposeWorktreeCachedSidebarTerminals(
  args: DisposeWorktreeCachedSidebarTerminalsArgs
): void {
  for (const wtId of args.worktreeIds) {
    const entry = args.scriptsByWorktree[wtId]
    if (!entry) {
      continue
    }
    if (entry.run.ptyId) {
      args.dispose(entry.run.ptyId)
    }
    if (entry.setup.ptyId) {
      args.dispose(entry.setup.ptyId)
    }
  }
}
