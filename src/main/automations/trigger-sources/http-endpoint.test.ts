import { describe, it, expect } from 'vitest'
import { makeHttpEndpointSource } from './http-endpoint'
import type { HttpEndpointConfig, HttpRequestConfig } from '../../../shared/automations-types'

const cfg = (over: Partial<HttpEndpointConfig> = {}): HttpEndpointConfig => ({
  request: { method: 'GET', url: 'https://api.test/items', headers: [], query: [] },
  itemsPath: 'data',
  fields: [
    { path: 'id', variableName: 'id', enabled: true, type: 'number', sampleValue: 0 },
    { path: 'updated', variableName: 'updated', enabled: true, type: 'date', sampleValue: '' }
  ],
  dedupeFields: ['id'],
  dateGateField: 'updated',
  ...over
})

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) {
    out.push(x)
  }
  return out
}

describe('http-endpoint source', () => {
  it('yields one event per item past the date gate, deduped by id', async () => {
    const body = {
      data: [
        { id: 1, updated: '2026-06-05T00:00:00Z' },
        { id: 2, updated: '2026-05-01T00:00:00Z' } // before since → gated out
      ]
    }
    const source = makeHttpEndpointSource({
      execute: async () => ({ status: 200, durationMs: 1, body }),
      now: () => Date.parse('2026-06-06T00:00:00Z')
    })
    const events = await collect(
      source.poll({ since: Date.parse('2026-06-01T00:00:00Z'), hostId: 'local', http: cfg() })
    )
    // buildDedupKey JSON-encodes the chosen field values.
    expect(events.map((e) => e.entityId)).toEqual(['[1]'])
    expect(events[0].fields).toEqual({ id: 1, updated: '2026-06-05T00:00:00Z' })
    expect(events[0].payload).toEqual({ id: 1, updated: '2026-06-05T00:00:00Z' })
    expect(events[0].updatedAt).toBe(Date.parse('2026-06-05T00:00:00Z'))
  })

  it('supports dotted date-gate + dedupe paths', async () => {
    const body = {
      data: [{ meta: { id: 7 }, audit: { at: '2026-06-05T00:00:00Z' } }]
    }
    const source = makeHttpEndpointSource({
      execute: async () => ({ status: 200, durationMs: 1, body }),
      now: () => Date.parse('2026-06-06T00:00:00Z')
    })
    const events = await collect(
      source.poll({
        since: Date.parse('2026-06-01T00:00:00Z'),
        hostId: 'local',
        http: cfg({ dedupeFields: ['meta.id'], dateGateField: 'audit.at', fields: [] })
      })
    )
    expect(events).toHaveLength(1)
    expect(events[0].entityId).toBe('[7]')
    expect(events[0].updatedAt).toBe(Date.parse('2026-06-05T00:00:00Z'))
  })

  it('falls back to poll time for updatedAt when no date gate is configured', async () => {
    const pollTime = Date.parse('2026-06-06T00:00:00Z')
    const source = makeHttpEndpointSource({
      execute: async () => ({ status: 200, durationMs: 1, body: { data: [{ id: 1 }] } }),
      now: () => pollTime
    })
    const events = await collect(
      source.poll({ since: 0, hostId: 'local', http: cfg({ dateGateField: null }) })
    )
    expect(events).toHaveLength(1)
    expect(events[0].updatedAt).toBe(pollTime)
  })

  it('caps items at maxItemsPerPoll', async () => {
    const data = Array.from({ length: 5 }, (_, i) => ({ id: i, updated: '2026-06-05T00:00:00Z' }))
    const source = makeHttpEndpointSource({
      execute: async () => ({ status: 200, durationMs: 1, body: { data } }),
      now: () => Date.parse('2026-06-06T00:00:00Z')
    })
    const events = await collect(
      source.poll({ since: 0, hostId: 'local', http: cfg({ maxItemsPerPoll: 2 }) })
    )
    expect(events).toHaveLength(2)
  })

  it('does not let gated-out items consume the cap', async () => {
    // Interleave gated-out items; the cap must bound EMITTED events, so the two
    // yielded must be the non-gated ones (id 1, 3), not the first two scanned.
    const data = [
      { id: 0, updated: '2026-05-01T00:00:00Z' }, // gated out
      { id: 1, updated: '2026-06-05T00:00:00Z' },
      { id: 2, updated: '2026-05-02T00:00:00Z' }, // gated out
      { id: 3, updated: '2026-06-05T00:00:00Z' },
      { id: 4, updated: '2026-06-05T00:00:00Z' }
    ]
    const source = makeHttpEndpointSource({
      execute: async () => ({ status: 200, durationMs: 1, body: { data } }),
      now: () => Date.parse('2026-06-06T00:00:00Z')
    })
    const events = await collect(
      source.poll({
        since: Date.parse('2026-06-01T00:00:00Z'),
        hostId: 'local',
        http: cfg({ maxItemsPerPoll: 2 })
      })
    )
    expect(events.map((e) => e.entityId)).toEqual(['[1]', '[3]'])
  })

  it('merges a referenced connection (base URL + headers) before polling', async () => {
    const conn = {
      id: 'c1',
      displayName: 'A',
      baseUrl: 'https://api.acme.dev',
      headers: [{ key: 'Authorization', value: 'Bearer xyz', secret: true }]
    }
    let seen: HttpRequestConfig | undefined
    const source = makeHttpEndpointSource({
      execute: async (req) => {
        seen = req
        return { status: 200, durationMs: 1, body: { data: [] } }
      },
      getConnection: (id) => (id === 'c1' ? conn : undefined),
      now: () => Date.parse('2026-06-06T00:00:00Z')
    })
    await collect(
      source.poll({
        since: 0,
        hostId: 'local',
        http: cfg({
          connectionId: 'c1',
          request: { method: 'GET', url: '/items', headers: [], query: [] }
        })
      })
    )
    expect(seen?.url).toBe('https://api.acme.dev/items')
    expect(seen?.headers).toContainEqual({
      key: 'Authorization',
      value: 'Bearer xyz',
      secret: true
    })
  })

  it('throws on non-2xx so the engine logs + skips dispatch', async () => {
    const source = makeHttpEndpointSource({
      execute: async () => ({ status: 503, durationMs: 1, body: 'down' }),
      now: () => 0
    })
    await expect(collect(source.poll({ since: 0, hostId: 'local', http: cfg() }))).rejects.toThrow()
  })
})
