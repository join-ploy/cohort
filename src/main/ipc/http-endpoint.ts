import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import {
  decryptHttpKeyValues,
  decryptHttpRequest,
  resolveDraftRequestSecrets
} from '../automations/http-endpoint-secrets'
import {
  executeHttpEndpointRequest,
  type HttpEndpointResponse
} from '../automations/http-endpoint-request'
import { mergeConnectionRequest } from '../automations/http-connection-merge'
import { blankTemplates } from '../automations/template'
import {
  resolveItems,
  mapItemToVariables,
  buildDedupKey,
  getByPath
} from '../../shared/http-endpoint-mapping'
import {
  type HttpEndpointItem,
  type HttpKeyValue,
  type HttpRequestConfig
} from '../../shared/automations-types'

export type HttpEndpointIpcDeps = {
  store: Store
  // Injectable for tests; defaults to the real executor (request already decrypted).
  execute?: (request: HttpRequestConfig) => Promise<HttpEndpointResponse>
}

// Resolve mask sentinels in a draft request to plaintext against the saved
// trigger's stored secrets (positionally), letting the Test button fire with
// secrets the renderer never sees.
export function resolveDraftRequest(
  store: Store,
  request: HttpRequestConfig,
  automationId?: string,
  autoTriggerId?: string
): HttpRequestConfig {
  const savedRequest = automationId
    ? store
        .listAutomations()
        .find((a) => a.id === automationId)
        ?.autoTriggers?.find((t) => t.id === autoTriggerId)?.http?.request
    : undefined
  return resolveDraftRequestSecrets(request, savedRequest)
}

// Blank unresolved templates in the parts a Test fires with. Secret values are
// left alone (they're resolved separately and never contain templates).
function blankRequestTemplates(request: HttpRequestConfig): HttpRequestConfig {
  const blankKv = (list: HttpKeyValue[]): HttpKeyValue[] =>
    list.map((kv) => (kv.secret ? kv : { ...kv, value: blankTemplates(kv.value) }))
  return {
    ...request,
    url: blankTemplates(request.url),
    headers: blankKv(request.headers),
    query: blankKv(request.query),
    body:
      request.bodySecret || request.body === undefined ? request.body : blankTemplates(request.body)
  }
}

export async function runTest(
  deps: HttpEndpointIpcDeps,
  args: {
    request: HttpRequestConfig
    automationId?: string
    autoTriggerId?: string
    connectionId?: string
  }
): Promise<HttpEndpointResponse> {
  const execute = deps.execute ?? executeHttpEndpointRequest
  // Blank unresolved {{…}} first so upstream refs don't throw or leak literal tokens.
  const blanked = blankRequestTemplates(args.request)
  // Node's OWN secrets → plaintext (masked sentinels resolved against the saved trigger).
  const resolvedNode = resolveDraftRequest(
    deps.store,
    blanked,
    args.automationId,
    args.autoTriggerId
  )
  let final = resolvedNode
  if (args.connectionId) {
    const conn = deps.store.getSettings().httpConnections?.find((c) => c.id === args.connectionId)
    // Why: connection headers are ciphertext at rest — decrypt them SEPARATELY and
    // merge AFTER the node is already plaintext, so we never double-decrypt either side.
    // A dangling connectionId (not found) proceeds unmerged; validation is task D7.
    if (conn) {
      const decryptedConn = { ...conn, headers: decryptHttpKeyValues(conn.headers) }
      final = mergeConnectionRequest(resolvedNode, decryptedConn)
    }
  }
  const res = await execute(final)
  // Why: never echo request secrets back — return only the response triple.
  return { status: res.status, durationMs: res.durationMs, body: res.body }
}

export async function runFetchItems(
  deps: HttpEndpointIpcDeps,
  args: { automationId: string; autoTriggerId: string }
): Promise<HttpEndpointItem[]> {
  const execute = deps.execute ?? executeHttpEndpointRequest
  const trigger = deps.store
    .listAutomations()
    .find((a) => a.id === args.automationId)
    ?.autoTriggers?.find((t) => t.id === args.autoTriggerId)
  const cfg = trigger?.http
  if (!cfg) {
    return []
  }
  // Why: merge the connection BEFORE decrypt so node + connection secrets (both
  // ciphertext at rest) are decrypted uniformly, exactly once.
  const connection = cfg.connectionId
    ? deps.store.getSettings().httpConnections?.find((c) => c.id === cfg.connectionId)
    : undefined
  if (cfg.connectionId && !connection) {
    // Why: warn on a dangling reference (connection deleted after save) so the
    // manual fetch's bare-path request is debuggable rather than silently wrong.
    console.warn(
      `[http-endpoint] trigger references missing connection '${cfg.connectionId}'; fetching the path without a base URL.`
    )
  }
  const res = await execute(decryptHttpRequest(mergeConnectionRequest(cfg.request, connection)))
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status}`)
  }
  const items = resolveItems(res.body, cfg.itemsPath)
  return items.map((item, i) => {
    const vars = mapItemToVariables(item, cfg.fields)
    return {
      // Why: append the index so the picker key is unique even when two items
      // share dedupe-field values — this is a list/selection id, not the poll
      // dedup key, so collisions here would dupe React keys and mis-target Enter.
      key: `${cfg.dedupeFields.length ? buildDedupKey(item, cfg.dedupeFields) : 'item'}#${i}`,
      label: String(cfg.labelField ? (getByPath(item, cfg.labelField) ?? '') : `Item ${i + 1}`),
      subtitle: String(cfg.subtitleField ? (getByPath(item, cfg.subtitleField) ?? '') : ''),
      vars
    }
  })
}

export function registerHttpEndpointHandlers(deps: HttpEndpointIpcDeps): void {
  ipcMain.handle(
    'httpEndpoint:test',
    (
      _e,
      args: {
        request: HttpRequestConfig
        automationId?: string
        autoTriggerId?: string
        connectionId?: string
      }
    ): Promise<HttpEndpointResponse> => runTest(deps, args)
  )
  ipcMain.handle(
    'httpEndpoint:fetchItems',
    (_e, args: { automationId: string; autoTriggerId: string }): Promise<HttpEndpointItem[]> =>
      runFetchItems(deps, args)
  )
}
