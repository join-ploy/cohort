import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false }
}))

import {
  sealHttpKeyValues,
  maskHttpKeyValues,
  decryptHttpRequest,
  resolveDraftRequestSecrets,
  sealAutoTriggers,
  maskAutoTriggers
} from './http-endpoint-secrets'
import {
  HTTP_SECRET_MASK,
  type AutoTrigger,
  type HttpEndpointConfig,
  type HttpRequestConfig
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
  it('pairs duplicate-key masked secrets positionally, not first-key-wins', () => {
    const dup = (value: string) => ({ key: 'p', value, secret: true as const })
    const existing = [dup('A'), dup('B')]
    const out = sealHttpKeyValues([dup(HTTP_SECRET_MASK), dup(HTTP_SECRET_MASK)], existing)
    expect(out.map((kv) => kv.value)).toEqual(['A', 'B'])
  })
  it('preserves a renamed secret by position (no data loss)', () => {
    const existing = [{ key: 'Authorizaton', value: 'CIPHER', secret: true as const }]
    const incoming = [{ key: 'Authorization', value: HTTP_SECRET_MASK, secret: true as const }]
    const [out] = sealHttpKeyValues(incoming, existing)
    expect(out.value).toBe('CIPHER')
  })
  it('warns and clears a masked secret with no prior ciphertext at its index', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const [out] = sealHttpKeyValues([secret(HTTP_SECRET_MASK)], [])
    expect(out.value).toBe('')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
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
  it('decrypts a secret query param and a secret body', () => {
    const req = decryptHttpRequest({
      method: 'POST',
      url: 'https://x',
      headers: [],
      query: [{ key: 'token', value: 'QCIPHER', secret: true }],
      body: 'BCIPHER',
      bodySecret: true
    })
    expect(req.query[0].value).toBe('QCIPHER') // identity decryption in test
    expect(req.body).toBe('BCIPHER')
  })
})

describe('resolveDraftRequestSecrets', () => {
  const req = (over: Partial<HttpRequestConfig> = {}): HttpRequestConfig => ({
    method: 'GET',
    url: 'https://x',
    headers: [],
    query: [],
    ...over
  })

  it('resolves a masked secret header to the saved decrypted value positionally', () => {
    const saved = req({ headers: [{ key: 'Authorization', value: 'CIPHER', secret: true }] })
    const draft = req({
      headers: [{ key: 'Authorization', value: HTTP_SECRET_MASK, secret: true }]
    })
    const out = resolveDraftRequestSecrets(draft, saved)
    expect(out.headers[0].value).toBe('CIPHER') // identity decrypt of the reused ciphertext
  })

  it('resolves a same-named secret header AND query to their OWN saved value', () => {
    const saved = req({
      headers: [{ key: 'token', value: 'HCIPHER', secret: true }],
      query: [{ key: 'token', value: 'QCIPHER', secret: true }]
    })
    const draft = req({
      headers: [{ key: 'token', value: HTTP_SECRET_MASK, secret: true }],
      query: [{ key: 'token', value: HTTP_SECRET_MASK, secret: true }]
    })
    const out = resolveDraftRequestSecrets(draft, saved)
    expect(out.headers[0].value).toBe('HCIPHER')
    expect(out.query[0].value).toBe('QCIPHER')
  })

  it('resolves duplicate masked secret keys positionally ([A,B], not [A,A])', () => {
    const dup = (value: string) => ({ key: 'p', value, secret: true as const })
    const saved = req({ headers: [dup('A'), dup('B')] })
    const draft = req({ headers: [dup(HTTP_SECRET_MASK), dup(HTTP_SECRET_MASK)] })
    const out = resolveDraftRequestSecrets(draft, saved)
    expect(out.headers.map((h) => h.value)).toEqual(['A', 'B'])
  })

  it('passes a freshly typed (non-mask) secret through unchanged', () => {
    const draft = req({ headers: [{ key: 'Authorization', value: 'Bearer typed', secret: true }] })
    const out = resolveDraftRequestSecrets(draft, undefined)
    expect(out.headers[0].value).toBe('Bearer typed')
  })

  it('clears a masked secret with no saved counterpart at its index', () => {
    const draft = req({
      headers: [{ key: 'Authorization', value: HTTP_SECRET_MASK, secret: true }]
    })
    const out = resolveDraftRequestSecrets(draft, undefined)
    expect(out.headers[0].value).toBe('')
  })

  it('resolves a masked secret body to the saved body; passes a non-mask body through', () => {
    const saved = req({ body: 'BCIPHER', bodySecret: true })
    const masked = resolveDraftRequestSecrets(
      req({ body: HTTP_SECRET_MASK, bodySecret: true }),
      saved
    )
    expect(masked.body).toBe('BCIPHER') // identity decrypt of the saved body

    const typed = resolveDraftRequestSecrets(req({ body: '{"new":1}', bodySecret: true }), saved)
    expect(typed.body).toBe('{"new":1}')
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

  it('does not mutate the input http trigger', () => {
    const trigger = httpTrigger('t1', httpConfig())
    sealAutoTriggers([trigger], [])
    maskAutoTriggers([trigger])
    expect(trigger.http?.request.headers[0].value).toBe('Bearer abc')
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
