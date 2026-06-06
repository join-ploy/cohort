import { encryptSecret, decryptSecret } from '../secret-encryption'
import {
  HTTP_SECRET_MASK,
  type AutoTrigger,
  type HttpKeyValue,
  type HttpRequestConfig
} from '../../shared/automations-types'

// On save: encrypt freshly typed secrets; reuse stored ciphertext when the
// renderer sent back the mask (i.e. the user didn't change it).
export function sealHttpKeyValues(
  incoming: HttpKeyValue[],
  existing: HttpKeyValue[]
): HttpKeyValue[] {
  return incoming.map((kv) => {
    if (!kv.secret) {
      return kv
    }
    if (kv.value === HTTP_SECRET_MASK) {
      const prior = existing.find((e) => e.key === kv.key && e.secret)
      return { ...kv, value: prior?.value ?? '' }
    }
    return { ...kv, value: encryptSecret(kv.value) }
  })
}

// On read for the renderer: never expose ciphertext or plaintext secrets.
export function maskHttpKeyValues(values: HttpKeyValue[]): HttpKeyValue[] {
  return values.map((kv) => (kv.secret ? { ...kv, value: HTTP_SECRET_MASK } : kv))
}

// In-main, just before a request: turn ciphertext back into plaintext.
export function decryptHttpRequest(request: HttpRequestConfig): HttpRequestConfig {
  return {
    ...request,
    headers: request.headers.map((h) => (h.secret ? { ...h, value: decryptSecret(h.value) } : h)),
    query: request.query.map((q) => (q.secret ? { ...q, value: decryptSecret(q.value) } : q)),
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
