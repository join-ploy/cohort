import {
  buildDedupKey,
  evaluateDateGate,
  getByPath,
  mapItemToVariables,
  parseDateValue,
  resolveItems
} from '../../../shared/http-endpoint-mapping'
import { decryptHttpRequest } from '../http-endpoint-secrets'
import { executeHttpEndpointRequest, type HttpEndpointResponse } from '../http-endpoint-request'
import { mergeConnectionRequest } from '../http-connection-merge'
import type { HttpConnection, HttpRequestConfig } from '../../../shared/automations-types'
import type { CandidateEvent, PollCtx, TriggerSource } from './types'

export type HttpEndpointSourceDeps = {
  // Injectable for tests; defaults to the real executor with decrypted secrets.
  execute?: (request: HttpRequestConfig) => Promise<HttpEndpointResponse>
  // Resolve a referenced connection by id (base URL + sealed headers) at poll time.
  getConnection?: (id: string) => HttpConnection | undefined
  now?: () => number
}

const DEFAULT_MAX_ITEMS = 100

export function makeHttpEndpointSource(deps: HttpEndpointSourceDeps = {}): TriggerSource {
  const now = deps.now ?? Date.now
  const execute =
    deps.execute ?? ((request) => executeHttpEndpointRequest(decryptHttpRequest(request)))
  const getConnection = deps.getConnection ?? (() => undefined)

  return {
    id: 'http-endpoint',
    displayName: 'HTTP endpoint',
    fieldCatalog: [], // dynamic per-trigger; the editor builds it from http.fields
    poll: (ctx) => pollHttpEndpoint(ctx, execute, getConnection, now)
  }
}

async function* pollHttpEndpoint(
  ctx: PollCtx,
  execute: (request: HttpRequestConfig) => Promise<HttpEndpointResponse>,
  getConnection: (id: string) => HttpConnection | undefined,
  now: () => number
): AsyncIterable<CandidateEvent> {
  const cfg = ctx.http
  if (!cfg) {
    return
  }
  // Why: merge BEFORE execute so the default decrypt-wrapped executor decrypts
  // node + connection secrets uniformly (both are ciphertext at rest).
  const connection = cfg.connectionId ? getConnection(cfg.connectionId) : undefined
  if (cfg.connectionId && !connection) {
    // Why: an already-saved trigger can reference a connection deleted later; warn
    // so a silent bare-path request is debuggable on headless/SSH hosts (editor
    // validation in the chain editor can't catch a post-save deletion).
    console.warn(
      `[http-endpoint] trigger references missing connection '${cfg.connectionId}'; firing the path without a base URL.`
    )
  }
  const request = mergeConnectionRequest(cfg.request, connection)
  const res = await execute(request)
  if (res.status < 200 || res.status >= 300) {
    // Why: surface as a thrown error so the engine's per-source catch logs it
    // and advances the poll clock without polluting the dedup store.
    throw new Error(`HTTP ${res.status} from ${request.url}`)
  }
  const items = resolveItems(res.body, cfg.itemsPath)
  const cap = cfg.maxItemsPerPoll ?? DEFAULT_MAX_ITEMS
  let yielded = 0
  for (const item of items) {
    if (yielded >= cap) {
      break
    }
    if (!evaluateDateGate(item, cfg.dateGateField, ctx.since)) {
      continue
    }
    const vars = mapItemToVariables(item, cfg.fields)
    // Why: getByPath (not flat access) so dotted date-gate paths resolve. Use the
    // same `=== null` "no gate" contract as evaluateDateGate so the filter and the
    // updatedAt stamp can't disagree on an empty-string gate field.
    const gateMs =
      cfg.dateGateField !== null ? parseDateValue(getByPath(item, cfg.dateGateField)) : null
    yield {
      entityId: buildDedupKey(item, cfg.dedupeFields),
      // Why: provenance only — the engine re-checks updatedAt >= since, and a
      // no-gate item must pass, so fall back to poll time.
      updatedAt: gateMs ?? now(),
      payload: vars,
      fields: vars
    }
    yielded++
  }
}
