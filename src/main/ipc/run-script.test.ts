/* eslint-disable max-lines -- Why: keeps the registry, handleRunStart, and
handleRunStop suites together so a regression in any one path is caught
against the full IPC surface instead of being split across files. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getLocalPtyProviderMock,
  getSshPtyProviderMock,
  getEffectiveHooksMock,
  createRunRunnerScriptMock,
  getAllWindowsMock,
  registerPtyMock,
  unregisterPtyMock
} = vi.hoisted(() => ({
  getLocalPtyProviderMock: vi.fn(),
  getSshPtyProviderMock: vi.fn(),
  getEffectiveHooksMock: vi.fn(),
  createRunRunnerScriptMock: vi.fn(),
  getAllWindowsMock: vi.fn(),
  registerPtyMock: vi.fn(),
  unregisterPtyMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn()
  },
  BrowserWindow: {
    getAllWindows: getAllWindowsMock
  }
}))

vi.mock('./pty', () => ({
  getLocalPtyProvider: getLocalPtyProviderMock,
  getSshPtyProvider: getSshPtyProviderMock
}))

vi.mock('../hooks', () => ({
  createRunRunnerScript: createRunRunnerScriptMock,
  getEffectiveHooks: getEffectiveHooksMock
}))

vi.mock('../memory/pty-registry', () => ({
  registerPty: registerPtyMock,
  unregisterPty: unregisterPtyMock
}))

import { _testing as registry, handleRunStart, handleRunStop } from './run-script'
import type { Repo } from '../../shared/types'

type ExitListener = (payload: { id: string; code: number }) => void

type FakeProvider = {
  spawn: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
  fireExit: (payload: { id: string; code: number }) => void
}

function makeProvider(opts?: { spawnIds?: string[] }): FakeProvider {
  const exitListeners = new Set<ExitListener>()
  const ids = opts?.spawnIds ? [...opts.spawnIds] : []
  let counter = 0
  const spawn = vi.fn(async () => {
    const id = ids.length > 0 ? (ids.shift() as string) : `pty-${++counter}`
    return { id }
  })
  const shutdown = vi.fn(async () => {})
  const onExit = vi.fn((cb: ExitListener) => {
    exitListeners.add(cb)
    return () => exitListeners.delete(cb)
  })
  return {
    spawn,
    shutdown,
    onExit,
    fireExit: (payload) => {
      // Snapshot to allow listeners to unsubscribe themselves during iteration.
      const snapshot = Array.from(exitListeners)
      for (const listener of snapshot) {
        listener(payload)
      }
    }
  }
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/test/repo',
    displayName: 'Test Repo',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  } as Repo
}

function makeStore(repo: Repo | null, workspaceName: string = 'wise_panther') {
  return {
    getRepo: vi.fn(() => repo ?? undefined),
    getWorktreeMeta: vi.fn(() => ({ workspaceName }))
  }
}

function makeWindow() {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }
}

describe('runPtyByRepo registry', () => {
  beforeEach(() => registry.clear())

  it('records and returns the live pty for a repo', () => {
    registry.set('repo-1', {
      ptyId: 'pty-A',
      worktreeId: 'wt-1',
      generation: 1,
      connectionId: null
    })
    expect(registry.get('repo-1')).toEqual({
      ptyId: 'pty-A',
      worktreeId: 'wt-1',
      generation: 1,
      connectionId: null
    })
  })

  it('returns null for an unknown repo', () => {
    expect(registry.get('missing')).toBeNull()
  })

  it('clearIfMatches only clears when generation matches', () => {
    registry.set('repo-1', {
      ptyId: 'pty-A',
      worktreeId: 'wt-1',
      generation: 1,
      connectionId: null
    })
    // Stale generation (e.g. an onExit from a previous PTY race) must not clear.
    registry.clearIfMatches('repo-1', 'pty-A', 0)
    expect(registry.get('repo-1')).not.toBeNull()
    // Matching generation clears.
    registry.clearIfMatches('repo-1', 'pty-A', 1)
    expect(registry.get('repo-1')).toBeNull()
  })

  it('clearIfMatches only clears when ptyId matches', () => {
    registry.set('repo-1', {
      ptyId: 'pty-A',
      worktreeId: 'wt-1',
      generation: 1,
      connectionId: null
    })
    // A PTY id that does not match the current entry must not clear it
    // (defends against onExit firing for a sibling PTY in another repo flow).
    registry.clearIfMatches('repo-1', 'pty-OTHER', 1)
    expect(registry.get('repo-1')).not.toBeNull()
  })

  it('nextGen returns strictly increasing values', () => {
    const a = registry.nextGen()
    const b = registry.nextGen()
    const c = registry.nextGen()
    expect(b).toBeGreaterThan(a)
    expect(c).toBeGreaterThan(b)
  })
})

describe('handleRunStart', () => {
  let provider: FakeProvider
  let win: ReturnType<typeof makeWindow>
  const repo = makeRepo()
  const worktreePath = '/test/repo/wt-1'
  const worktreeId = `${repo.id}::${worktreePath}`

  beforeEach(() => {
    registry.clear()
    provider = makeProvider({ spawnIds: ['pty-NEW'] })
    win = makeWindow()
    getLocalPtyProviderMock.mockReset().mockReturnValue(provider)
    getSshPtyProviderMock.mockReset().mockReturnValue(undefined)
    getAllWindowsMock.mockReset().mockReturnValue([win])
    getEffectiveHooksMock.mockReset().mockReturnValue({ scripts: { run: 'pnpm dev' } })
    createRunRunnerScriptMock.mockReset().mockReturnValue({
      runnerScriptPath: '/tmp/.git/orca/run-runner.sh',
      envVars: { ORCA_WORKTREE_PATH: worktreePath }
    })
    registerPtyMock.mockReset()
    unregisterPtyMock.mockReset()
  })

  it('returns no-run-script and does not spawn when scripts.run is empty', async () => {
    getEffectiveHooksMock.mockReturnValue({ scripts: {} })
    const store = makeStore(repo)

    const result = await handleRunStart({ repoId: repo.id, worktreeId }, { store: store as never })

    expect(result).toEqual({ ok: false, reason: 'no-run-script' })
    expect(provider.spawn).not.toHaveBeenCalled()
    expect(registry.get(repo.id)).toBeNull()
  })

  it('returns repo-not-found when the repo is missing', async () => {
    const store = makeStore(null)
    const result = await handleRunStart(
      { repoId: 'missing', worktreeId },
      { store: store as never }
    )
    expect(result).toEqual({ ok: false, reason: 'repo-not-found' })
    expect(provider.spawn).not.toHaveBeenCalled()
  })

  it('spawns when nothing is running and registers the new entry', async () => {
    const store = makeStore(repo)
    // Why: createRunRunnerScript is mocked at the test boundary, so its
    // returned envVars are what the spawn sees. Mirror the conductor block
    // the real wrapper produces so the spawn assertion below proves the
    // handler forwarded those values.
    createRunRunnerScriptMock.mockReturnValue({
      runnerScriptPath: '/tmp/.git/orca/run-runner.sh',
      envVars: {
        ORCA_WORKTREE_PATH: worktreePath,
        CONDUCTOR_ROOT_PATH: repo.path,
        CONDUCTOR_WORKSPACE_NAME: 'wise_panther'
      }
    })

    const result = await handleRunStart({ repoId: repo.id, worktreeId }, { store: store as never })

    expect(result).toEqual({ ok: true, ptyId: 'pty-NEW' })
    expect(provider.shutdown).not.toHaveBeenCalled()
    expect(provider.spawn).toHaveBeenCalledTimes(1)
    // Confirm the IPC handler called createRunRunnerScript with the
    // workspaceName drawn from getWorktreeMeta.
    expect(createRunRunnerScriptMock).toHaveBeenCalledWith(
      repo,
      worktreePath,
      'pnpm dev',
      'wise_panther'
    )
    const spawnArgs = provider.spawn.mock.calls[0][0] as {
      cwd?: string
      env?: Record<string, string>
      command?: string
    }
    expect(spawnArgs.cwd).toBe(worktreePath)
    expect(spawnArgs.env).toMatchObject({
      ORCA_WORKTREE_PATH: worktreePath,
      CONDUCTOR_ROOT_PATH: repo.path,
      CONDUCTOR_WORKSPACE_NAME: 'wise_panther'
    })
    expect(typeof spawnArgs.command).toBe('string')
    // The command must reference the wrapped runner script, not the raw user command.
    expect(spawnArgs.command).toContain('run-runner.sh')

    expect(registry.get(repo.id)).toMatchObject({ ptyId: 'pty-NEW', worktreeId })

    // Started event broadcast for renderer to flip the dot to amber.
    expect(win.webContents.send).toHaveBeenCalledWith('run:started', {
      repoId: repo.id,
      worktreeId,
      ptyId: 'pty-NEW'
    })

    // Why: the memory collector needs PTYs attributed to their worktree, or
    // they fall through to ORPHAN_WORKTREE_ID. The handler must registerPty
    // at spawn time with the spawned ptyId and worktreeId.
    expect(registerPtyMock).toHaveBeenCalledWith(
      expect.objectContaining({ ptyId: 'pty-NEW', worktreeId })
    )
  })

  it('kills the existing pty and broadcasts run:exited for the prior worktree before spawning a new one', async () => {
    const priorWorktreeId = `${repo.id}::/test/repo/wt-A`
    registry.set(repo.id, {
      ptyId: 'pty-OLD',
      worktreeId: priorWorktreeId,
      generation: 99,
      connectionId: null
    })

    const store = makeStore(repo)
    const result = await handleRunStart({ repoId: repo.id, worktreeId }, { store: store as never })

    expect(result).toEqual({ ok: true, ptyId: 'pty-NEW' })
    expect(provider.shutdown).toHaveBeenCalledTimes(1)
    expect(provider.shutdown).toHaveBeenCalledWith(
      'pty-OLD',
      expect.objectContaining({ immediate: true })
    )

    // run:exited for the prior worktree is sent BEFORE the spawn so the
    // renderer can paint the killed worktree's dot before the new one's.
    const sendCalls = win.webContents.send.mock.calls.map((c) => c[0])
    const exitedIdx = sendCalls.indexOf('run:exited')
    const startedIdx = sendCalls.indexOf('run:started')
    expect(exitedIdx).toBeGreaterThanOrEqual(0)
    expect(startedIdx).toBeGreaterThan(exitedIdx)
    expect(win.webContents.send).toHaveBeenCalledWith('run:exited', {
      repoId: repo.id,
      worktreeId: priorWorktreeId,
      code: 130
    })

    expect(registry.get(repo.id)).toMatchObject({ ptyId: 'pty-NEW', worktreeId })
  })

  it('generation guard: a stale onExit from a previous spawn does not clear the fresh entry', async () => {
    const store = makeStore(repo)

    // First spawn yields pty-A, second yields pty-B.
    provider = makeProvider({ spawnIds: ['pty-A', 'pty-B'] })
    getLocalPtyProviderMock.mockReturnValue(provider)

    const first = await handleRunStart({ repoId: repo.id, worktreeId }, { store: store as never })
    expect(first).toEqual({ ok: true, ptyId: 'pty-A' })

    const second = await handleRunStart({ repoId: repo.id, worktreeId }, { store: store as never })
    expect(second).toEqual({ ok: true, ptyId: 'pty-B' })
    expect(registry.get(repo.id)).toMatchObject({ ptyId: 'pty-B' })

    // Now the first PTY's onExit fires late. Without a generation guard this
    // would erase the registry entry for the LIVE pty-B, leaving the renderer
    // believing nothing is running while pty-B is still live.
    provider.fireExit({ id: 'pty-A', code: 0 })
    expect(registry.get(repo.id)).toMatchObject({ ptyId: 'pty-B' })
  })

  it('clears the registry and broadcasts run:exited when the live pty exits naturally', async () => {
    const store = makeStore(repo)
    await handleRunStart({ repoId: repo.id, worktreeId }, { store: store as never })

    win.webContents.send.mockClear()
    unregisterPtyMock.mockClear()
    provider.fireExit({ id: 'pty-NEW', code: 0 })

    expect(registry.get(repo.id)).toBeNull()
    expect(win.webContents.send).toHaveBeenCalledWith('run:exited', {
      repoId: repo.id,
      worktreeId,
      code: 0
    })
    // Why: the memory collector must stop attributing memory to defunct PTYs.
    expect(unregisterPtyMock).toHaveBeenCalledWith('pty-NEW')
  })

  it('uses the SSH pty provider when the repo has a connectionId', async () => {
    const sshRepo = makeRepo({ connectionId: 'remote-1' })
    const sshProvider = makeProvider({ spawnIds: ['ssh-pty'] })
    getSshPtyProviderMock.mockReturnValue(sshProvider)
    const store = makeStore(sshRepo)

    const result = await handleRunStart(
      { repoId: sshRepo.id, worktreeId },
      { store: store as never }
    )

    expect(result).toEqual({ ok: true, ptyId: 'ssh-pty' })
    expect(sshProvider.spawn).toHaveBeenCalledTimes(1)
    expect(provider.spawn).not.toHaveBeenCalled()
  })

  it('dedupes concurrent starts for the same repo so spawn runs once', async () => {
    // Why: autostart + user Cmd+R could otherwise both observe prior===null,
    // both spawn, both set() — orphaning the loser's PTY.
    const store = makeStore(repo)
    let release: (v: { id: string }) => void = () => {}
    provider.spawn.mockReset().mockImplementationOnce(() => new Promise((r) => (release = r)))
    const a = handleRunStart({ repoId: repo.id, worktreeId }, { store: store as never })
    const b = handleRunStart({ repoId: repo.id, worktreeId }, { store: store as never })
    release({ id: 'pty-NEW' })
    const ok = { ok: true, ptyId: 'pty-NEW' }
    expect(await Promise.all([a, b])).toEqual([ok, ok])
    expect(provider.spawn).toHaveBeenCalledTimes(1)
    expect(registry.get(repo.id)).toMatchObject({ ptyId: 'pty-NEW', worktreeId })
  })

  it('returns spawn-failed, leaves registry clean, and a subsequent start succeeds', async () => {
    // Why: structured failure (vs unstructured invoke rejection) lets the
    // renderer react and keeps the registry clean for retries.
    const store = makeStore(repo)
    provider.spawn.mockReset().mockRejectedValueOnce(new Error('boom'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await handleRunStart({ repoId: repo.id, worktreeId }, { store: store as never })
    errSpy.mockRestore()
    expect(result).toEqual({ ok: false, reason: 'spawn-failed' })
    expect(registry.get(repo.id)).toBeNull()
    expect(win.webContents.send).not.toHaveBeenCalled()
    // Retry succeeds — proves the in-flight map released after failure.
    provider.spawn.mockResolvedValueOnce({ id: 'pty-RECOVER' })
    const retry = await handleRunStart({ repoId: repo.id, worktreeId }, { store: store as never })
    expect(retry).toEqual({ ok: true, ptyId: 'pty-RECOVER' })
  })
})

describe('handleRunStop', () => {
  let provider: FakeProvider
  let win: ReturnType<typeof makeWindow>
  const repo = makeRepo()
  const worktreePath = '/test/repo/wt-1'
  const worktreeId = `${repo.id}::${worktreePath}`

  beforeEach(() => {
    registry.clear()
    provider = makeProvider()
    win = makeWindow()
    getLocalPtyProviderMock.mockReset().mockReturnValue(provider)
    getSshPtyProviderMock.mockReset().mockReturnValue(undefined)
    getAllWindowsMock.mockReset().mockReturnValue([win])
    registerPtyMock.mockReset()
    unregisterPtyMock.mockReset()
  })

  it('returns ok:false when nothing is running for the repo', async () => {
    const store = makeStore(repo)
    const result = await handleRunStop({ repoId: repo.id }, { store: store as never })
    expect(result).toEqual({ ok: false, reason: 'not-running' })
    expect(provider.shutdown).not.toHaveBeenCalled()
  })

  it('shuts down the registered pty, clears the registry, and broadcasts run:exited', async () => {
    registry.set(repo.id, {
      ptyId: 'pty-LIVE',
      worktreeId,
      generation: 7,
      connectionId: null
    })
    const store = makeStore(repo)

    const result = await handleRunStop({ repoId: repo.id }, { store: store as never })

    expect(result).toEqual({ ok: true })
    expect(provider.shutdown).toHaveBeenCalledWith(
      'pty-LIVE',
      expect.objectContaining({ immediate: true })
    )
    expect(registry.get(repo.id)).toBeNull()
    expect(unregisterPtyMock).toHaveBeenCalledWith('pty-LIVE')
    expect(win.webContents.send).toHaveBeenCalledWith('run:exited', {
      repoId: repo.id,
      worktreeId,
      code: 130
    })
  })
})
