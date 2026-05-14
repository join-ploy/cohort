// Why: per-repo single-instance run-script registry + IPC handlers. The design
// (docs/plans/2026-05-14-per-repo-run-script-design.md "PTY ownership") requires
// at most one run PTY per repo so that pressing Cmd+R in worktree B kills any
// in-flight run in worktree A. The generation counter prevents a stale onExit
// (from a PTY killed during a fast kill+respawn cycle) from clearing the fresh
// entry.

import { BrowserWindow, ipcMain } from 'electron'

import { createRunRunnerScript, getEffectiveHooks } from '../hooks'
import type { IPtyProvider } from '../providers/types'
import type { Store } from '../persistence'
import { buildSetupRunnerCommand } from '../../shared/setup-runner-command'
import type {
  RunExitedEvent,
  RunStartedEvent,
  RunStartResult,
  RunStopResult
} from '../../shared/script-types'
import { parseWorktreeId } from './worktree-logic'

import { getLocalPtyProvider, getSshPtyProvider } from './pty'

// Why: re-export the IPC contract types so existing main-side importers
// (and the test file) keep their import paths stable while the canonical
// declarations now live in src/shared for renderer + preload reuse.
export type { RunStartResult, RunStopResult } from '../../shared/script-types'

type RunPtyEntry = {
  ptyId: string
  worktreeId: string
  generation: number
}

const runPtyByRepo = new Map<string, RunPtyEntry>()
let nextGeneration = 0

// Why: serialize concurrent handleRunStart calls per repo so two near-simultaneous
// invocations (e.g. autostart hook + user Cmd+R, or an IPC retry) cannot both
// observe the same `prior`, both shutdown+spawn, and both call `set()` —
// leaving the loser's PTY orphaned with an onExit that will never match. The
// second caller awaits the first's outcome, then proceeds against a clean
// registry.
const inFlightStartByRepo = new Map<string, Promise<RunStartResult>>()

function get(repoId: string): RunPtyEntry | null {
  return runPtyByRepo.get(repoId) ?? null
}

function set(repoId: string, entry: RunPtyEntry): void {
  runPtyByRepo.set(repoId, entry)
}

function clearIfMatches(repoId: string, ptyId: string, generation: number): void {
  const cur = runPtyByRepo.get(repoId)
  if (cur && cur.ptyId === ptyId && cur.generation === generation) {
    runPtyByRepo.delete(repoId)
  }
}

function nextGen(): number {
  return ++nextGeneration
}

function clear(): void {
  runPtyByRepo.clear()
  inFlightStartByRepo.clear()
}

// Why: exported under `_testing` to discourage callers outside this module from
// mutating registry state directly. The IPC handlers in this file are the
// production surface; tests poke the primitives.
export const _testing = { get, set, clearIfMatches, clear, nextGen }

// SIGINT (Ctrl-C) terminates with this code on POSIX shells; reuse the same
// convention for renderer-initiated stops so the dot consistently flips to the
// failure color when the user kills a run.
const SIGINT_EXIT_CODE = 130

type RunIpcDeps = {
  store: Store
}

function broadcast(
  channel: 'run:started' | 'run:exited',
  payload: RunStartedEvent | RunExitedEvent
): void {
  // Why: the run lifecycle dot must reach every visible Orca window, not only the
  // most-recently-focused one. Multiple windows attached to the same main process
  // each render the same right sidebar, so a per-window send would leave the
  // others stuck on stale state.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

function getProviderForConnection(connectionId: string | null | undefined): IPtyProvider | null {
  if (!connectionId) {
    return getLocalPtyProvider()
  }
  return getSshPtyProvider(connectionId) ?? null
}

export async function handleRunStart(
  args: { repoId: string; worktreeId: string },
  deps: RunIpcDeps
): Promise<RunStartResult> {
  // Why: dedupe concurrent starts for the same repo so the kill+spawn sequence
  // is serialized. The follower awaits the leader's promise rather than racing
  // to read `prior` before the leader's `set()` lands.
  const inFlight = inFlightStartByRepo.get(args.repoId)
  if (inFlight) {
    return inFlight
  }
  const promise = runStartLocked(args, deps).finally(() => {
    inFlightStartByRepo.delete(args.repoId)
  })
  inFlightStartByRepo.set(args.repoId, promise)
  return promise
}

async function runStartLocked(
  args: { repoId: string; worktreeId: string },
  deps: RunIpcDeps
): Promise<RunStartResult> {
  const repo = deps.store.getRepo(args.repoId)
  if (!repo) {
    return { ok: false, reason: 'repo-not-found' }
  }

  let worktreePath: string
  try {
    const parsed = parseWorktreeId(args.worktreeId)
    worktreePath = parsed.worktreePath
  } catch {
    return { ok: false, reason: 'invalid-worktree' }
  }

  const hooks = getEffectiveHooks(repo, worktreePath)
  const script = hooks?.scripts.run?.trim()
  if (!script) {
    return { ok: false, reason: 'no-run-script' }
  }

  const provider = getProviderForConnection(repo.connectionId)
  if (!provider) {
    return { ok: false, reason: 'no-provider' }
  }

  // Why: kill any prior PTY for this repo BEFORE spawning so the renderer paints
  // the killed worktree's dot first, then the fresh worktree's amber dot. The
  // previous worktree's tab/scrollback is preserved on the renderer side; we
  // only reach here on user-driven Cmd+R, so the in-flight run is being
  // intentionally replaced.
  const prior = get(args.repoId)
  if (prior) {
    try {
      await provider.shutdown(prior.ptyId, { immediate: true })
    } catch (err) {
      console.warn(
        `[run-script] shutdown of prior pty ${prior.ptyId} failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    clearIfMatches(args.repoId, prior.ptyId, prior.generation)
    broadcast('run:exited', {
      repoId: args.repoId,
      worktreeId: prior.worktreeId,
      code: SIGINT_EXIT_CODE
    })
  }

  // Why: wrap the user-authored shell text the same way setup does, so non-zero
  // exits propagate and ORCA_WORKTREE_PATH is set before exec. The wrapped
  // script is launched via `command`, which the local PTY provider streams into
  // the freshly-spawned shell after it signals shell-ready. workspaceName
  // becomes $CONDUCTOR_WORKSPACE_NAME inside the wrapper.
  const workspaceName = deps.store.getWorktreeMeta(args.worktreeId)?.workspaceName
  const wrapped = createRunRunnerScript(repo, worktreePath, script, workspaceName)
  const generation = nextGen()
  const command = buildSetupRunnerCommand(
    wrapped.runnerScriptPath,
    process.platform === 'win32' ? 'windows' : 'posix'
  )

  // Why: a spawn failure must surface as a structured result, not a thrown
  // rejection — the IPC handler's caller would otherwise see an unstructured
  // invoke rejection while the renderer has no `run:started` event to react
  // to. Return `spawn-failed` so the caller can present an error and the
  // registry stays clean (no `set()` was called).
  let spawned: { id: string }
  try {
    spawned = await provider.spawn({
      cols: 80,
      rows: 24,
      cwd: worktreePath,
      env: wrapped.envVars,
      command
    })
  } catch (err) {
    console.error(
      `[run-script] spawn failed for repo ${args.repoId}: ${err instanceof Error ? err.message : String(err)}`
    )
    return { ok: false, reason: 'spawn-failed' }
  }

  set(args.repoId, { ptyId: spawned.id, worktreeId: args.worktreeId, generation })

  // Why: filter the global onExit by ptyId. The clearIfMatches guard then makes
  // the late-arriving exit of a superseded PTY a no-op, preventing it from
  // erasing the live registry entry.
  const unsubscribe = provider.onExit((payload) => {
    if (payload.id !== spawned.id) {
      return
    }
    unsubscribe()
    clearIfMatches(args.repoId, spawned.id, generation)
    broadcast('run:exited', {
      repoId: args.repoId,
      worktreeId: args.worktreeId,
      code: payload.code
    })
  })

  broadcast('run:started', {
    repoId: args.repoId,
    worktreeId: args.worktreeId,
    ptyId: spawned.id
  })

  return { ok: true, ptyId: spawned.id }
}

export async function handleRunStop(
  args: { repoId: string },
  deps: RunIpcDeps
): Promise<RunStopResult> {
  const entry = get(args.repoId)
  if (!entry) {
    return { ok: false, reason: 'not-running' }
  }

  const repo = deps.store.getRepo(args.repoId)
  // Why: the registry is the source of truth for "what is running"; if the repo
  // record vanished mid-flight (rare but possible during repo removal) we still
  // want to attempt the local-provider shutdown rather than leaking the PTY.
  const provider = getProviderForConnection(repo?.connectionId)
  if (!provider) {
    return { ok: false, reason: 'no-provider' }
  }

  try {
    await provider.shutdown(entry.ptyId, { immediate: true })
  } catch (err) {
    console.warn(
      `[run-script] shutdown failed for ${entry.ptyId}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  clearIfMatches(args.repoId, entry.ptyId, entry.generation)
  broadcast('run:exited', {
    repoId: args.repoId,
    worktreeId: entry.worktreeId,
    code: SIGINT_EXIT_CODE
  })
  return { ok: true }
}

// Why: invoked from the worktree-deletion path. The run registry is keyed by
// repoId and might be owned by a sibling worktree of the same repo; only kill
// when this worktree owns the entry. Best-effort shutdown — a backend that
// has already lost the session must not block the registry purge or the
// renderer state flip. Must run before git-level removal so the PTY's cwd
// still exists at shutdown time.
export async function killRunForWorktree(
  args: { repoId: string; worktreeId: string },
  deps: RunIpcDeps
): Promise<void> {
  const entry = get(args.repoId)
  if (!entry || entry.worktreeId !== args.worktreeId) {
    return
  }

  const repo = deps.store.getRepo(args.repoId)
  const provider = getProviderForConnection(repo?.connectionId)
  if (provider) {
    try {
      await provider.shutdown(entry.ptyId, { immediate: true })
    } catch (err) {
      console.warn(
        `[run-script] shutdown of ${entry.ptyId} during worktree-delete failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  clearIfMatches(args.repoId, entry.ptyId, entry.generation)
  broadcast('run:exited', {
    repoId: args.repoId,
    worktreeId: args.worktreeId,
    code: SIGINT_EXIT_CODE
  })
}

export function registerRunScriptIpc(deps: RunIpcDeps): void {
  ipcMain.removeHandler('run:start')
  ipcMain.removeHandler('run:stop')
  ipcMain.handle('run:start', (_event, args: { repoId: string; worktreeId: string }) =>
    handleRunStart(args, deps)
  )
  ipcMain.handle('run:stop', (_event, args: { repoId: string }) => handleRunStop(args, deps))
}
