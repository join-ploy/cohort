import { encryptSecret, decryptSecret } from '../secret-encryption'
import {
  HTTP_SECRET_MASK,
  type AutoTrigger,
  type HttpConnection,
  type HttpKeyValue,
  type HttpRequestConfig,
  type HttpRequestStepConfig,
  type Step,
  type StepOrGroup
} from '../../shared/automations-types'

// On save: encrypt freshly typed secrets; reuse stored ciphertext when the
// renderer sent back the mask (i.e. the user didn't change it).
export function sealHttpKeyValues(
  incoming: HttpKeyValue[],
  existing: HttpKeyValue[]
): HttpKeyValue[] {
  return incoming.map((kv, i) => {
    if (!kv.secret) {
      return kv
    }
    if (kv.value !== HTTP_SECRET_MASK) {
      return { ...kv, value: encryptSecret(kv.value) }
    }
    // Why: correlate a masked (unchanged) secret to its prior by stable id first so
    // deleting/reordering other rows can't shift it onto the wrong key. Fall back to
    // positional only for legacy id-less rows — still preserving the rename and
    // duplicate-key wins of index matching. An id with no id-matched prior secret is
    // a genuinely missing prior, so it warns and clears below.
    const prior = kv.id ? existing.find((e) => e.id === kv.id && e.secret) : existing[i]
    if (prior?.secret) {
      return { ...kv, value: prior.value }
    }
    console.warn(
      `[http-endpoint-secrets] masked secret had no prior ciphertext at index ${i} (key "${kv.key}") — clearing.`
    )
    return { ...kv, value: '' }
  })
}

// On read for the renderer: never expose ciphertext or plaintext secrets.
export function maskHttpKeyValues(values: HttpKeyValue[]): HttpKeyValue[] {
  return values.map((kv) => (kv.secret ? { ...kv, value: HTTP_SECRET_MASK } : kv))
}

// Resolve a draft Test/fetch request's secrets to PLAINTEXT: a masked (unchanged)
// secret reuses the saved ciphertext POSITIONALLY (mirroring sealHttpKeyValues) and
// is decrypted; a freshly-typed secret is already plaintext and passes through.
export function resolveDraftRequestSecrets(
  request: HttpRequestConfig,
  saved?: HttpRequestConfig
): HttpRequestConfig {
  const resolveKv = (incoming: HttpKeyValue[], savedArr?: HttpKeyValue[]): HttpKeyValue[] =>
    incoming.map((kv, i) => {
      if (!kv.secret) {
        return kv
      }
      // Why: a non-mask value is freshly typed plaintext — never run it through decrypt.
      if (kv.value !== HTTP_SECRET_MASK) {
        return kv
      }
      // Why: id-first correlation mirrors sealHttpKeyValues so a deleted/reordered
      // row can't resolve a masked secret against the wrong saved ciphertext;
      // positional fallback only for legacy id-less rows.
      const prior = kv.id ? savedArr?.find((e) => e.id === kv.id && e.secret) : savedArr?.[i]
      return { ...kv, value: prior?.secret ? decryptSecret(prior.value) : '' }
    })
  let body = request.body
  if (request.bodySecret && body === HTTP_SECRET_MASK) {
    body = saved?.bodySecret && saved.body ? decryptSecret(saved.body) : ''
  }
  return {
    ...request,
    headers: resolveKv(request.headers, saved?.headers),
    query: resolveKv(request.query, saved?.query),
    body
  }
}

// Decrypt a key/value list's secret values to plaintext (connection headers are
// ciphertext at rest and must be decrypted before merging into a node request).
export function decryptHttpKeyValues(values: HttpKeyValue[]): HttpKeyValue[] {
  return values.map((kv) => (kv.secret ? { ...kv, value: decryptSecret(kv.value) } : kv))
}

// In-main, just before a request: turn ciphertext back into plaintext.
export function decryptHttpRequest(request: HttpRequestConfig): HttpRequestConfig {
  return {
    ...request,
    headers: decryptHttpKeyValues(request.headers),
    query: decryptHttpKeyValues(request.query),
    body: request.bodySecret && request.body ? decryptSecret(request.body) : request.body
  }
}

// Seal every http-endpoint trigger's request secrets against the prior saved
// triggers (matched by trigger id) so unchanged masked values keep their ciphertext.
export function sealAutoTriggers(
  next: AutoTrigger[] | undefined,
  prior: AutoTrigger[] | undefined
): AutoTrigger[] | undefined {
  if (!next) {
    return next
  }
  return next.map((t) => {
    if (t.source !== 'http-endpoint' || !t.http) {
      return t
    }
    const priorReq = prior?.find((p) => p.id === t.id)?.http?.request
    return {
      ...t,
      http: {
        ...t.http,
        request: {
          ...t.http.request,
          headers: sealHttpKeyValues(t.http.request.headers, priorReq?.headers ?? []),
          query: sealHttpKeyValues(t.http.request.query, priorReq?.query ?? []),
          body: sealBody(t.http.request, priorReq)
        }
      }
    }
  })
}

function sealBody(req: HttpRequestConfig, prior?: HttpRequestConfig): string | undefined {
  if (!req.bodySecret || req.body === undefined) {
    return req.body
  }
  if (req.body === HTTP_SECRET_MASK) {
    // Why: a single body has no index; warn rather than silently wipe the secret on loss.
    if (prior?.body === undefined) {
      console.warn(
        '[http-endpoint-secrets] masked request body had no prior ciphertext — clearing.'
      )
    }
    return prior?.body
  }
  return encryptSecret(req.body)
}

export function maskAutoTriggers(triggers: AutoTrigger[] | undefined): AutoTrigger[] | undefined {
  if (!triggers) {
    return triggers
  }
  return triggers.map((t) => {
    if (t.source !== 'http-endpoint' || !t.http) {
      return t
    }
    return {
      ...t,
      http: {
        ...t.http,
        request: {
          ...t.http.request,
          headers: maskHttpKeyValues(t.http.request.headers),
          query: maskHttpKeyValues(t.http.request.query),
          body:
            t.http.request.bodySecret && t.http.request.body
              ? HTTP_SECRET_MASK
              : t.http.request.body
        }
      }
    }
  })
}

// Seal every http-request step's request secrets against the prior saved steps
// (matched by step id) so unchanged masked values keep their ciphertext. Walks
// parallel groups; non-http-request steps pass through untouched.
export function sealHttpRequestSteps(
  next: StepOrGroup[] | undefined,
  prior: StepOrGroup[] | undefined
): StepOrGroup[] | undefined {
  if (!next) {
    return next
  }
  const priorById = new Map<string, Step>()
  for (const item of prior ?? []) {
    for (const step of Array.isArray(item) ? item : [item]) {
      priorById.set(step.id, step)
    }
  }
  const sealStep = (step: Step): Step => {
    if (step.kind !== 'http-request') {
      return step
    }
    const config = step.config as HttpRequestStepConfig
    const priorReq = (priorById.get(step.id)?.config as HttpRequestStepConfig | undefined)?.request
    return {
      ...step,
      config: {
        ...config,
        request: {
          ...config.request,
          headers: sealHttpKeyValues(config.request.headers, priorReq?.headers ?? []),
          query: sealHttpKeyValues(config.request.query, priorReq?.query ?? []),
          body: sealBody(config.request, priorReq)
        }
      }
    }
  }
  return next.map((item) => (Array.isArray(item) ? item.map(sealStep) : sealStep(item)))
}

// On read for the renderer: never expose http-request step secret ciphertext.
export function maskHttpRequestSteps(steps: StepOrGroup[] | undefined): StepOrGroup[] | undefined {
  if (!steps) {
    return steps
  }
  const maskStep = (step: Step): Step => {
    if (step.kind !== 'http-request') {
      return step
    }
    const config = step.config as HttpRequestStepConfig
    return {
      ...step,
      config: {
        ...config,
        request: {
          ...config.request,
          headers: maskHttpKeyValues(config.request.headers),
          query: maskHttpKeyValues(config.request.query),
          body:
            config.request.bodySecret && config.request.body
              ? HTTP_SECRET_MASK
              : config.request.body
        }
      }
    }
  }
  return steps.map((item) => (Array.isArray(item) ? item.map(maskStep) : maskStep(item)))
}

// Seal each connection's header secrets against the prior saved connections
// (matched by connection id) so unchanged masked values keep their ciphertext.
export function sealHttpConnections(
  incoming: HttpConnection[],
  existing: HttpConnection[]
): HttpConnection[] {
  return incoming.map((conn) => {
    const priorHeaders = existing.find((c) => c.id === conn.id)?.headers ?? []
    return { ...conn, headers: sealHttpKeyValues(conn.headers, priorHeaders) }
  })
}

// On read for the renderer: never expose connection secret ciphertext.
export function maskHttpConnections(connections: HttpConnection[]): HttpConnection[] {
  return connections.map((conn) => ({ ...conn, headers: maskHttpKeyValues(conn.headers) }))
}
