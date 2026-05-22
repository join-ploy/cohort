import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeLinearIssueSource } from './linear-issue'
import type { CandidateEvent } from './types'

// Why: stub the linear client module so the source's auth-error path is
// observable without standing up the real safeStorage/Keychain stack.
vi.mock('../../linear/client', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn(),
  isAuthError: vi.fn(),
  clearToken: vi.fn()
}))

import { acquire, release, isAuthError, clearToken } from '../../linear/client'

beforeEach(() => {
  vi.mocked(acquire).mockClear()
  vi.mocked(release).mockClear()
  vi.mocked(isAuthError).mockReset().mockReturnValue(false)
  vi.mocked(clearToken).mockClear()
})

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
    const source = makeLinearIssueSource({ getClient: () => null })
    const fields = source.fieldCatalog.map((d) => d.field)
    expect(fields).toEqual(['linear.assignee', 'linear.tag', 'linear.state', 'linear.priority'])
  })

  it('priority field exposes eq / is-any-of / gte / lte', () => {
    const source = makeLinearIssueSource({ getClient: () => null })
    const p = source.fieldCatalog.find((d) => d.field === 'linear.priority')!
    expect(p.ops).toEqual(expect.arrayContaining(['eq', 'is-any-of', 'gte', 'lte']))
    expect(p.valueKind).toBe('priority')
  })

  it('assignee field exposes is / is-not / is-any-of / is-none-of', () => {
    const source = makeLinearIssueSource({ getClient: () => null })
    const a = source.fieldCatalog.find((d) => d.field === 'linear.assignee')!
    expect(a.ops).toEqual(expect.arrayContaining(['is', 'is-not', 'is-any-of', 'is-none-of']))
    expect(a.valueKind).toBe('user')
  })

  it('tag field exposes contains-any / contains-all / contains-none', () => {
    const source = makeLinearIssueSource({ getClient: () => null })
    const t = source.fieldCatalog.find((d) => d.field === 'linear.tag')!
    expect(t.ops).toEqual(expect.arrayContaining(['contains-any', 'contains-all', 'contains-none']))
    expect(t.valueKind).toBe('label')
  })

  it('state field exposes is / is-any-of / is-none-of', () => {
    const source = makeLinearIssueSource({ getClient: () => null })
    const s = source.fieldCatalog.find((d) => d.field === 'linear.state')!
    expect(s.ops).toEqual(expect.arrayContaining(['is', 'is-any-of', 'is-none-of']))
    expect(s.valueKind).toBe('state')
  })

  it('id is "linear-issue" and displayName is "Linear issue"', () => {
    const source = makeLinearIssueSource({ getClient: () => null })
    expect(source.id).toBe('linear-issue')
    expect(source.displayName).toBe('Linear issue')
  })
})

describe('linearIssueSource.poll', () => {
  it('maps issues to CandidateEvents with the right field paths', async () => {
    const client = makeFakeClient({
      pages: [{ nodes: [makeFakeIssue()], endCursor: null, hasNextPage: false }]
    })
    const source = makeLinearIssueSource({ getClient: () => client as never })
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
    // Why: the poll must share the SDK's concurrency limiter — acquire/release
    // should each fire exactly once per public poll() call.
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
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
    const source = makeLinearIssueSource({ getClient: () => client as never })
    const ids: string[] = []
    for await (const ev of source.poll({ since: 0, hostId: 'h' })) {
      ids.push(ev.entityId)
    }
    expect(ids).toEqual(['iss-1', 'iss-2'])
    const calls = (client as { issues: { mock: { calls: { 0: Record<string, unknown> }[] } } })
      .issues.mock.calls
    expect(calls.length).toBe(2)
    // Why: deterministic oldest-first ordering keeps the MAX_PAGES truncation
    // from dropping random older events.
    expect(calls[0][0].orderBy).toBe('updatedAt')
  })

  it('yields zero events when client is null', async () => {
    const source = makeLinearIssueSource({ getClient: () => null })
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
    const source = makeLinearIssueSource({ getClient: () => client as never })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out: CandidateEvent[] = []
    for await (const ev of source.poll({ since: 0, hostId: 'h' })) {
      out.push(ev)
    }
    expect(out).toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('clears the stored token when client.issues rejects with an auth error', async () => {
    // Why: a rotated/revoked token would otherwise silently 401-loop every
    // tick — confirm the source recognizes the auth error and clears state so
    // the renderer can prompt for re-auth on the next status read.
    vi.mocked(isAuthError).mockReturnValue(true)
    const client = {
      issues: vi.fn().mockRejectedValue(new Error('401'))
    }
    const source = makeLinearIssueSource({ getClient: () => client as never })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out: CandidateEvent[] = []
    for await (const ev of source.poll({ since: 0, hostId: 'h' })) {
      out.push(ev)
    }
    expect(out).toEqual([])
    expect(clearToken).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
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
    const source = makeLinearIssueSource({ getClient: () => client as never })
    let count = 0
    for await (const _ev of source.poll({ since: 0, hostId: 'h' })) {
      count++
    }
    expect(count).toBe(5)
    expect(client.issues.mock.calls.length).toBe(5)
  })
})

describe('linearIssueSource.fetchOptions', () => {
  it('assignee includes synthetic "me" and team members, deduped', async () => {
    const viewerId = 'viewer-id'
    const client = {
      viewer: Promise.resolve({ id: viewerId, email: 'v@x.com', displayName: 'V' })
    }
    const source = makeLinearIssueSource({
      getClient: () => client as never,
      listTeams: async () => [{ id: 't1', name: 'T1', key: 'T1' }],
      getTeamMembers: async () => [
        { id: 'u1', displayName: 'Alice' },
        { id: viewerId, displayName: 'V' }
      ]
    })
    const assignee = source.fieldCatalog.find((d) => d.field === 'linear.assignee')!
    const opts = await assignee.fetchOptions!({ since: 0, hostId: 'h' })
    expect(opts[0]).toEqual({ value: viewerId, label: 'me' })
    expect(opts.some((o) => o.value === 'u1')).toBe(true)
    expect(opts.filter((o) => o.value === viewerId).length).toBe(1)
  })

  it('tag returns deduped label names across teams', async () => {
    const source = makeLinearIssueSource({
      getClient: () => null,
      listTeams: async () => [
        { id: 't1', name: '', key: '' },
        { id: 't2', name: '', key: '' }
      ],
      getTeamLabels: async (teamId) =>
        teamId === 't1'
          ? [
              { id: 'l1', name: 'orca', color: '' },
              { id: 'l2', name: 'ai', color: '' }
            ]
          : [
              { id: 'l3', name: 'ai', color: '' },
              { id: 'l4', name: 'mobile', color: '' }
            ]
    })
    const tag = source.fieldCatalog.find((d) => d.field === 'linear.tag')!
    const opts = await tag.fetchOptions!({ since: 0, hostId: 'h' })
    const names = opts.map((o) => o.value)
    expect(new Set(names)).toEqual(new Set(['orca', 'ai', 'mobile']))
  })

  it('state returns deduped state names across teams', async () => {
    const source = makeLinearIssueSource({
      getClient: () => null,
      listTeams: async () => [{ id: 't1', name: '', key: '' }],
      getTeamStates: async () => [
        { id: 's1', name: 'Todo', type: 'started', color: '', position: 0 },
        { id: 's2', name: 'In Progress', type: 'started', color: '', position: 1 }
      ]
    })
    const state = source.fieldCatalog.find((d) => d.field === 'linear.state')!
    const opts = await state.fetchOptions!({ since: 0, hostId: 'h' })
    expect(opts.map((o) => o.value)).toEqual(['Todo', 'In Progress'])
  })

  it('assignee returns empty array when client is null', async () => {
    const source = makeLinearIssueSource({ getClient: () => null })
    const assignee = source.fieldCatalog.find((d) => d.field === 'linear.assignee')!
    const opts = await assignee.fetchOptions!({ since: 0, hostId: 'h' })
    expect(opts).toEqual([])
  })

  it('priority returns the static 5 levels', async () => {
    const source = makeLinearIssueSource({ getClient: () => null })
    const p = source.fieldCatalog.find((d) => d.field === 'linear.priority')!
    const opts = await p.fetchOptions!({ since: 0, hostId: 'h' })
    expect(opts.map((o) => o.label)).toEqual(['No priority', 'Urgent', 'High', 'Medium', 'Low'])
  })
})
