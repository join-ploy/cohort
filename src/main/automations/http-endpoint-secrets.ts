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
  return incoming.map((kv, i) => {
    if (!kv.secret) {
      return kv
    }
    if (kv.value !== HTTP_SECRET_MASK) {
      return { ...kv, value: encryptSecret(kv.value) }
    }
    // Why: the editor edits these arrays in place, so position — not key — is the
    // stable correlator across a load→edit→save round-trip. Key-matching mis-pairs
    // legal duplicate keys and wipes a secret whose key was renamed.
    const prior = existing[i]
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
      const prior = savedArr?.[i]
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
