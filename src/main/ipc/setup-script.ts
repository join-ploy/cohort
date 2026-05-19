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
import { LocalPtyProvider } from '../providers/local-pty-provider'
import type { Store } from '../persistence'
import { buildSelfTerminatingScriptCommand } from '../../shared/setup-runner-command'
import type {
  SetupExitedEvent,
  SetupStartedEvent,
  SetupStartResult,
  SetupStopResult
} from '../../shared/script-types'
import { parseWorktreeId } from './worktree-logic'
import { registerPty, unregisterPty } from '../memory/pty-registry'

import { getLocalPtyProvider, getSshPtyProvider } from './pty'

export type { SetupStartResult, SetupStopResult } from '../../shared/script-types'

type SetupPtyEntry = {
  ptyId: string
  generation: number
  // Why: captured at spawn time so app-quit cleanup can route shutdown to the
  // right provider without needing the store (which may already be torn down).
  // null means the local provider.
  connectionId: string | null
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

// Why: SSH-backed PTYs don't go through LocalPtyProvider's orphan-sweep, so
// the exempt set is only meaningful for the local provider. These helpers
// keep the call sites tight, accept null so the worktree-delete + app-quit
// branches can drop their own provider guard.
const markPtyOrphanExempt = (p: IPtyProvider | null, id: string): void =>
  void (p instanceof LocalPtyProvider && p.markPtyExemptFromOrphanKill(id))
const unmarkPtyOrphanExempt = (p: IPtyProvider | null, id: string): void =>
  void (p instanceof LocalPtyProvider && p.unmarkPtyExemptFromOrphanKill(id))

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

  // Why: setup is only valid for worktrees created via `git worktree add`. The
  // primary working tree's path equals the repo's root path; reject it before
  // looking up scripts.setup so a configured script can't accidentally run on
  // the user's primary checkout.
  if (worktreePath === repo.path) {
    return { ok: false, reason: 'primary-worktree' }
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
    unregisterPty(prior.ptyId)
    unmarkPtyOrphanExempt(provider, prior.ptyId)
    broadcast('setup:exited', {
      repoId,
      worktreeId: args.worktreeId,
      code: SIGINT_EXIT_CODE
    })
  }

  // Why: createSetupRunnerScript wraps the user-authored shell text so non-zero
  // exits propagate and ORCA_WORKTREE_PATH is set before exec — same shape as
  // the run-script path uses for createRunRunnerScript. workspaceName becomes
  // $CONDUCTOR_WORKSPACE_NAME inside the wrapper.
  const workspaceName = deps.store.getWorktreeMeta(args.worktreeId)?.workspaceName
  const wrapped = createSetupRunnerScript(repo, worktreePath, script, workspaceName)
  const generation = nextGen()
  // Why: self-terminating wrapper exits the parent shell when the runner exits,
  // so node-pty's onExit fires and setup:exited is broadcast. Without this the
  // shell prompt returns and the lifecycle dot would pulse forever.
  const command = buildSelfTerminatingScriptCommand(
    wrapped.runnerScriptPath,
    process.platform === 'win32' ? 'windows' : 'posix'
  )

  let spawned: { id: string; pid?: number | null }
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

  set(args.worktreeId, {
    ptyId: spawned.id,
    generation,
    connectionId: repo.connectionId ?? null
  })

  // Why: attribute this PTY to its worktree in the memory collector. Without
  // this, the collector falls back to ORPHAN_WORKTREE_ID for setup scripts.
  // SSH-backed PTYs run on a remote host so their pid is meaningless locally;
  // registerPty tolerates null and the collector ignores remote entries.
  registerPty({
    ptyId: spawned.id,
    worktreeId: args.worktreeId,
    sessionId: null,
    paneKey: null,
    pid:
      typeof spawned.pid === 'number' && Number.isFinite(spawned.pid) && spawned.pid > 0
        ? spawned.pid
        : null
  })

  // Why: shield this PTY from killOrphanedPtys, which sweeps any PTY whose
  // load-generation tag is stale after a renderer reload. Setup PTYs are
  // tagged at spawn time and never re-tagged, so without this they would be
  // swept on the first reload after the setup starts.
  markPtyOrphanExempt(provider, spawned.id)

  const unsubscribe = provider.onExit((payload) => {
    if (payload.id !== spawned.id) {
      return
    }
    unsubscribe()
    clearIfMatches(args.worktreeId, spawned.id, generation)
    unregisterPty(spawned.id)
    unmarkPtyOrphanExempt(provider, spawned.id)
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
  unregisterPty(entry.ptyId)
  unmarkPtyOrphanExempt(provider, entry.ptyId)
  broadcast('setup:exited', {
    repoId,
    worktreeId: args.worktreeId,
    code: SIGINT_EXIT_CODE
  })
  return { ok: true }
}

// Why: invoked from the worktree-deletion path. Setup registry is keyed by
// worktreeId — the lookup is direct, no sibling-ownership check needed.
// Best-effort shutdown so a stale backend doesn't block the registry purge
// or the renderer's state flip. Must run before git-level removal so the
// PTY's cwd still exists at shutdown time.
export async function killSetupForWorktree(
  args: { worktreeId: string },
  deps: SetupIpcDeps
): Promise<void> {
  const entry = get(args.worktreeId)
  if (!entry) {
    return
  }

  let repoId: string
  try {
    repoId = parseWorktreeId(args.worktreeId).repoId
  } catch {
    // Defensive: registry entries arise from successfully parsed ids, but the
    // delete path may pass through malformed ids in rare error paths.
    repoId = args.worktreeId.split('::')[0] ?? ''
  }

  const repo = deps.store.getRepo(repoId)
  const provider = getProviderForConnection(repo?.connectionId)
  if (provider) {
    try {
      await provider.shutdown(entry.ptyId, { immediate: true })
    } catch (err) {
      console.warn(
        `[setup-script] shutdown of ${entry.ptyId} during worktree-delete failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  clearIfMatches(args.worktreeId, entry.ptyId, entry.generation)
  unregisterPty(entry.ptyId)
  unmarkPtyOrphanExempt(provider, entry.ptyId)
  broadcast('setup:exited', {
    repoId,
    worktreeId: args.worktreeId,
    code: SIGINT_EXIT_CODE
  })
}

// Why: app-quit cleanup. The renderer broadcasts (setup:exited) must fire while
// BrowserWindow is still alive, which means we have to run before will-quit's
// killAllPty bulk teardown. provider.shutdown(..., {immediate:true}) is more
// deterministic than killAllPty's bare proc.kill() — it disposes node-pty
// listeners and clears the local provider's PTY map atomically.
//
// SSH-backed entries route to their stored sshProvider; if the SSH transport
// is already torn down by quit time, the shutdown call is best-effort and the
// catch keeps cleanup of the remaining entries moving.
export async function killAllSetupScripts(): Promise<void> {
  // Why: snapshot first because provider.shutdown's onExit handler clears
  // entries from setupPtyByWorktree concurrently — iterating the live map
  // would skip entries that disappeared mid-loop.
  const snapshot = [...setupPtyByWorktree.entries()]
  await Promise.all(
    snapshot.map(async ([worktreeId, entry]) => {
      const provider = getProviderForConnection(entry.connectionId)
      if (provider) {
        try {
          await provider.shutdown(entry.ptyId, { immediate: true })
        } catch (err) {
          console.warn(
            `[setup-script] shutdown of ${entry.ptyId} during app-quit failed: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }
      unregisterPty(entry.ptyId)
      unmarkPtyOrphanExempt(provider, entry.ptyId)
      setupPtyByWorktree.delete(worktreeId)
    })
  )
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
