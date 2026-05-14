// Why: per-repo run-script and per-worktree setup-script IPC contracts shared
// between main, preload, and renderer. Declared here (not in
// src/main/ipc/run-script.ts or setup-script.ts) so the renderer slice and
// preload bridge can import the result/event shapes without pulling in
// main-process modules. See docs/plans/2026-05-14-per-repo-run-script-design.md.

// ─── Run script (per-repo, single instance) ─────────────────────────

export type RunStartArgs = {
  repoId: string
  worktreeId: string
}

export type RunStopArgs = {
  repoId: string
}

export type RunStartFailureReason =
  | 'no-run-script'
  | 'repo-not-found'
  | 'invalid-worktree'
  | 'no-provider'
  | 'spawn-failed'

export type RunStartResult =
  | { ok: true; ptyId: string }
  | { ok: false; reason: RunStartFailureReason }

export type RunStopFailureReason = 'not-running' | 'no-provider'

export type RunStopResult = { ok: true } | { ok: false; reason: RunStopFailureReason }

export type RunStartedEvent = {
  repoId: string
  worktreeId: string
  ptyId: string
}

export type RunExitedEvent = {
  repoId: string
  worktreeId: string
  code: number
}

// ─── Setup script (per-worktree, single instance) ───────────────────
// Why: setup is per-worktree (not per-repo) so two worktrees in the same repo
// can each have their own live setup PTY without one killing the other. The
// registry key is the worktreeId; repoId is derived for broadcast events.

export type SetupStartArgs = {
  worktreeId: string
}

export type SetupStopArgs = {
  worktreeId: string
}

export type SetupStartFailureReason =
  | 'no-setup-script'
  | 'repo-not-found'
  | 'invalid-worktree'
  | 'no-provider'
  | 'spawn-failed'
  // Why: setup is reserved for worktrees created via `git worktree add`. The
  // primary working tree must never run setup — it's the user's checkout.
  | 'primary-worktree'

export type SetupStartResult =
  | { ok: true; ptyId: string }
  | { ok: false; reason: SetupStartFailureReason }

export type SetupStopFailureReason = 'not-running' | 'no-provider'

export type SetupStopResult = { ok: true } | { ok: false; reason: SetupStopFailureReason }

export type SetupStartedEvent = {
  repoId: string
  worktreeId: string
  ptyId: string
}

export type SetupExitedEvent = {
  repoId: string
  worktreeId: string
  code: number
}
