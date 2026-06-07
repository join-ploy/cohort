import {
  HTTP_SECRET_MASK,
  type AutoTrigger,
  type HttpEndpointConfig,
  type HttpKeyValue,
  type HttpRequestConfig,
  type MappedField
} from '../../../../../shared/automations-types'

// Why: every reducer is a no-op on a trigger with no http config so a stray
// call can't corrupt a linear/github trigger. Returns the same reference when
// there's nothing to do.
function withHttp(
  trigger: AutoTrigger,
  update: (http: HttpEndpointConfig) => HttpEndpointConfig
): AutoTrigger {
  if (!trigger.http) {
    return trigger
  }
  return { ...trigger, http: update(trigger.http) }
}

function withRequest(
  trigger: AutoTrigger,
  update: (request: HttpRequestConfig) => HttpRequestConfig
): AutoTrigger {
  return withHttp(trigger, (http) => ({ ...http, request: update(http.request) }))
}

// --- Request ---------------------------------------------------------------

export function setRequestField(
  trigger: AutoTrigger,
  patch: Partial<HttpRequestConfig>
): AutoTrigger {
  return withRequest(trigger, (request) => ({ ...request, ...patch }))
}

// Select/clear the reusable connection this trigger points at. Clearing returns
// the card to fully-inline mode (URL is an absolute URL again).
export function setConnectionId(
  trigger: AutoTrigger,
  connectionId: string | undefined
): AutoTrigger {
  return withHttp(trigger, (http) => ({ ...http, connectionId }))
}

export function addHeader(trigger: AutoTrigger): AutoTrigger {
  return withRequest(trigger, (request) => ({
    ...request,
    // Why: mint a stable id so secret mask-reuse survives later delete/reorder.
    headers: [...request.headers, { key: '', value: '', id: crypto.randomUUID() }]
  }))
}

export function removeHeader(trigger: AutoTrigger, index: number): AutoTrigger {
  return withRequest(trigger, (request) => ({
    ...request,
    headers: request.headers.filter((_, i) => i !== index)
  }))
}

export function updateHeader(
  trigger: AutoTrigger,
  index: number,
  patch: Partial<HttpKeyValue>
): AutoTrigger {
  return withRequest(trigger, (request) => ({
    ...request,
    headers: request.headers.map((h, i) => (i === index ? { ...h, ...patch } : h))
  }))
}

export function toggleHeaderSecret(trigger: AutoTrigger, index: number): AutoTrigger {
  return withRequest(trigger, (request) => ({
    ...request,
    headers: request.headers.map((h, i) => {
      if (i !== index) {
        return h
      }
      const secret = !h.secret
      // Why: the mask sentinel must never survive as a non-secret value — clearing
      // it on un-secret mirrors "Replace" so it can't seal/send as a real header.
      if (!secret && h.value === HTTP_SECRET_MASK) {
        return { ...h, secret, value: '' }
      }
      return { ...h, secret }
    })
  }))
}

export function toggleBodySecret(trigger: AutoTrigger): AutoTrigger {
  return withRequest(trigger, (request) => {
    const bodySecret = !request.bodySecret
    // Why: mirror the header fix — un-secreting a sealed body clears the mask
    // sentinel so it can't seal/send as a literal request body.
    if (!bodySecret && request.body === HTTP_SECRET_MASK) {
      return { ...request, bodySecret, body: '' }
    }
    return { ...request, bodySecret }
  })
}

export function addQuery(trigger: AutoTrigger): AutoTrigger {
  return withRequest(trigger, (request) => ({
    ...request,
    // Why: mint a stable id so secret mask-reuse survives later delete/reorder.
    query: [...request.query, { key: '', value: '', id: crypto.randomUUID() }]
  }))
}

export function removeQuery(trigger: AutoTrigger, index: number): AutoTrigger {
  return withRequest(trigger, (request) => ({
    ...request,
    query: request.query.filter((_, i) => i !== index)
  }))
}

export function updateQuery(
  trigger: AutoTrigger,
  index: number,
  patch: Partial<HttpKeyValue>
): AutoTrigger {
  return withRequest(trigger, (request) => ({
    ...request,
    query: request.query.map((q, i) => (i === index ? { ...q, ...patch } : q))
  }))
}

// --- Test-derived field mapping --------------------------------------------

// Why: a re-Test rediscovers fields from a fresh sample. Preserve the user's
// prior enabled/variableName choices for paths that still exist (drift handling)
// so a re-Test never silently resets the mapping or breaks {{trigger.http.*}}.
// Vanished paths drop out; fresh `type`/`sampleValue` are always taken.
export function mergeDiscoveredFields(
  prior: MappedField[],
  discovered: MappedField[]
): MappedField[] {
  const priorByPath = new Map(prior.map((f) => [f.path, f]))
  return discovered.map((field) => {
    const previous = priorByPath.get(field.path)
    if (!previous) {
      return field
    }
    return { ...field, enabled: previous.enabled, variableName: previous.variableName }
  })
}

export type TestMapping = {
  itemsPath: string | null
  fields: MappedField[]
  sampleResponse: unknown
}

export function applyTestMapping(trigger: AutoTrigger, mapping: TestMapping): AutoTrigger {
  return withHttp(trigger, (http) => ({
    ...http,
    itemsPath: mapping.itemsPath,
    sampleResponse: mapping.sampleResponse,
    fields: mergeDiscoveredFields(http.fields, mapping.fields)
  }))
}

export function toggleFieldEnabled(trigger: AutoTrigger, path: string): AutoTrigger {
  return withHttp(trigger, (http) => ({
    ...http,
    fields: http.fields.map((f) => (f.path === path ? { ...f, enabled: !f.enabled } : f))
  }))
}

export function renameField(trigger: AutoTrigger, path: string, variableName: string): AutoTrigger {
  return withHttp(trigger, (http) => ({
    ...http,
    fields: http.fields.map((f) => (f.path === path ? { ...f, variableName } : f))
  }))
}

// --- Poll + manual settings ------------------------------------------------

export function setDedupeFields(trigger: AutoTrigger, dedupeFields: string[]): AutoTrigger {
  return withHttp(trigger, (http) => ({ ...http, dedupeFields }))
}

export function setDateGateField(trigger: AutoTrigger, dateGateField: string | null): AutoTrigger {
  return withHttp(trigger, (http) => ({ ...http, dateGateField }))
}

export function setIntervalMs(trigger: AutoTrigger, intervalMs: number | undefined): AutoTrigger {
  return withHttp(trigger, (http) => ({ ...http, intervalMs }))
}

export function setLabelField(trigger: AutoTrigger, labelField: string | undefined): AutoTrigger {
  return withHttp(trigger, (http) => ({ ...http, labelField }))
}

export function setSubtitleField(
  trigger: AutoTrigger,
  subtitleField: string | undefined
): AutoTrigger {
  return withHttp(trigger, (http) => ({ ...http, subtitleField }))
}

// --- Capability toggles ----------------------------------------------------

export function setPollingEnabled(trigger: AutoTrigger, value: boolean): AutoTrigger {
  if (!trigger.http) {
    return trigger
  }
  // Why: `enabled` is the engine's master switch — derive it from the two
  // capability toggles so turning both off also disables the trigger.
  return { ...trigger, pollingEnabled: value, enabled: value || (trigger.manualEnabled ?? false) }
}

export function setManualEnabled(trigger: AutoTrigger, value: boolean): AutoTrigger {
  if (!trigger.http) {
    return trigger
  }
  return { ...trigger, manualEnabled: value, enabled: value || (trigger.pollingEnabled ?? false) }
}
