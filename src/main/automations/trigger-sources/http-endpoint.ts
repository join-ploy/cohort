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
import type { HttpRequestConfig } from '../../../shared/automations-types'
import type { CandidateEvent, PollCtx, TriggerSource } from './types'

export type HttpEndpointSourceDeps = {
  // Injectable for tests; defaults to the real executor with decrypted secrets.
  execute?: (request: HttpRequestConfig) => Promise<HttpEndpointResponse>
  now?: () => number
}

const DEFAULT_MAX_ITEMS = 100

export function makeHttpEndpointSource(deps: HttpEndpointSourceDeps = {}): TriggerSource {
  const now = deps.now ?? Date.now
  const execute =
    deps.execute ?? ((request) => executeHttpEndpointRequest(decryptHttpRequest(request)))

  return {
    id: 'http-endpoint',
    displayName: 'HTTP endpoint',
    fieldCatalog: [], // dynamic per-trigger; the editor builds it from http.fields
    poll: (ctx) => pollHttpEndpoint(ctx, execute, now)
  }
}

async function* pollHttpEndpoint(
  ctx: PollCtx,
  execute: (request: HttpRequestConfig) => Promise<HttpEndpointResponse>,
  now: () => number
): AsyncIterable<CandidateEvent> {
  const cfg = ctx.http
  if (!cfg) {
    return
  }
  const res = await execute(cfg.request)
  if (res.status < 200 || res.status >= 300) {
    // Why: surface as a thrown error so the engine's per-source catch logs it
    // and advances the poll clock without polluting the dedup store.
    throw new Error(`HTTP ${res.status} from ${cfg.request.url}`)
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
