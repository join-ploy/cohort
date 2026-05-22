import { describe, it, expect, vi } from 'vitest'
import { makeLinearIssueSource } from './linear-issue'
import type { CandidateEvent } from './types'

function makeFakeIssue(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'iss-1',
    identifier: 'ORC-1',
    title: 't',
    description: '',
    url: 'https://example.linear.app/ORC-1',
    updatedAt: new Date(5000).toISOString(),
    priority: 2,
    assignee: Promise.resolve({ id: 'u1', email: 'me@x.com', displayName: 'Me' }),
    state: Promise.resolve({ name: 'Todo', type: 'started', color: '#fff' }),
    team: Promise.resolve({ id: 't1', name: 'T', key: 'T' }),
    labels: () =>
      Promise.resolve({
        nodes: [
          { id: 'l1', name: 'orca' },
          { id: 'l2', name: 'ai' }
        ]
      }),
    ...overrides
  }
}

type FakePage = { nodes: unknown[]; endCursor: string | null; hasNextPage: boolean }

function makeFakeClient(opts: { pages: FakePage[] }): unknown {
  let pageIdx = 0
  return {
    issues: vi.fn().mockImplementation(async () => {
      const page = opts.pages[pageIdx]
      pageIdx += 1
      return {
        nodes: page.nodes,
        pageInfo: { endCursor: page.endCursor, hasNextPage: page.hasNextPage }
      }
    })
  }
}

describe('linearIssueSource.fieldCatalog', () => {
  it('exposes the four expected fields in order', () => {
    const source = makeLinearIssueSource({ client: null })
    const fields = source.fieldCatalog.map((d) => d.field)
    expect(fields).toEqual(['linear.assignee', 'linear.tag', 'linear.state', 'linear.priority'])
  })

  it('priority field exposes eq / is-any-of / gte / lte', () => {
    const source = makeLinearIssueSource({ client: null })
    const p = source.fieldCatalog.find((d) => d.field === 'linear.priority')!
    expect(p.ops).toEqual(expect.arrayContaining(['eq', 'is-any-of', 'gte', 'lte']))
    expect(p.valueKind).toBe('priority')
  })

  it('assignee field exposes is / is-not / is-any-of / is-none-of', () => {
    const source = makeLinearIssueSource({ client: null })
    const a = source.fieldCatalog.find((d) => d.field === 'linear.assignee')!
    expect(a.ops).toEqual(expect.arrayContaining(['is', 'is-not', 'is-any-of', 'is-none-of']))
    expect(a.valueKind).toBe('user')
  })

  it('tag field exposes contains-any / contains-all / contains-none', () => {
    const source = makeLinearIssueSource({ client: null })
    const t = source.fieldCatalog.find((d) => d.field === 'linear.tag')!
    expect(t.ops).toEqual(expect.arrayContaining(['contains-any', 'contains-all', 'contains-none']))
    expect(t.valueKind).toBe('label')
  })

  it('state field exposes is / is-any-of / is-none-of', () => {
    const source = makeLinearIssueSource({ client: null })
    const s = source.fieldCatalog.find((d) => d.field === 'linear.state')!
    expect(s.ops).toEqual(expect.arrayContaining(['is', 'is-any-of', 'is-none-of']))
    expect(s.valueKind).toBe('state')
  })

  it('id is "linear-issue" and displayName is "Linear issue"', () => {
    const source = makeLinearIssueSource({ client: null })
    expect(source.id).toBe('linear-issue')
    expect(source.displayName).toBe('Linear issue')
  })
})

describe('linearIssueSource.poll', () => {
  it('maps issues to CandidateEvents with the right field paths', async () => {
    const client = makeFakeClient({
      pages: [{ nodes: [makeFakeIssue()], endCursor: null, hasNextPage: false }]
    })
    const source = makeLinearIssueSource({ client: client as never })
    const out: CandidateEvent[] = []
    for await (const ev of source.poll({ since: 0, hostId: 'h' })) {
      out.push(ev)
    }
    expect(out).toHaveLength(1)
    expect(out[0].entityId).toBe('iss-1')
    expect(out[0].entityIdentifier).toBe('ORC-1')
    expect(out[0].updatedAt).toBe(5000)
    expect(out[0].fields['linear.assignee']).toBe('u1')
    expect(out[0].fields['linear.tag']).toEqual(['orca', 'ai'])
    expect(out[0].fields['linear.state']).toBe('Todo')
    expect(out[0].fields['linear.priority']).toBe(2)
    const payload = out[0].payload as { issue: Record<string, unknown> }
    expect(payload.issue.identifier).toBe('ORC-1')
    expect(payload.issue.assigneeEmail).toBe('me@x.com')
    expect(payload.issue.stateName).toBe('Todo')
  })

  it('paginates via cursor across multiple pages', async () => {
    const client = makeFakeClient({
      pages: [
        {
          nodes: [makeFakeIssue({ id: 'iss-1', identifier: 'ORC-1' })],
          endCursor: 'c1',
          hasNextPage: true
        },
        {
          nodes: [makeFakeIssue({ id: 'iss-2', identifier: 'ORC-2' })],
          endCursor: null,
          hasNextPage: false
        }
      ]
    })
    const source = makeLinearIssueSource({ client: client as never })
    const ids: string[] = []
    for await (const ev of source.poll({ since: 0, hostId: 'h' })) {
      ids.push(ev.entityId)
    }
    expect(ids).toEqual(['iss-1', 'iss-2'])
    expect((client as { issues: { mock: { calls: unknown[] } } }).issues.mock.calls.length).toBe(2)
  })

  it('yields zero events when client is null', async () => {
    const source = makeLinearIssueSource({ client: null })
    const out: CandidateEvent[] = []
    for await (const ev of source.poll({ since: 0, hostId: 'h' })) {
      out.push(ev)
    }
    expect(out).toEqual([])
  })

  it('yields zero events when client throws (logged, not thrown)', async () => {
    const client = {
      issues: vi.fn().mockRejectedValue(new Error('boom'))
    }
    const source = makeLinearIssueSource({ client: client as never })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out: CandidateEvent[] = []
    for await (const ev of source.poll({ since: 0, hostId: 'h' })) {
      out.push(ev)
    }
    expect(out).toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('caps pagination at 5 pages defensively', async () => {
    // Why: an unbounded `hasNextPage: true` reply would otherwise spin
    // forever; the 5-page cap keeps a pathological connection from
    // burning Linear API quota in a single tick.
    const client = {
      issues: vi.fn().mockImplementation(async () => ({
        nodes: [makeFakeIssue({ id: `iss-${Math.random()}` })],
        pageInfo: { endCursor: 'c', hasNextPage: true }
      }))
    }
    const source = makeLinearIssueSource({ client: client as never })
    let count = 0
    for await (const _ev of source.poll({ since: 0, hostId: 'h' })) {
      count++
    }
    expect(count).toBe(5)
    expect(client.issues.mock.calls.length).toBe(5)
  })
})
