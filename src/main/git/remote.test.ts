import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import { gitFetch, gitPull, gitPush, refExistsOnRemote } from './remote'

describe('git remote operations', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('pushes to origin when no upstream is configured', async () => {
    // 1. symbolic-ref (HEAD) → returns branch name
    // 2. config branch.<name>.remote → rejects (no upstream)
    // 3. ls-remote → empty (no collision)
    // 4. push
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'wopping_ferret_a1348\n', stderr: '' })
      .mockRejectedValueOnce(Object.assign(new Error('no branch'), { code: 1 }))
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    const result = await gitPush('/repo', true)

    expect(result).toEqual({ renamed: null })
    expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(
      ['push', '--set-upstream', 'origin', 'HEAD'],
      { cwd: '/repo' }
    )
  })

  it('pushes to the configured upstream remote and branch', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'review/pr-1738\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'pr-prateek-orca\n', stderr: '' })
      .mockResolvedValueOnce({
        stdout: 'refs/heads/prateek/fix-sidebar-agents-toggle\n',
        stderr: ''
      })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    const result = await gitPush('/repo', false)

    expect(result).toEqual({ renamed: null })
    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: '/repo' }],
      [['config', '--get', 'branch.review/pr-1738.remote'], { cwd: '/repo' }],
      [['config', '--get', 'branch.review/pr-1738.merge'], { cwd: '/repo' }],
      [
        ['push', '--set-upstream', 'pr-prateek-orca', 'HEAD:prateek/fix-sidebar-agents-toggle'],
        { cwd: '/repo' }
      ]
    ])
  })

  it('uses an explicit push target even when it differs from the local branch name', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    const result = await gitPush('/repo', false, {
      remoteName: 'origin',
      branchName: 'contributor/fix-sidebar'
    })

    expect(result).toEqual({ renamed: null })
    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['check-ref-format', '--branch', 'contributor/fix-sidebar'], { cwd: '/repo' }],
      [['push', '--set-upstream', 'origin', 'HEAD:contributor/fix-sidebar'], { cwd: '/repo' }]
    ])
  })

  it('maps non-fast-forward push failures to an actionable message', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'main\n', stderr: '' }) // symbolic-ref
      .mockRejectedValueOnce(new Error('no branch')) // config.remote
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // ls-remote (no collision)
      .mockRejectedValueOnce(new Error('remote rejected: non-fast-forward'))

    await expect(gitPush('/repo', false)).rejects.toThrow(
      'Push rejected: remote has newer commits (non-fast-forward). Please pull or sync first.'
    )
  })

  it('passes through clean tail line when push error does not match known patterns', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'main\n', stderr: '' }) // symbolic-ref
      .mockRejectedValueOnce(new Error('no branch')) // config.remote
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // ls-remote (no collision)
      .mockRejectedValueOnce(
        new Error('Command failed: git push\nfatal: something obscure happened')
      )

    await expect(gitPush('/repo', false)).rejects.toThrow('fatal: something obscure happened')
  })

  it('strips embedded credentials from push error messages', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'main\n', stderr: '' }) // symbolic-ref
      .mockRejectedValueOnce(new Error('no branch')) // config.remote
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // ls-remote (no collision)
      .mockRejectedValueOnce(
        new Error(
          'Command failed: git push\nhttps://x-access-token:ghp_abc@github.com/foo/bar.git\nfatal: remote error'
        )
      )

    let caught: Error | undefined
    try {
      await gitPush('/repo', false)
    } catch (error) {
      caught = error as Error
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught?.message).not.toContain('ghp_abc')
    expect(caught?.message).not.toContain('x-access-token')
  })

  it('strips token-only credentials (https://TOKEN@host) from push error messages', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'main\n', stderr: '' }) // symbolic-ref
      .mockRejectedValueOnce(new Error('no branch')) // config.remote
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // ls-remote (no collision)
      .mockRejectedValueOnce(
        new Error(
          'Command failed: git push\nhttps://ghp_onlyToken@github.com/foo/bar.git\nfatal: remote error'
        )
      )

    let caught: Error | undefined
    try {
      await gitPush('/repo', false)
    } catch (error) {
      caught = error as Error
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught?.message).not.toContain('ghp_onlyToken')
  })

  it('falls back to a generic message for non-Error rejections', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'main\n', stderr: '' }) // symbolic-ref
      .mockRejectedValueOnce(new Error('no branch')) // config.remote
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // ls-remote (no collision)
      .mockRejectedValueOnce('string')

    await expect(gitPush('/repo', false)).rejects.toThrow('Git remote operation failed.')
  })

  it("runs pull with the user's configured strategy", async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    await gitPull('/repo')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['pull'], { cwd: '/repo' })
  })

  it('normalizes pull authentication errors to a friendly message', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('Authentication failed'))

    await expect(gitPull('/repo')).rejects.toThrow(
      'Authentication failed. Check your remote credentials.'
    )
  })

  it('runs fetch with prune', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    await gitFetch('/repo')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['fetch', '--prune'], { cwd: '/repo' })
  })

  it('normalizes fetch authentication errors to a friendly message', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('Authentication failed'))

    await expect(gitFetch('/repo')).rejects.toThrow(
      'Authentication failed. Check your remote credentials.'
    )
  })

  it('refExistsOnRemote returns true when ls-remote prints a matching ref', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'abc123\trefs/heads/wopping_ferret_a1348\n',
      stderr: ''
    })
    await expect(refExistsOnRemote('/repo', 'origin', 'wopping_ferret_a1348')).resolves.toBe(true)
    expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(
      ['ls-remote', '--heads', '--exit-code', 'origin', 'wopping_ferret_a1348'],
      { cwd: '/repo' }
    )
  })

  it('refExistsOnRemote returns false when ls-remote rejects with exit-code semantics', async () => {
    // Why: git ls-remote --exit-code returns non-zero when no refs match,
    // which surfaces as a thrown error from gitExecFileAsync. The helper
    // swallows that and returns false.
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('no match'), { code: 2 }))
    await expect(refExistsOnRemote('/repo', 'origin', 'wopping_ferret_a1348')).resolves.toBe(false)
  })

  it('refExistsOnRemote returns false when ls-remote fails (network down, unknown remote, etc.)', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('Could not resolve host'))
    await expect(refExistsOnRemote('/repo', 'origin', 'wopping_ferret_a1348')).resolves.toBe(false)
  })

  it('re-rolls hash and retries push when the remote ref already exists', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'wopping_ferret_a1348\n', stderr: '' }) // symbolic-ref
      .mockRejectedValueOnce(new Error('no upstream')) // config.remote
      .mockResolvedValueOnce({
        stdout: 'abc123\trefs/heads/wopping_ferret_a1348\n',
        stderr: ''
      }) // ls-remote: collision
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // branch -m
      .mockResolvedValueOnce({ stdout: 'wopping_ferret_b9d52\n', stderr: '' }) // symbolic-ref (new name)
      .mockRejectedValueOnce(Object.assign(new Error('no match'), { code: 2 })) // ls-remote: clear
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // push

    const result = await gitPush('/repo', false)

    expect(result.renamed).toEqual({
      from: 'wopping_ferret_a1348',
      to: expect.stringMatching(/^wopping_ferret_[a-z0-9]{5}$/)
    })
    expect(result.renamed?.to).not.toBe('wopping_ferret_a1348')

    // Verify a branch -m call happened.
    const renameCall = gitExecFileAsyncMock.mock.calls.find(
      ([args]) => Array.isArray(args) && args[0] === 'branch' && args[1] === '-m'
    )
    expect(renameCall).toBeDefined()
  })

  it('throws after 3 consecutive collisions', async () => {
    // 3 rounds of (symbolic-ref → config.remote reject → ls-remote collision → branch -m).
    // No 4th attempt is initiated (the function throws after exhausting attempts).
    for (let i = 0; i < 3; i += 1) {
      gitExecFileAsyncMock
        .mockResolvedValueOnce({ stdout: `wopping_ferret_round${i}\n`, stderr: '' }) // symbolic-ref
        .mockRejectedValueOnce(new Error('no upstream')) // config.remote
        .mockResolvedValueOnce({
          stdout: `abc${i}\trefs/heads/wopping_ferret_round${i}\n`,
          stderr: ''
        }) // ls-remote: collision
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // branch -m
    }

    await expect(gitPush('/repo', false)).rejects.toThrow(/Failed to push after 3 rename attempts/)
  })

  it('does not probe ls-remote when an upstream is already configured', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n', stderr: '' }) // symbolic-ref
      .mockResolvedValueOnce({ stdout: 'origin\n', stderr: '' }) // config.remote
      .mockResolvedValueOnce({ stdout: 'refs/heads/feature\n', stderr: '' }) // config.merge
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // push

    const result = await gitPush('/repo', false)

    expect(result).toEqual({ renamed: null })
    const calls = gitExecFileAsyncMock.mock.calls.map(([args]) => (args as string[])[0])
    expect(calls).not.toContain('ls-remote')
  })

  it('does not probe ls-remote when an explicit pushTarget is supplied', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // check-ref-format
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // push

    await gitPush('/repo', false, { remoteName: 'origin', branchName: 'feature/x' })

    const calls = gitExecFileAsyncMock.mock.calls.map(([args]) => (args as string[])[0])
    expect(calls).not.toContain('ls-remote')
  })
})
