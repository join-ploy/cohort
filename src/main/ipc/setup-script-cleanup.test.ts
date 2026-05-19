import { describe, expect, it, vi } from 'vitest'

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

import { _testing as registry, killSetupForWorktree } from './setup-script'
import { makeMultiRepoStore, makeProvider, makeRepo, makeWindow } from './script-ipc-test-fakes'

describe('killSetupForWorktree (worktree-delete cleanup)', () => {
  const repo = makeRepo()
  const worktreeId = `${repo.id}::/test/repo/wt-1`

  it('is a no-op when the registry has no entry for the worktree', async () => {
    registry.clear()
    const provider = makeProvider()
    const win = makeWindow()
    getLocalPtyProviderMock.mockReset().mockReturnValue(provider)
    getAllWindowsMock.mockReset().mockReturnValue([win])

    await killSetupForWorktree({ worktreeId }, { store: makeMultiRepoStore([repo]) as never })

    expect(provider.shutdown).not.toHaveBeenCalled()
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('shuts down the registered pty, clears the registry, and broadcasts setup:exited', async () => {
    registry.clear()
    const provider = makeProvider()
    const win = makeWindow()
    getLocalPtyProviderMock.mockReset().mockReturnValue(provider)
    getAllWindowsMock.mockReset().mockReturnValue([win])
    registry.set(worktreeId, { ptyId: 'pty-LIVE', generation: 3, connectionId: null })

    await killSetupForWorktree({ worktreeId }, { store: makeMultiRepoStore([repo]) as never })

    expect(provider.shutdown).toHaveBeenCalledWith(
      'pty-LIVE',
      expect.objectContaining({ immediate: true })
    )
    expect(registry.get(worktreeId)).toBeNull()
    expect(win.webContents.send).toHaveBeenCalledWith('setup:exited', {
      repoId: repo.id,
      worktreeId,
      code: 130
    })
  })

  it('uses the SSH provider when the repo has a connectionId', async () => {
    registry.clear()
    const sshRepo = makeRepo({ connectionId: 'remote-1' })
    const sshWorktreeId = `${sshRepo.id}::/remote/repo/wt-1`
    const localProvider = makeProvider()
    const sshProvider = makeProvider()
    getLocalPtyProviderMock.mockReset().mockReturnValue(localProvider)
    getSshPtyProviderMock.mockReset().mockReturnValue(sshProvider)
    getAllWindowsMock.mockReset().mockReturnValue([makeWindow()])
    registry.set(sshWorktreeId, {
      ptyId: 'ssh-pty',
      generation: 1,
      connectionId: 'remote-1'
    })

    await killSetupForWorktree(
      { worktreeId: sshWorktreeId },
      { store: makeMultiRepoStore([sshRepo]) as never }
    )

    expect(sshProvider.shutdown).toHaveBeenCalledWith(
      'ssh-pty',
      expect.objectContaining({ immediate: true })
    )
    expect(localProvider.shutdown).not.toHaveBeenCalled()
    expect(registry.get(sshWorktreeId)).toBeNull()
  })

  it('still clears the registry and broadcasts even if shutdown throws', async () => {
    registry.clear()
    const provider = makeProvider()
    const win = makeWindow()
    getLocalPtyProviderMock.mockReset().mockReturnValue(provider)
    getAllWindowsMock.mockReset().mockReturnValue([win])
    registry.set(worktreeId, { ptyId: 'pty-LIVE', generation: 1, connectionId: null })
    provider.shutdown.mockRejectedValueOnce(new Error('already gone'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await killSetupForWorktree({ worktreeId }, { store: makeMultiRepoStore([repo]) as never })

    warnSpy.mockRestore()
    expect(registry.get(worktreeId)).toBeNull()
    expect(win.webContents.send).toHaveBeenCalledWith('setup:exited', {
      repoId: repo.id,
      worktreeId,
      code: 130
    })
  })
})
