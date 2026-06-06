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
  for (const h of request.headers) {
    if (h.key) {
      headers.set(h.key, h.value)
    }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const started = now()
  try {
    const res = await fetchImpl(url.toString(), {
      method: request.method,
      headers,
      // Why: GET/HEAD can't carry a body; only attach it for mutating methods.
      body: request.method === 'GET' ? undefined : request.body,
      redirect: 'follow',
      signal: controller.signal
    })
    const text = await readCapped(res, opts.maxBytes ?? DEFAULT_MAX_BYTES)
    const body = parseMaybeJson(text)
    return { status: res.status, durationMs: now() - started, body }
  } finally {
    clearTimeout(timer)
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const text = await res.text()
  if (text.length > maxBytes) {
    throw new Error(`Response exceeded ${maxBytes} bytes`)
  }
  return text
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text // Why: non-JSON endpoints still return a usable string body.
  }
}
