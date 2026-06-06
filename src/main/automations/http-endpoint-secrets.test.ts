import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false }
}))

import {
  sealHttpKeyValues,
  maskHttpKeyValues,
  decryptHttpRequest,
  sealAutoTriggers,
  maskAutoTriggers
} from './http-endpoint-secrets'
import {
  HTTP_SECRET_MASK,
  type AutoTrigger,
  type HttpEndpointConfig
} from '../../shared/automations-types'

const secret = (value: string) => ({ key: 'Authorization', value, secret: true as const })

describe('sealHttpKeyValues', () => {
  it('encrypts a freshly typed secret (plaintext != mask)', () => {
    const [out] = sealHttpKeyValues([secret('Bearer abc')], [])
    expect(out.value).toBe('Bearer abc') // identity encryption in test
    expect(out.secret).toBe(true)
  })
  it('reuses the existing ciphertext when the incoming value is the mask', () => {
    const existing = [secret('CIPHER')]
    const [out] = sealHttpKeyValues([secret(HTTP_SECRET_MASK)], existing)
    expect(out.value).toBe('CIPHER')
  })
  it('leaves non-secret pairs untouched', () => {
    const [out] = sealHttpKeyValues([{ key: 'X', value: 'plain' }], [])
    expect(out).toEqual({ key: 'X', value: 'plain' })
  })
})

describe('maskHttpKeyValues', () => {
  it('replaces secret values with the mask', () => {
    expect(maskHttpKeyValues([secret('CIPHER')])[0].value).toBe(HTTP_SECRET_MASK)
  })
})

describe('decryptHttpRequest', () => {
  it('decrypts secret header/query/body values', () => {
    const req = decryptHttpRequest({
      method: 'GET',
      url: 'https://x',
      headers: [secret('CIPHER')],
      query: []
    })
    expect(req.headers[0].value).toBe('CIPHER') // identity decryption in test
  })
})

const httpConfig = (over: Partial<HttpEndpointConfig> = {}): HttpEndpointConfig => ({
  request: {
    method: 'GET',
    url: 'https://api.test/items',
    headers: [secret('Bearer abc')],
    query: [{ key: 'q', value: '1' }],
    ...over.request
  },
  itemsPath: 'data',
  fields: [],
  dedupeFields: ['id'],
  dateGateField: null,
  ...over
})

const httpTrigger = (id: string, http: HttpEndpointConfig): AutoTrigger => ({
  id,
  source: 'http-endpoint',
  enabled: true,
  enabledAt: 0,
  rules: [],
  pollingEnabled: true,
  http
})

const linearTrigger: AutoTrigger = {
  id: 'lin-1',
  source: 'linear-issue',
  enabled: true,
  enabledAt: 0,
  rules: []
}

describe('sealAutoTriggers / maskAutoTriggers', () => {
  it('returns undefined inputs unchanged', () => {
    expect(sealAutoTriggers(undefined, undefined)).toBeUndefined()
    expect(maskAutoTriggers(undefined)).toBeUndefined()
  })

  it('passes non-http triggers through untouched', () => {
    const sealed = sealAutoTriggers([linearTrigger], [])
    expect(sealed?.[0]).toBe(linearTrigger)
    const masked = maskAutoTriggers([linearTrigger])
    expect(masked?.[0]).toBe(linearTrigger)
  })

  it('seals http secrets then masks them for the renderer', () => {
    const sealed = sealAutoTriggers([httpTrigger('t1', httpConfig())], [])
    // identity encryption in test → ciphertext equals plaintext
    expect(sealed?.[0].http?.request.headers[0].value).toBe('Bearer abc')
    expect(sealed?.[0].http?.request.query[0].value).toBe('1')

    const masked = maskAutoTriggers(sealed)
    expect(masked?.[0].http?.request.headers[0].value).toBe(HTTP_SECRET_MASK)
    // non-secret query param is left intact
    expect(masked?.[0].http?.request.query[0].value).toBe('1')
  })

  it('reseals a masked no-op edit by reusing the prior ciphertext (matched by id)', () => {
    const prior = sealAutoTriggers([httpTrigger('t1', httpConfig())], [])
    // The renderer echoes back the mask for the unchanged secret.
    const editedFromRenderer = maskAutoTriggers(prior)
    const resealed = sealAutoTriggers(editedFromRenderer, prior)
    expect(resealed?.[0].http?.request.headers[0].value).toBe('Bearer abc')
  })

  it('seals/masks/reuses a secret request body via bodySecret', () => {
    const cfg = httpConfig({
      request: {
        method: 'POST',
        url: 'https://api.test/items',
        headers: [],
        query: [],
        body: '{"token":"abc"}',
        bodySecret: true
      }
    })
    const sealed = sealAutoTriggers([httpTrigger('t1', cfg)], [])
    expect(sealed?.[0].http?.request.body).toBe('{"token":"abc"}') // identity encryption

    const masked = maskAutoTriggers(sealed)
    expect(masked?.[0].http?.request.body).toBe(HTTP_SECRET_MASK)

    const resealed = sealAutoTriggers(masked, sealed)
    expect(resealed?.[0].http?.request.body).toBe('{"token":"abc"}')
  })

  it('leaves a non-secret body untouched through mask + seal', () => {
    const cfg = httpConfig({
      request: {
        method: 'POST',
        url: 'https://api.test/items',
        headers: [],
        query: [],
        body: '{"page":1}'
      }
    })
    const masked = maskAutoTriggers([httpTrigger('t1', cfg)])
    expect(masked?.[0].http?.request.body).toBe('{"page":1}')
    const sealed = sealAutoTriggers([httpTrigger('t1', cfg)], [])
    expect(sealed?.[0].http?.request.body).toBe('{"page":1}')
  })
})
