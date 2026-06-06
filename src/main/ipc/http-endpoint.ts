import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import { decryptHttpRequest } from '../automations/http-endpoint-secrets'
import {
  executeHttpEndpointRequest,
  type HttpEndpointResponse
} from '../automations/http-endpoint-request'
import {
  resolveItems,
  mapItemToVariables,
  buildDedupKey,
  getByPath
} from '../../shared/http-endpoint-mapping'
import {
  HTTP_SECRET_MASK,
  type HttpEndpointItem,
  type HttpKeyValue,
  type HttpRequestConfig
} from '../../shared/automations-types'

export type HttpEndpointIpcDeps = {
  store: Store
  // Injectable for tests; defaults to the real executor (request already decrypted).
  execute?: (request: HttpRequestConfig) => Promise<HttpEndpointResponse>
}

// Resolve mask sentinels in a draft request against the saved trigger's stored
// ciphertext, then decrypt for execution. Lets the Test button fire with secrets
// the renderer never sees.
export function resolveDraftRequest(
  store: Store,
  request: HttpRequestConfig,
  automationId?: string,
  autoTriggerId?: string
): HttpRequestConfig {
  const saved = automationId
    ? store
        .listAutomations()
        .find((a) => a.id === automationId)
        ?.autoTriggers?.find((t) => t.id === autoTriggerId)?.http?.request
    : undefined
  const merge = (kv: HttpKeyValue): HttpKeyValue => {
    if (kv.secret && kv.value === HTTP_SECRET_MASK) {
      const prior = saved?.headers
        .concat(saved?.query ?? [])
        .find((s) => s.key === kv.key && s.secret)
      return { ...kv, value: prior?.value ?? '' }
    }
    return kv
  }
  return decryptHttpRequest({
    ...request,
    headers: request.headers.map(merge),
    query: request.query.map(merge)
  })
}

export async function runTest(
  deps: HttpEndpointIpcDeps,
  args: { request: HttpRequestConfig; automationId?: string; autoTriggerId?: string }
): Promise<HttpEndpointResponse> {
  const execute = deps.execute ?? executeHttpEndpointRequest
  const resolved = resolveDraftRequest(
    deps.store,
    args.request,
    args.automationId,
    args.autoTriggerId
  )
  const res = await execute(resolved)
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
  const res = await execute(decryptHttpRequest(cfg.request))
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status}`)
  }
  const items = resolveItems(res.body, cfg.itemsPath)
  return items.map((item, i) => {
    const vars = mapItemToVariables(item, cfg.fields)
    return {
      key: cfg.dedupeFields.length ? buildDedupKey(item, cfg.dedupeFields) : String(i),
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
      args: { request: HttpRequestConfig; automationId?: string; autoTriggerId?: string }
    ): Promise<HttpEndpointResponse> => runTest(deps, args)
  )
  ipcMain.handle(
    'httpEndpoint:fetchItems',
    (_e, args: { automationId: string; autoTriggerId: string }): Promise<HttpEndpointItem[]> =>
      runFetchItems(deps, args)
  )
}
