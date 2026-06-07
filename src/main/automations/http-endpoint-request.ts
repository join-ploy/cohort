// src/main/automations/http-endpoint-request.ts
import type { HttpRequestConfig } from '../../shared/automations-types'

export type HttpEndpointResponse = {
  status: number
  durationMs: number
  body: unknown
}

export type ExecuteOpts = {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxBytes?: number
  now?: () => number
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 5_000_000 // 5 MB response cap

// Performs one request with the secrets ALREADY decrypted in `request`. Enforces
// scheme allow-list, timeout, and a response-size cap. The caller decrypts.
export async function executeHttpEndpointRequest(
  request: HttpRequestConfig,
  opts: ExecuteOpts = {}
): Promise<HttpEndpointResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? Date.now
  const url = new URL(request.url)
  // Why: block file:/data:/etc. — only outbound http(s) is allowed (SSRF guard).
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme: ${url.protocol}`)
  }
  for (const q of request.query) {
    if (q.key) {
      url.searchParams.append(q.key, q.value)
    }
  }
  const headers = new Headers()
  // Why: headers use last-wins set() (vs query append()) so a repeated key overrides.
  for (const h of request.headers) {
    if (h.key) {
      headers.set(h.key, h.value)
    }
  }
  const controller = new AbortController()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // Why: distinguish a timeout-abort from a size-cap cancel — both unwind via
  // the catch below, but only the timer-driven abort should report a timeout.
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const started = now()
  try {
    const res = await fetchImpl(url.toString(), {
      method: request.method,
      headers,
      // Why: GET can't carry a body; only attach it for mutating methods.
      body: request.method === 'GET' ? undefined : request.body,
      redirect: 'follow',
      signal: controller.signal
    })
    const text = await readCapped(res, opts.maxBytes ?? DEFAULT_MAX_BYTES)
    const body = parseMaybeJson(text)
    return { status: res.status, durationMs: now() - started, body }
  } catch (err) {
    // Why: fetch/read reject with an opaque AbortError on timeout; surface the cause.
    if (timedOut) {
      throw new Error(`Request timed out after ${timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const body = res.body
  // Why: some mocks omit a stream body; buffer the text directly in that case.
  if (!body) {
    return res.text()
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let out = ''
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) {
      break
    }
    total += chunk.value.byteLength
    // Why: bound memory by BYTES seen so far — cancel before materializing an
    // oversized body rather than buffering the whole response then measuring it.
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error(`Response exceeded ${maxBytes} bytes`)
    }
    out += decoder.decode(chunk.value, { stream: true })
  }
  out += decoder.decode()
  return out
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text // Why: non-JSON endpoints still return a usable string body.
  }
}
