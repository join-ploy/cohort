import { describe, expect, it } from 'vitest'
import { resolvePrBaseCore } from './resolve-pr-base'
import type { Repo } from '../../shared/types'

// Why: these guards short-circuit before any git/gh call, so they're the
// portion of resolvePrBaseCore that's testable without mocking the shell.
describe('resolvePrBaseCore input guards', () => {
  it('rejects remote repos (connectionId set)', async () => {
    const repo = { connectionId: 'conn-1', kind: 'git', path: '/tmp/repo' } as unknown as Repo
    const result = await resolvePrBaseCore({ repo, prNumber: 7 })
    expect(result).toEqual({
      error: 'PR start points are not supported for remote repos yet.'
    })
  })

  it('rejects folder repos', async () => {
    const repo = { kind: 'folder', path: '/tmp/folder' } as unknown as Repo
    const result = await resolvePrBaseCore({ repo, prNumber: 7 })
    expect(result).toEqual({
      error: 'Folder mode does not support creating worktrees.'
    })
  })
})
