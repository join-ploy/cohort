// src/main/automations/http-endpoint-request.test.ts
import { describe, it, expect } from 'vitest'
import { executeHttpEndpointRequest } from './http-endpoint-request'
import type { HttpRequestConfig } from '../../shared/automations-types'

const base: HttpRequestConfig = {
  method: 'GET',
  url: 'https://api.test/items',
  headers: [],
  query: []
}

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    })) as unknown as typeof fetch
}

describe('executeHttpEndpointRequest', () => {
  it('returns parsed JSON body + status', async () => {
    const res = await executeHttpEndpointRequest(base, { fetchImpl: fakeFetch([{ id: 1 }]) })
    expect(res.status).toBe(200)
    expect(res.body).toEqual([{ id: 1 }])
  })

  it('appends query params to the URL', async () => {
    let seenUrl = ''
    const spy = (async (url: string) => {
      seenUrl = url
      return new Response('[]', { status: 200 })
    }) as unknown as typeof fetch
    await executeHttpEndpointRequest(
      { ...base, query: [{ key: 'a', value: '1' }] },
      { fetchImpl: spy }
    )
    expect(seenUrl).toContain('a=1')
  })

  it('rejects non-http(s) schemes', async () => {
    await expect(
      executeHttpEndpointRequest(
        { ...base, url: 'file:///etc/passwd' },
        { fetchImpl: fakeFetch({}) }
      )
    ).rejects.toThrow(/scheme/i)
  })

  it('throws when the streamed body exceeds maxBytes', async () => {
    const big = (async () => new Response('x'.repeat(100))) as unknown as typeof fetch
    await expect(
      executeHttpEndpointRequest(base, { fetchImpl: big, maxBytes: 10 })
    ).rejects.toThrow(/exceeded/)
  })

  it('surfaces an aborted request as a timeout error', async () => {
    // Why: this fetch settles only when the abort signal fires, simulating a hang.
    const hang = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError'))
        )
      })) as unknown as typeof fetch
    await expect(
      executeHttpEndpointRequest(base, { fetchImpl: hang, timeoutMs: 10 })
    ).rejects.toThrow(/timed out/i)
  })

  it('computes durationMs from the injected clock', async () => {
    const stamps = [1000, 1500]
    let i = 0
    const now = (): number => stamps[i++] ?? 1500
    const res = await executeHttpEndpointRequest(base, { fetchImpl: fakeFetch([]), now })
    expect(res.durationMs).toBe(500)
  })

  it('attaches the body for non-GET requests', async () => {
    let seenBody: unknown
    const spy = ((_url: string, init: RequestInit) => {
      seenBody = init.body
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    await executeHttpEndpointRequest(
      { ...base, method: 'POST', body: '{"x":1}' },
      { fetchImpl: spy }
    )
    expect(seenBody).toBe('{"x":1}')
  })

  it('returns a non-JSON body unchanged', async () => {
    const text = (async () => new Response('plain text, not json')) as unknown as typeof fetch
    const res = await executeHttpEndpointRequest(base, { fetchImpl: text })
    expect(res.body).toBe('plain text, not json')
  })
})
