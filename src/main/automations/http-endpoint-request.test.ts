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
})
