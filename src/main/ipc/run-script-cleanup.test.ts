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
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: { getAllWindows: getAllWindowsMock }
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

import { _testing as registry, killAllRunScripts, killRunForWorktree } from './run-script'
import {
  type FakeProvider,
  makeProvider,
  makeRepo,
  makeSingleRepoStore,
  makeWindow
} from './script-ipc-test-fakes'

describe('killRunForWorktree (worktree-delete cleanup)', () => {
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
  })

  it('is a no-op when the registry has no entry for the repo', async () => {
    const store = makeSingleRepoStore(repo)
    await killRunForWorktree({ repoId: repo.id, worktreeId }, { store: store as never })
    expect(provider.shutdown).not.toHaveBeenCalled()
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('is a no-op when the registry entry is owned by a sibling worktree of the same repo', async () => {
    // Why: the run registry is per-repo, so deleting worktree A must not touch
    // a live run owned by sibling worktree B.
    const siblingWorktreeId = `${repo.id}::/test/repo/wt-SIBLING`
    registry.set(repo.id, {
      ptyId: 'pty-SIBLING',
      worktreeId: siblingWorktreeId,
      generation: 5,
      connectionId: null
    })
    const store = makeSingleRepoStore(repo)

    await killRunForWorktree({ repoId: repo.id, worktreeId }, { store: store as never })

    expect(provider.shutdown).not.toHaveBeenCalled()
    expect(win.webContents.send).not.toHaveBeenCalled()
    expect(registry.get(repo.id)).toMatchObject({
      ptyId: 'pty-SIBLING',
      worktreeId: siblingWorktreeId
    })
  })

  it('shuts down the pty, clears the registry, and broadcasts run:exited when owned by the deleted worktree', async () => {
    registry.set(repo.id, {
      ptyId: 'pty-LIVE',
      worktreeId,
      generation: 9,
      connectionId: null
    })
    const store = makeSingleRepoStore(repo)

    await killRunForWorktree({ repoId: repo.id, worktreeId }, { store: store as never })

    expect(provider.shutdown).toHaveBeenCalledWith(
      'pty-LIVE',
      expect.objectContaining({ immediate: true })
    )
    expect(registry.get(repo.id)).toBeNull()
    expect(win.webContents.send).toHaveBeenCalledWith('run:exited', {
      repoId: repo.id,
      worktreeId,
      code: 130
    })
  })

  it('uses the SSH provider when the repo has a connectionId', async () => {
    const sshRepo = makeRepo({ connectionId: 'remote-1' })
    const sshProvider = makeProvider({ asLocal: false })
    getSshPtyProviderMock.mockReturnValue(sshProvider)
    registry.set(sshRepo.id, {
      ptyId: 'ssh-pty',
      worktreeId,
      generation: 1,
      connectionId: 'remote-1'
    })
    const store = makeSingleRepoStore(sshRepo)

    await killRunForWorktree({ repoId: sshRepo.id, worktreeId }, { store: store as never })

    expect(sshProvider.shutdown).toHaveBeenCalledWith(
      'ssh-pty',
      expect.objectContaining({ immediate: true })
    )
    expect(provider.shutdown).not.toHaveBeenCalled()
    expect(registry.get(sshRepo.id)).toBeNull()
  })

  it('still clears the registry and broadcasts even if shutdown throws', async () => {
    // Why: best-effort cleanup — a backend that already lost the session
    // should not block the registry purge or the renderer state flip.
    registry.set(repo.id, {
      ptyId: 'pty-LIVE',
      worktreeId,
      generation: 1,
      connectionId: null
    })
    provider.shutdown.mockRejectedValueOnce(new Error('already gone'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = makeSingleRepoStore(repo)

    await killRunForWorktree({ repoId: repo.id, worktreeId }, { store: store as never })

    warnSpy.mockRestore()
    expect(registry.get(repo.id)).toBeNull()
    expect(win.webContents.send).toHaveBeenCalledWith('run:exited', {
      repoId: repo.id,
      worktreeId,
      code: 130
    })
  })
})

describe('killAllRunScripts (app-quit cleanup)', () => {
  let provider: FakeProvider

  beforeEach(() => {
    registry.clear()
    provider = makeProvider()
    getLocalPtyProviderMock.mockReset().mockReturnValue(provider)
    getSshPtyProviderMock.mockReset().mockReturnValue(undefined)
    getAllWindowsMock.mockReset().mockReturnValue([makeWindow()])
    registerPtyMock.mockReset()
    unregisterPtyMock.mockReset()
  })

  it('shuts down every registered pty and empties the registry', async () => {
    // Why: app-quit needs to terminate every live run PTY across all repos,
    // not just the current one. The renderer broadcasts must fire before
    // will-quit so the dot UI flips before the window tears down.
    registry.set('repo-a', {
      ptyId: 'pty-A',
      worktreeId: 'repo-a::/a',
      generation: 1,
      connectionId: null
    })
    registry.set('repo-b', {
      ptyId: 'pty-B',
      worktreeId: 'repo-b::/b',
      generation: 1,
      connectionId: null
    })

    await killAllRunScripts()

    expect(provider.shutdown).toHaveBeenCalledWith(
      'pty-A',
      expect.objectContaining({ immediate: true })
    )
    expect(provider.shutdown).toHaveBeenCalledWith(
      'pty-B',
      expect.objectContaining({ immediate: true })
    )
    expect(unregisterPtyMock).toHaveBeenCalledWith('pty-A')
    expect(unregisterPtyMock).toHaveBeenCalledWith('pty-B')
    expect(registry.get('repo-a')).toBeNull()
    expect(registry.get('repo-b')).toBeNull()
  })

  it('routes SSH entries to their SSH provider using the stored connectionId', async () => {
    // Why: SSH entries store connectionId at spawn time so quit-time cleanup
    // can route shutdown without needing the store (which may be torn down).
    const sshProvider = makeProvider({ asLocal: false })
    getSshPtyProviderMock.mockImplementation((id: string) =>
      id === 'remote-1' ? sshProvider : undefined
    )
    registry.set('repo-ssh', {
      ptyId: 'ssh-pty',
      worktreeId: 'repo-ssh::/r',
      generation: 1,
      connectionId: 'remote-1'
    })
    registry.set('repo-local', {
      ptyId: 'local-pty',
      worktreeId: 'repo-local::/l',
      generation: 1,
      connectionId: null
    })

    await killAllRunScripts()

    expect(sshProvider.shutdown).toHaveBeenCalledWith(
      'ssh-pty',
      expect.objectContaining({ immediate: true })
    )
    expect(provider.shutdown).toHaveBeenCalledWith(
      'local-pty',
      expect.objectContaining({ immediate: true })
    )
    expect(registry.get('repo-ssh')).toBeNull()
    expect(registry.get('repo-local')).toBeNull()
  })

  it('still clears the registry when shutdown throws', async () => {
    // Why: best-effort cleanup — a failed shutdown for one entry must not
    // leak registry state, and must not block cleanup of other entries.
    registry.set('repo-a', {
      ptyId: 'pty-A',
      worktreeId: 'repo-a::/a',
      generation: 1,
      connectionId: null
    })
    provider.shutdown.mockRejectedValueOnce(new Error('already gone'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await killAllRunScripts()

    warnSpy.mockRestore()
    expect(registry.get('repo-a')).toBeNull()
    expect(unregisterPtyMock).toHaveBeenCalledWith('pty-A')
  })

  it('is a no-op when the registry is empty', async () => {
    await killAllRunScripts()
    expect(provider.shutdown).not.toHaveBeenCalled()
    expect(unregisterPtyMock).not.toHaveBeenCalled()
  })
})
