import { describe, it, expect } from 'vitest'
import { makeGithubPrSource, type GithubPr } from './github-pr'
import type { CandidateEvent } from './types'
import type { Repo } from '../../../shared/types'

function makePr(overrides: Partial<GithubPr> = {}): GithubPr {
  return {
    number: 7,
    title: 'Add feature',
    url: 'https://github.com/o/r/pull/7',
    author: 'alice',
    baseRefName: 'main',
    headRefName: 'feature',
    labels: ['bug', 'p1'],
    isCrossRepository: false,
    createdAt: new Date(5000).toISOString(),
    updatedAt: new Date(9000).toISOString(),
    ...overrides
  }
}

describe('githubPrSource.poll', () => {
  it('maps an open PR to a CandidateEvent with opened-watermark semantics', async () => {
    const r1 = { id: 'r1', path: '/r1', displayName: 'r1' } as Repo
    const pr = makePr()
    const source = makeGithubPrSource({
      getRepos: () => [r1],
      listOpenPrs: async () => [pr]
    })
    const out: CandidateEvent[] = []
    for await (const ev of source.poll({ since: 0, hostId: 'h', repoIds: ['r1'] })) {
      out.push(ev)
    }
    expect(out).toHaveLength(1)
    expect(out[0].entityId).toBe('r1#7')
    expect(out[0].entityIdentifier).toBe('r1#7')
    expect(out[0].repoId).toBe('r1')
    // OPENED semantics: watermark uses createdAt, not updatedAt.
    expect(out[0].updatedAt).toBe(new Date(pr.createdAt).getTime())
    expect(out[0].fields['github.baseRef']).toBe('main')
    expect(out[0].fields['github.author']).toBe('alice')
    expect(out[0].fields['github.labels']).toEqual(['bug', 'p1'])
    const payload = out[0].payload as { pr: Record<string, unknown> }
    expect(payload.pr.headRef).toBe('feature')
    expect(payload.pr.repoId).toBe('r1')
  })

  it('only polls repos in ctx.repoIds and skips connectionId/folder repos', async () => {
    const r1 = { id: 'r1', path: '/r1', displayName: 'r1' } as Repo
    const r2 = { id: 'r2', path: '/r2', displayName: 'r2', connectionId: 'ssh-1' } as Repo
    const polled: string[] = []
    const source = makeGithubPrSource({
      getRepos: () => [r1, r2],
      listOpenPrs: async (repo) => {
        polled.push(repo.id)
        return []
      }
    })
    for await (const _ev of source.poll({ since: 0, hostId: 'h', repoIds: ['r1', 'r2'] })) {
      void _ev
    }
    expect(polled).toEqual(['r1'])
  })
})
