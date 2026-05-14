import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getLocalPtyProviderMock,
  getSshPtyProviderMock,
  getEffectiveHooksMock,
  createRunRunnerScriptMock,
  getAllWindowsMock
} = vi.hoisted(() => ({
  getLocalPtyProviderMock: vi.fn(),
  getSshPtyProviderMock: vi.fn(),
  getEffectiveHooksMock: vi.fn(),
  createRunRunnerScriptMock: vi.fn(),
  getAllWindowsMock: vi.fn()
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

import { _testing as registry, killRunForWorktree } from './run-script'
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
    registry.set(repo.id, { ptyId: 'pty-SIBLING', worktreeId: siblingWorktreeId, generation: 5 })
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
    registry.set(repo.id, { ptyId: 'pty-LIVE', worktreeId, generation: 9 })
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
    const sshProvider = makeProvider()
    getSshPtyProviderMock.mockReturnValue(sshProvider)
    registry.set(sshRepo.id, { ptyId: 'ssh-pty', worktreeId, generation: 1 })
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
    registry.set(repo.id, { ptyId: 'pty-LIVE', worktreeId, generation: 1 })
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
