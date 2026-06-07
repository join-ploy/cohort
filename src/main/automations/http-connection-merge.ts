import type { HttpConnection, HttpRequestConfig } from '../../shared/automations-types'

// Join a connection base URL to a node path with exactly one slash between them,
// so neither a trailing slash on the base nor a leading slash on the path doubles up.
export function joinConnectionUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const suffix = path.replace(/^\/+/, '')
  if (suffix === '') {
    // Why: an empty path keeps the base's single trailing slash, not a bare base.
    return `${base}/`
  }
  return `${base}/${suffix}`
}

// Merge a reusable connection's base URL + headers into a node request. Connection
// headers apply first; a node header with the same key overrides (and the node's
// query/body/method are kept as-is). No decryption here — the caller decrypts the
// merged request right before firing. No connection => request returned unchanged.
export function mergeConnectionRequest(
  request: HttpRequestConfig,
  connection: HttpConnection | undefined
): HttpRequestConfig {
  if (!connection) {
    return request
  }
  const nodeKeys = new Set(request.headers.map((h) => h.key))
  return {
    ...request,
    url: joinConnectionUrl(connection.baseUrl, request.url),
    headers: [...connection.headers.filter((h) => !nodeKeys.has(h.key)), ...request.headers]
  }
}
