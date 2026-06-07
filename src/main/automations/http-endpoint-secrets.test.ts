import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false }
}))

import {
  sealHttpKeyValues,
  maskHttpKeyValues,
  decryptHttpKeyValues,
  decryptHttpRequest,
  resolveDraftRequestSecrets,
  sealAutoTriggers,
  maskAutoTriggers,
  sealHttpConnections,
  maskHttpConnections,
  sealHttpRequestSteps,
  maskHttpRequestSteps
} from './http-endpoint-secrets'
import {
  HTTP_SECRET_MASK,
  type AutoTrigger,
  type HttpConnection,
  type HttpEndpointConfig,
  type HttpRequestConfig,
  type HttpRequestStepConfig,
  type Step,
  type StepOrGroup
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

describe('sealHttpKeyValues — stable id correlation (FIX I1)', () => {
  it('keeps a masked secret matched by id when a non-secret row above it is deleted', () => {
    const existing = [
      { id: 'a', key: 'X', value: 'plain' },
      { id: 'b', key: 'Auth', value: 'CIPHER', secret: true as const }
    ]
    // Renderer deleted row 'a'; the masked secret 'b' is now at index 0.
    const incoming = [{ id: 'b', key: 'Auth', value: HTTP_SECRET_MASK, secret: true as const }]
    const [out] = sealHttpKeyValues(incoming, existing)
    expect(out.value).toBe('CIPHER') // matched by id 'b', not positional index 0
  })

  it('does not swap ciphertext when two id-bearing secrets are reordered', () => {
    const existing = [
      { id: 'a', key: 'A', value: 'CIPHER_A', secret: true as const },
      { id: 'b', key: 'B', value: 'CIPHER_B', secret: true as const }
    ]
    const incoming = [
      { id: 'b', key: 'B', value: HTTP_SECRET_MASK, secret: true as const },
      { id: 'a', key: 'A', value: HTTP_SECRET_MASK, secret: true as const }
    ]
    const out = sealHttpKeyValues(incoming, existing)
    expect(out.map((kv) => kv.value)).toEqual(['CIPHER_B', 'CIPHER_A'])
  })

  it('warns and clears a masked secret whose id has no prior match (genuine loss)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const existing = [{ id: 'a', key: 'A', value: 'CIPHER', secret: true as const }]
    const [out] = sealHttpKeyValues(
      [{ id: 'missing', key: 'A', value: HTTP_SECRET_MASK, secret: true as const }],
      existing
    )
    expect(out.value).toBe('') // does NOT fall through to positional index 0
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('maskHttpKeyValues', () => {
  it('replaces secret values with the mask', () => {
    expect(maskHttpKeyValues([secret('CIPHER')])[0].value).toBe(HTTP_SECRET_MASK)
  })

  it('preserves the row id so it round-trips back through the renderer', () => {
    const out = maskHttpKeyValues([{ id: 'a', key: 'Auth', value: 'CIPHER', secret: true }])
    expect(out[0].id).toBe('a')
    expect(out[0].value).toBe(HTTP_SECRET_MASK)
  })
})

describe('decryptHttpKeyValues', () => {
  it('decrypts a secret kv and leaves a non-secret kv untouched', () => {
    const out = decryptHttpKeyValues([secret('CIPHER'), { key: 'X', value: 'plain' }])
    expect(out[0].value).toBe('CIPHER') // identity decryption in test
    expect(out[0].secret).toBe(true)
    expect(out[1]).toEqual({ key: 'X', value: 'plain' })
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

  it('resolves a masked secret by id after a non-secret row above it was deleted', () => {
    const saved = req({
      headers: [
        { id: 'a', key: 'X', value: 'plain' },
        { id: 'b', key: 'Auth', value: 'CIPHER', secret: true }
      ]
    })
    const draft = req({
      headers: [{ id: 'b', key: 'Auth', value: HTTP_SECRET_MASK, secret: true }]
    })
    const out = resolveDraftRequestSecrets(draft, saved)
    expect(out.headers[0].value).toBe('CIPHER') // identity decrypt of the id-matched ciphertext
  })

  it('does not swap when two id-bearing secrets are reordered', () => {
    const saved = req({
      headers: [
        { id: 'a', key: 'A', value: 'CIPHER_A', secret: true },
        { id: 'b', key: 'B', value: 'CIPHER_B', secret: true }
      ]
    })
    const draft = req({
      headers: [
        { id: 'b', key: 'B', value: HTTP_SECRET_MASK, secret: true },
        { id: 'a', key: 'A', value: HTTP_SECRET_MASK, secret: true }
      ]
    })
    const out = resolveDraftRequestSecrets(draft, saved)
    expect(out.headers.map((h) => h.value)).toEqual(['CIPHER_B', 'CIPHER_A'])
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

describe('sealHttpConnections', () => {
  it('seals fresh connection secrets and reuses ciphertext for masked ones by id', () => {
    // Decoy prior at index 0 with different ciphertext: positional matching
    // would grab 'WRONG', so a passing assertion proves id correlation.
    const prior: HttpConnection[] = [
      {
        id: 'c0',
        displayName: 'Z',
        baseUrl: 'https://z',
        headers: [{ id: 'h1', key: 'X-Key', value: 'WRONG', secret: true }]
      },
      {
        id: 'c1',
        displayName: 'A',
        baseUrl: 'https://a',
        headers: [{ id: 'h1', key: 'X-Key', value: 'CIPHER', secret: true }]
      }
    ]
    const incoming: HttpConnection[] = [
      {
        id: 'c1',
        displayName: 'A',
        baseUrl: 'https://a',
        headers: [{ id: 'h1', key: 'X-Key', value: HTTP_SECRET_MASK, secret: true }]
      }
    ]
    const sealed = sealHttpConnections(incoming, prior)
    expect(sealed[0].headers[0].value).toBe('CIPHER')
  })

  it('encrypts a freshly typed connection secret', () => {
    const incoming: HttpConnection[] = [
      {
        id: 'c1',
        displayName: 'A',
        baseUrl: 'https://a',
        headers: [{ id: 'h1', key: 'X-Key', value: 'plaintext', secret: true }]
      }
    ]
    const sealed = sealHttpConnections(incoming, [])
    // identity encryption in test -> value is the plaintext, still flagged secret
    expect(sealed[0].headers[0].secret).toBe(true)
    expect(sealed[0].headers[0].value).toBe('plaintext')
  })
})

describe('maskHttpConnections', () => {
  it('masks all connection secrets for the renderer', () => {
    const sealed: HttpConnection[] = [
      {
        id: 'c1',
        displayName: 'A',
        baseUrl: 'https://a',
        headers: [{ id: 'h1', key: 'X-Key', value: 'CIPHER', secret: true }]
      }
    ]
    const masked = maskHttpConnections(sealed)
    expect(masked[0].headers[0].value).toBe(HTTP_SECRET_MASK)
  })

  it('leaves non-secret headers untouched when masking', () => {
    const sealed: HttpConnection[] = [
      {
        id: 'c1',
        displayName: 'A',
        baseUrl: 'https://a',
        headers: [{ id: 'h1', key: 'X-Plain', value: 'visible' }]
      }
    ]
    expect(maskHttpConnections(sealed)[0].headers[0].value).toBe('visible')
  })
})

const httpStep = (id: string, request: Partial<HttpRequestConfig> = {}): Step => ({
  id,
  kind: 'http-request',
  config: {
    request: { method: 'GET', url: '/x', headers: [], query: [], ...request },
    itemsPath: null,
    fields: []
  },
  onFailure: 'halt',
  timeoutSeconds: null
})

const runCommandStep = (id: string): Step => ({
  id,
  kind: 'run-command',
  config: { worktreeRef: 'main', source: 'custom', customCommand: 'ls', captureStdout: true },
  onFailure: 'halt',
  timeoutSeconds: null
})

const stepConfig = (step: Step): HttpRequestStepConfig => step.config as HttpRequestStepConfig

describe('sealHttpRequestSteps', () => {
  it('returns undefined input unchanged', () => {
    expect(sealHttpRequestSteps(undefined, undefined)).toBeUndefined()
  })

  it('reuses prior ciphertext for a masked secret matched by step id (decoy proves id, not position)', () => {
    // Decoy prior at index 0 carries different ciphertext under the SAME header id,
    // so positional step matching would seal 'WRONG' — a 'CIPHER' result proves id correlation.
    const prior: StepOrGroup[] = [
      httpStep('s0', {
        headers: [{ id: 'h1', key: 'Authorization', value: 'WRONG', secret: true }]
      }),
      httpStep('s1', {
        headers: [{ id: 'h1', key: 'Authorization', value: 'CIPHER', secret: true }]
      })
    ]
    const next: StepOrGroup[] = [
      httpStep('s1', {
        headers: [{ id: 'h1', key: 'Authorization', value: HTTP_SECRET_MASK, secret: true }]
      })
    ]
    const sealed = sealHttpRequestSteps(next, prior) as Step[]
    expect(stepConfig(sealed[0]).request.headers[0].value).toBe('CIPHER')
  })

  it('encrypts a freshly typed step secret (plaintext stays secret)', () => {
    const next: StepOrGroup[] = [
      httpStep('s1', {
        headers: [{ id: 'h1', key: 'Authorization', value: 'Bearer abc', secret: true }],
        query: [{ id: 'q1', key: 'token', value: 'qsecret', secret: true }],
        body: '{"token":"abc"}',
        bodySecret: true
      })
    ]
    const sealed = sealHttpRequestSteps(next, undefined) as Step[]
    const cfg = stepConfig(sealed[0])
    // identity encryption in test → ciphertext equals plaintext, still flagged secret
    expect(cfg.request.headers[0].value).toBe('Bearer abc')
    expect(cfg.request.headers[0].secret).toBe(true)
    expect(cfg.request.query[0].value).toBe('qsecret')
    expect(cfg.request.body).toBe('{"token":"abc"}')
  })

  it('walks parallel groups, sealing an http-request step inside a Step[] group', () => {
    const prior: StepOrGroup[] = [
      [
        httpStep('s1', {
          headers: [{ id: 'h1', key: 'Authorization', value: 'CIPHER', secret: true }]
        })
      ]
    ]
    const next: StepOrGroup[] = [
      [
        httpStep('s1', {
          headers: [{ id: 'h1', key: 'Authorization', value: HTTP_SECRET_MASK, secret: true }]
        })
      ]
    ]
    const sealed = sealHttpRequestSteps(next, prior) as StepOrGroup[]
    const group = sealed[0] as Step[]
    expect(stepConfig(group[0]).request.headers[0].value).toBe('CIPHER')
  })

  it('leaves a non-http-request step untouched', () => {
    const step = runCommandStep('r1')
    const sealed = sealHttpRequestSteps([step], undefined) as Step[]
    expect(sealed[0]).toBe(step)
  })
})

describe('maskHttpRequestSteps', () => {
  it('returns undefined input unchanged', () => {
    expect(maskHttpRequestSteps(undefined)).toBeUndefined()
  })

  it('masks a secret header and secret body, leaves non-secret + non-http steps intact', () => {
    const nonHttp = runCommandStep('r1')
    const steps: StepOrGroup[] = [
      httpStep('s1', {
        headers: [
          { id: 'h1', key: 'Authorization', value: 'CIPHER', secret: true },
          { id: 'h2', key: 'X-Plain', value: 'visible' }
        ],
        body: 'BCIPHER',
        bodySecret: true
      }),
      nonHttp
    ]
    const masked = maskHttpRequestSteps(steps) as Step[]
    const cfg = stepConfig(masked[0])
    expect(cfg.request.headers[0].value).toBe(HTTP_SECRET_MASK)
    expect(cfg.request.headers[1].value).toBe('visible')
    expect(cfg.request.body).toBe(HTTP_SECRET_MASK)
    expect(masked[1]).toBe(nonHttp)
  })

  it('masks an http-request step inside a parallel group', () => {
    const steps: StepOrGroup[] = [
      [
        httpStep('s1', {
          headers: [{ id: 'h1', key: 'Authorization', value: 'CIPHER', secret: true }]
        })
      ]
    ]
    const masked = maskHttpRequestSteps(steps) as StepOrGroup[]
    const group = masked[0] as Step[]
    expect(stepConfig(group[0]).request.headers[0].value).toBe(HTTP_SECRET_MASK)
  })
})
