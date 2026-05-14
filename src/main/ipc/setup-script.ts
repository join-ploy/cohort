// Why: per-worktree single-instance setup-script registry + IPC handlers.
// Setup is per-worktree (not per-repo, in contrast to run) so two worktrees
// in the same repo can each have their own live setup PTY without one killing
// the other — re-running setup in worktree A must leave worktree B alone.
// See docs/plans/2026-05-14-per-repo-run-script-design.md "Setup script
// lifecycle change". The generation counter prevents a stale onExit from a
// PTY killed during a fast kill+respawn cycle from clearing the fresh entry.

import { BrowserWindow, ipcMain } from 'electron'

import { createSetupRunnerScript, getEffectiveHooks } from '../hooks'
import type { IPtyProvider } from '../providers/types'
import type { Store } from '../persistence'
import { buildSetupRunnerCommand } from '../../shared/setup-runner-command'
import type {
  SetupExitedEvent,
  SetupStartedEvent,
  SetupStartResult,
  SetupStopResult
} from '../../shared/script-types'
import { parseWorktreeId } from './worktree-logic'

import { getLocalPtyProvider, getSshPtyProvider } from './pty'

export type { SetupStartResult, SetupStopResult } from '../../shared/script-types'

type SetupPtyEntry = {
  ptyId: string
  generation: number
}

const setupPtyByWorktree = new Map<string, SetupPtyEntry>()
let nextGeneration = 0

// Why: serialize concurrent handleSetupStart calls per worktree so a fast
// auto-create + user-clicks-Re-run sequence cannot both observe the same
// `prior`, both shutdown+spawn, and both call `set()` — leaving the loser's
// PTY orphaned. Keyed by worktreeId because setup is per-worktree.
const inFlightStartByWorktree = new Map<string, Promise<SetupStartResult>>()

function get(worktreeId: string): SetupPtyEntry | null {
  return setupPtyByWorktree.get(worktreeId) ?? null
}

function set(worktreeId: string, entry: SetupPtyEntry): void {
  setupPtyByWorktree.set(worktreeId, entry)
}

function clearIfMatches(worktreeId: string, ptyId: string, generation: number): void {
  const cur = setupPtyByWorktree.get(worktreeId)
  if (cur && cur.ptyId === ptyId && cur.generation === generation) {
    setupPtyByWorktree.delete(worktreeId)
  }
}

function nextGen(): number {
  return ++nextGeneration
}

function clear(): void {
  setupPtyByWorktree.clear()
  inFlightStartByWorktree.clear()
}

export const _testing = { get, set, clearIfMatches, clear, nextGen }

const SIGINT_EXIT_CODE = 130

type SetupIpcDeps = {
  store: Store
}

function broadcast(
  channel: 'setup:started' | 'setup:exited',
  payload: SetupStartedEvent | SetupExitedEvent
): void {
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

export async function handleSetupStart(
  args: { worktreeId: string },
  deps: SetupIpcDeps
): Promise<SetupStartResult> {
  const inFlight = inFlightStartByWorktree.get(args.worktreeId)
  if (inFlight) {
    return inFlight
  }
  const promise = setupStartLocked(args, deps).finally(() => {
    inFlightStartByWorktree.delete(args.worktreeId)
  })
  inFlightStartByWorktree.set(args.worktreeId, promise)
  return promise
}

// Why: non-IPC entrypoint for callsites in the auto-create flow (orca-runtime,
// worktree-remote) — they call this directly without going through ipcMain.
// Deps-first signature mirrors how those modules already pass their store.
// Returns the same SetupStartResult so create-flow callers can log spawn
// failures without throwing.
export function runSetup(
  deps: SetupIpcDeps,
  args: { worktreeId: string }
): Promise<SetupStartResult> {
  return handleSetupStart(args, deps)
}

async function setupStartLocked(
  args: { worktreeId: string },
  deps: SetupIpcDeps
): Promise<SetupStartResult> {
  let repoId: string
  let worktreePath: string
  try {
    const parsed = parseWorktreeId(args.worktreeId)
    repoId = parsed.repoId
    worktreePath = parsed.worktreePath
  } catch {
    return { ok: false, reason: 'invalid-worktree' }
  }

  const repo = deps.store.getRepo(repoId)
  if (!repo) {
    return { ok: false, reason: 'repo-not-found' }
  }

  const hooks = getEffectiveHooks(repo, worktreePath)
  const script = hooks?.scripts.setup?.trim()
  if (!script) {
    return { ok: false, reason: 'no-setup-script' }
  }

  const provider = getProviderForConnection(repo.connectionId)
  if (!provider) {
    return { ok: false, reason: 'no-provider' }
  }

  const prior = get(args.worktreeId)
  if (prior) {
    try {
      await provider.shutdown(prior.ptyId, { immediate: true })
    } catch (err) {
      console.warn(
        `[setup-script] shutdown of prior pty ${prior.ptyId} failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    clearIfMatches(args.worktreeId, prior.ptyId, prior.generation)
    broadcast('setup:exited', {
      repoId,
      worktreeId: args.worktreeId,
      code: SIGINT_EXIT_CODE
    })
  }

  // Why: createSetupRunnerScript wraps the user-authored shell text so non-zero
  // exits propagate and ORCA_WORKTREE_PATH is set before exec — same shape as
  // the run-script path uses for createRunRunnerScript.
  const wrapped = createSetupRunnerScript(repo, worktreePath, script)
  const generation = nextGen()
  const command = buildSetupRunnerCommand(
    wrapped.runnerScriptPath,
    process.platform === 'win32' ? 'windows' : 'posix'
  )

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
      `[setup-script] spawn failed for worktree ${args.worktreeId}: ${err instanceof Error ? err.message : String(err)}`
    )
    return { ok: false, reason: 'spawn-failed' }
  }

  set(args.worktreeId, { ptyId: spawned.id, generation })

  const unsubscribe = provider.onExit((payload) => {
    if (payload.id !== spawned.id) {
      return
    }
    unsubscribe()
    clearIfMatches(args.worktreeId, spawned.id, generation)
    broadcast('setup:exited', {
      repoId,
      worktreeId: args.worktreeId,
      code: payload.code
    })
  })

  broadcast('setup:started', {
    repoId,
    worktreeId: args.worktreeId,
    ptyId: spawned.id
  })

  return { ok: true, ptyId: spawned.id }
}

export async function handleSetupStop(
  args: { worktreeId: string },
  deps: SetupIpcDeps
): Promise<SetupStopResult> {
  const entry = get(args.worktreeId)
  if (!entry) {
    return { ok: false, reason: 'not-running' }
  }

  let repoId: string
  try {
    repoId = parseWorktreeId(args.worktreeId).repoId
  } catch {
    // Why: registry only contains entries we've previously parsed successfully,
    // so this branch is defensive — fall back to deriving repoId from the raw id.
    repoId = args.worktreeId.split('::')[0] ?? ''
  }

  const repo = deps.store.getRepo(repoId)
  // Why: the registry is the source of truth for "what is running"; if the repo
  // record vanished mid-flight (rare) we still attempt local-provider shutdown
  // rather than leaking the PTY.
  const provider = getProviderForConnection(repo?.connectionId)
  if (!provider) {
    return { ok: false, reason: 'no-provider' }
  }

  try {
    await provider.shutdown(entry.ptyId, { immediate: true })
  } catch (err) {
    console.warn(
      `[setup-script] shutdown failed for ${entry.ptyId}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  clearIfMatches(args.worktreeId, entry.ptyId, entry.generation)
  broadcast('setup:exited', {
    repoId,
    worktreeId: args.worktreeId,
    code: SIGINT_EXIT_CODE
  })
  return { ok: true }
}

export function registerSetupScriptIpc(deps: SetupIpcDeps): void {
  ipcMain.removeHandler('setup:start')
  ipcMain.removeHandler('setup:stop')
  ipcMain.handle('setup:start', (_event, args: { worktreeId: string }) =>
    handleSetupStart(args, deps)
  )
  ipcMain.handle('setup:stop', (_event, args: { worktreeId: string }) =>
    handleSetupStop(args, deps)
  )
}
