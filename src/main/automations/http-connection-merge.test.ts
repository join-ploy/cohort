import { describe, it, expect } from 'vitest'
import { joinConnectionUrl, mergeConnectionRequest } from './http-connection-merge'

describe('joinConnectionUrl', () => {
  it('joins base + path with exactly one slash', () => {
    expect(joinConnectionUrl('https://a.dev', '/x')).toBe('https://a.dev/x')
    expect(joinConnectionUrl('https://a.dev/', '/x')).toBe('https://a.dev/x')
    expect(joinConnectionUrl('https://a.dev', 'x')).toBe('https://a.dev/x')
    expect(joinConnectionUrl('https://a.dev/', '')).toBe('https://a.dev/')
  })
})

describe('mergeConnectionRequest', () => {
  it('merges connection base+headers into a node request (node header wins on key)', () => {
    const conn = {
      id: 'c1',
      displayName: 'A',
      baseUrl: 'https://a.dev',
      headers: [
        { key: 'X-Key', value: 'k' },
        { key: 'X-Conn', value: 'c' }
      ]
    }
    const req = {
      method: 'POST' as const,
      url: '/v1/things',
      headers: [{ key: 'X-Key', value: 'override' }],
      query: [],
      body: '{}'
    }
    const merged = mergeConnectionRequest(req, conn)
    expect(merged.url).toBe('https://a.dev/v1/things')
    // connection headers first, node overrides same key
    expect(merged.headers).toEqual([
      { key: 'X-Conn', value: 'c' },
      { key: 'X-Key', value: 'override' }
    ])
    expect(merged.query).toEqual([])
  })

  it('returns the request unchanged when no connection', () => {
    const req = {
      method: 'GET' as const,
      url: 'https://x/y',
      headers: [],
      query: []
    }
    expect(mergeConnectionRequest(req, undefined)).toEqual(req)
  })
})
