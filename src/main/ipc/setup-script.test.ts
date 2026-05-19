/* eslint-disable max-lines -- Why: keeps the registry, handleSetupStart,
runSetup, and handleSetupStop suites together so a regression in any one
path is caught against the full IPC surface instead of being split across
files. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getLocalPtyProviderMock,
  getSshPtyProviderMock,
  getEffectiveHooksMock,
  createSetupRunnerScriptMock,
  getAllWindowsMock,
  registerPtyMock,
  unregisterPtyMock
} = vi.hoisted(() => ({
  getLocalPtyProviderMock: vi.fn(),
  getSshPtyProviderMock: vi.fn(),
  getEffectiveHooksMock: vi.fn(),
  createSetupRunnerScriptMock: vi.fn(),
  getAllWindowsMock: vi.fn(),
  registerPtyMock: vi.fn(),
  unregisterPtyMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: { getAllWindows: getAllWindowsMock }
}))

vi.mock('./pty', () => ({
  getLocalPtyProvider: getLocalPtyProviderMock,
  getSshPtyProvider: getSshPtyProviderMock
}))

vi.mock('../hooks', () => ({
  createSetupRunnerScript: createSetupRunnerScriptMock,
  getEffectiveHooks: getEffectiveHooksMock
}))

vi.mock('../memory/pty-registry', () => ({
  registerPty: registerPtyMock,
  unregisterPty: unregisterPtyMock
}))

import { _testing as registry, handleSetupStart, handleSetupStop, runSetup } from './setup-script'
import {
  type FakeProvider,
  makeMultiRepoStore,
  makeProvider,
  makeRepo,
  makeWindow
} from './script-ipc-test-fakes'

describe('setupPtyByWorktree registry', () => {
  beforeEach(() => registry.clear())

  it('records and clears with generation + ptyId guards', () => {
    const entry = { ptyId: 'pty-A', generation: 1, connectionId: null }
    registry.set('wt-A', entry)
    expect(registry.get('wt-A')).toEqual(entry)
    expect(registry.get('missing')).toBeNull()
    // Stale generation (e.g. an onExit from a previous PTY race) must not clear.
    registry.clearIfMatches('wt-A', 'pty-A', 0)
    expect(registry.get('wt-A')).not.toBeNull()
    // PTY id mismatch must not clear (defends against onExit from a sibling PTY).
    registry.clearIfMatches('wt-A', 'pty-OTHER', 1)
    expect(registry.get('wt-A')).not.toBeNull()
    registry.clearIfMatches('wt-A', 'pty-A', 1)
    expect(registry.get('wt-A')).toBeNull()
  })
})

describe('handleSetupStart', () => {
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
    getEffectiveHooksMock.mockReset().mockReturnValue({ scripts: { setup: 'pnpm install' } })
    createSetupRunnerScriptMock.mockReset().mockReturnValue({
      runnerScriptPath: '/tmp/.git/orca/setup-runner.sh',
      envVars: { ORCA_WORKTREE_PATH: worktreePath }
    })
    registerPtyMock.mockReset()
    unregisterPtyMock.mockReset()
  })

  it('returns no-setup-script when scripts.setup is empty', async () => {
    getEffectiveHooksMock.mockReturnValue({ scripts: {} })
    const result = await handleSetupStart(
      { worktreeId },
      { store: makeMultiRepoStore([repo]) as never }
    )
    expect(result).toEqual({ ok: false, reason: 'no-setup-script' })
    expect(provider.spawn).not.toHaveBeenCalled()
  })

  it('returns repo-not-found / invalid-worktree for bad inputs', async () => {
    expect(
      await handleSetupStart({ worktreeId }, { store: makeMultiRepoStore([]) as never })
    ).toEqual({ ok: false, reason: 'repo-not-found' })
    expect(
      await handleSetupStart(
        { worktreeId: 'not-a-valid-id' },
        { store: makeMultiRepoStore([repo]) as never }
      )
    ).toEqual({ ok: false, reason: 'invalid-worktree' })
  })

  it('spawns and registers per-worktree, broadcasting setup:started', async () => {
    // Why: createSetupRunnerScript is mocked, so its returned envVars are
    // what the spawn sees. Mirror the conductor block the real wrapper
    // produces to prove the handler forwarded those values.
    createSetupRunnerScriptMock.mockReturnValue({
      runnerScriptPath: '/tmp/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_WORKTREE_PATH: worktreePath,
        CONDUCTOR_ROOT_PATH: repo.path,
        CONDUCTOR_WORKSPACE_NAME: 'wise_panther'
      }
    })
    const result = await handleSetupStart(
      { worktreeId },
      { store: makeMultiRepoStore([repo]) as never }
    )
    expect(result).toEqual({ ok: true, ptyId: 'pty-NEW' })
    expect(provider.shutdown).not.toHaveBeenCalled()
    expect(createSetupRunnerScriptMock).toHaveBeenCalledWith(
      repo,
      worktreePath,
      'pnpm install',
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
    expect(spawnArgs.command).toContain('setup-runner.sh')
    expect(registry.get(worktreeId)).toMatchObject({ ptyId: 'pty-NEW' })
    expect(win.webContents.send).toHaveBeenCalledWith('setup:started', {
      repoId: repo.id,
      worktreeId,
      ptyId: 'pty-NEW'
    })
    // Why: the memory collector needs PTYs attributed to their worktree, or
    // they fall through to ORPHAN_WORKTREE_ID.
    expect(registerPtyMock).toHaveBeenCalledWith(
      expect.objectContaining({ ptyId: 'pty-NEW', worktreeId })
    )
    // Why: setup PTY must be exempted from killOrphanedPtys at spawn time so
    // a renderer reload doesn't sweep it via the post-reload generation pass.
    expect(provider.markPtyExemptFromOrphanKill).toHaveBeenCalledWith('pty-NEW')
  })

  it('isolates registry entries across worktrees in the same repo', async () => {
    // Why: setup is per-worktree, not per-repo. Starting in worktree A must
    // not shutdown the live setup PTY in worktree B (in contrast to run).
    const wtA = `${repo.id}::/test/repo/wt-A`
    const wtB = `${repo.id}::/test/repo/wt-B`
    const providerA = makeProvider({ spawnIds: ['pty-A'] })
    const providerB = makeProvider({ spawnIds: ['pty-B'] })
    getLocalPtyProviderMock.mockReturnValueOnce(providerA).mockReturnValueOnce(providerB)
    const store = makeMultiRepoStore([repo])
    await handleSetupStart({ worktreeId: wtA }, { store: store as never })
    await handleSetupStart({ worktreeId: wtB }, { store: store as never })
    expect(registry.get(wtA)).toMatchObject({ ptyId: 'pty-A' })
    expect(registry.get(wtB)).toMatchObject({ ptyId: 'pty-B' })
    expect(providerA.shutdown).not.toHaveBeenCalled()
    expect(providerB.shutdown).not.toHaveBeenCalled()
  })

  it('re-running setup in the same worktree kills prior + emits exit code 130', async () => {
    registry.set(worktreeId, { ptyId: 'pty-OLD', generation: 99, connectionId: null })
    await handleSetupStart({ worktreeId }, { store: makeMultiRepoStore([repo]) as never })
    expect(provider.shutdown).toHaveBeenCalledWith(
      'pty-OLD',
      expect.objectContaining({ immediate: true })
    )
    const sendCalls = win.webContents.send.mock.calls.map((c) => c[0])
    expect(sendCalls.indexOf('setup:exited')).toBeLessThan(sendCalls.indexOf('setup:started'))
    expect(win.webContents.send).toHaveBeenCalledWith('setup:exited', {
      repoId: repo.id,
      worktreeId,
      code: 130
    })
  })

  it('generation guard: a stale onExit does not clear the fresh entry', async () => {
    provider = makeProvider({ spawnIds: ['pty-A', 'pty-B'] })
    getLocalPtyProviderMock.mockReturnValue(provider)
    const store = makeMultiRepoStore([repo])
    await handleSetupStart({ worktreeId }, { store: store as never })
    await handleSetupStart({ worktreeId }, { store: store as never })
    expect(registry.get(worktreeId)).toMatchObject({ ptyId: 'pty-B' })
    provider.fireExit({ id: 'pty-A', code: 0 })
    expect(registry.get(worktreeId)).toMatchObject({ ptyId: 'pty-B' })
  })

  it('clears registry + broadcasts setup:exited on natural pty exit', async () => {
    await handleSetupStart({ worktreeId }, { store: makeMultiRepoStore([repo]) as never })
    win.webContents.send.mockClear()
    unregisterPtyMock.mockClear()
    provider.fireExit({ id: 'pty-NEW', code: 0 })
    expect(registry.get(worktreeId)).toBeNull()
    expect(win.webContents.send).toHaveBeenCalledWith('setup:exited', {
      repoId: repo.id,
      worktreeId,
      code: 0
    })
    // Why: stop attributing memory to a defunct PTY.
    expect(unregisterPtyMock).toHaveBeenCalledWith('pty-NEW')
    // Why: the exempt set must shrink with the PTY map — otherwise a recycled
    // PTY id from a future spawn would inherit the stale exemption.
    expect(provider.unmarkPtyExemptFromOrphanKill).toHaveBeenCalledWith('pty-NEW')
  })

  it('uses the SSH pty provider when the repo has a connectionId', async () => {
    const sshRepo = makeRepo({ connectionId: 'remote-1' })
    const sshProvider = makeProvider({ spawnIds: ['ssh-pty'], asLocal: false })
    getSshPtyProviderMock.mockReturnValue(sshProvider)
    const result = await handleSetupStart(
      { worktreeId },
      { store: makeMultiRepoStore([sshRepo]) as never }
    )
    expect(result).toEqual({ ok: true, ptyId: 'ssh-pty' })
    expect(sshProvider.spawn).toHaveBeenCalledTimes(1)
    expect(provider.spawn).not.toHaveBeenCalled()
  })

  it('dedupes concurrent starts for the same worktree so spawn runs once', async () => {
    let release: (v: { id: string }) => void = () => {}
    provider.spawn.mockReset().mockImplementationOnce(() => new Promise((r) => (release = r)))
    const store = makeMultiRepoStore([repo])
    const a = handleSetupStart({ worktreeId }, { store: store as never })
    const b = handleSetupStart({ worktreeId }, { store: store as never })
    release({ id: 'pty-NEW' })
    const ok = { ok: true, ptyId: 'pty-NEW' }
    expect(await Promise.all([a, b])).toEqual([ok, ok])
    expect(provider.spawn).toHaveBeenCalledTimes(1)
  })

  it('returns primary-worktree and does not spawn when targeted worktree is the primary', async () => {
    // Why: setup is only valid for worktrees created via `git worktree add`.
    // The primary working tree (path === repo.path) must be rejected even
    // when scripts.setup is configured, before any provider/spawn work.
    const primaryWorktreeId = `${repo.id}::${repo.path}`
    const result = await handleSetupStart(
      { worktreeId: primaryWorktreeId },
      { store: makeMultiRepoStore([repo]) as never }
    )
    expect(result).toEqual({ ok: false, reason: 'primary-worktree' })
    expect(provider.spawn).not.toHaveBeenCalled()
    expect(registry.get(primaryWorktreeId)).toBeNull()
  })

  it('spawn-failed leaves registry clean; subsequent start succeeds', async () => {
    provider.spawn.mockReset().mockRejectedValueOnce(new Error('boom'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = makeMultiRepoStore([repo])
    const result = await handleSetupStart({ worktreeId }, { store: store as never })
    errSpy.mockRestore()
    expect(result).toEqual({ ok: false, reason: 'spawn-failed' })
    expect(registry.get(worktreeId)).toBeNull()
    provider.spawn.mockResolvedValueOnce({ id: 'pty-RECOVER' })
    expect(await handleSetupStart({ worktreeId }, { store: store as never })).toEqual({
      ok: true,
      ptyId: 'pty-RECOVER'
    })
  })
})

describe('runSetup (non-IPC entrypoint, deps-first signature)', () => {
  // Why: orca-runtime + worktree-remote call this directly without going
  // through ipcMain. Same registry / generation / events as handleSetupStart.
  it('spawns and broadcasts via the same path as handleSetupStart', async () => {
    registry.clear()
    const provider = makeProvider({ spawnIds: ['pty-AUTO'] })
    const win = makeWindow()
    const repo = makeRepo()
    const worktreeId = `${repo.id}::/test/repo/wt-1`
    getLocalPtyProviderMock.mockReset().mockReturnValue(provider)
    getSshPtyProviderMock.mockReset().mockReturnValue(undefined)
    getAllWindowsMock.mockReset().mockReturnValue([win])
    getEffectiveHooksMock.mockReset().mockReturnValue({ scripts: { setup: 'pnpm install' } })
    createSetupRunnerScriptMock.mockReset().mockReturnValue({
      runnerScriptPath: '/tmp/.git/orca/setup-runner.sh',
      envVars: {}
    })
    const result = await runSetup({ store: makeMultiRepoStore([repo]) as never }, { worktreeId })
    expect(result).toEqual({ ok: true, ptyId: 'pty-AUTO' })
    expect(registry.get(worktreeId)).toMatchObject({ ptyId: 'pty-AUTO' })
    expect(win.webContents.send).toHaveBeenCalledWith('setup:started', {
      repoId: repo.id,
      worktreeId,
      ptyId: 'pty-AUTO'
    })
  })
})

describe('handleSetupStop', () => {
  const repo = makeRepo()
  const worktreeId = `${repo.id}::/test/repo/wt-1`

  it('returns not-running when registry is empty for the worktree', async () => {
    registry.clear()
    const provider = makeProvider()
    getLocalPtyProviderMock.mockReset().mockReturnValue(provider)
    getAllWindowsMock.mockReset().mockReturnValue([makeWindow()])
    const result = await handleSetupStop(
      { worktreeId },
      { store: makeMultiRepoStore([repo]) as never }
    )
    expect(result).toEqual({ ok: false, reason: 'not-running' })
    expect(provider.shutdown).not.toHaveBeenCalled()
  })

  it('shuts down the live pty, clears registry, and broadcasts setup:exited', async () => {
    registry.clear()
    const provider = makeProvider()
    const win = makeWindow()
    getLocalPtyProviderMock.mockReset().mockReturnValue(provider)
    getAllWindowsMock.mockReset().mockReturnValue([win])
    registry.set(worktreeId, { ptyId: 'pty-LIVE', generation: 7, connectionId: null })
    const result = await handleSetupStop(
      { worktreeId },
      { store: makeMultiRepoStore([repo]) as never }
    )
    expect(result).toEqual({ ok: true })
    expect(provider.shutdown).toHaveBeenCalledWith(
      'pty-LIVE',
      expect.objectContaining({ immediate: true })
    )
    expect(registry.get(worktreeId)).toBeNull()
    // Why: explicit stop must release the orphan-kill exemption so a recycled
    // PTY id from a future spawn doesn't inherit a stale exemption.
    expect(provider.unmarkPtyExemptFromOrphanKill).toHaveBeenCalledWith('pty-LIVE')
    expect(win.webContents.send).toHaveBeenCalledWith('setup:exited', {
      repoId: repo.id,
      worktreeId,
      code: 130
    })
  })
})
