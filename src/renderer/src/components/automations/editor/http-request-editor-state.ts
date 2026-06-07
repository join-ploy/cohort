import {
  HTTP_SECRET_MASK,
  type HttpKeyValue,
  type HttpRequestConfig,
  type MappedField
} from '../../../../../shared/automations-types'

// The minimal slice the shared HTTP request editor mutates: the connection
// pointer, the request, and the Test-derived items path + field mapping. The
// trigger card and the http-request step each embed this inside their own
// persisted config and write the slice back, preserving their extra fields.
export type HttpRequestEditorValue = {
  connectionId?: string
  request: HttpRequestConfig
  itemsPath: string | null
  fields: MappedField[]
  sampleResponse?: unknown
}

export type TestMapping = {
  itemsPath: string | null
  fields: MappedField[]
  sampleResponse: unknown
}

function withRequest(
  value: HttpRequestEditorValue,
  update: (request: HttpRequestConfig) => HttpRequestConfig
): HttpRequestEditorValue {
  return { ...value, request: update(value.request) }
}

// --- Request ---------------------------------------------------------------

export function setRequestField(
  value: HttpRequestEditorValue,
  patch: Partial<HttpRequestConfig>
): HttpRequestEditorValue {
  return withRequest(value, (request) => ({ ...request, ...patch }))
}

// Select/clear the reusable connection this request points at. Clearing returns
// the editor to fully-inline mode (URL is an absolute URL again).
export function setConnectionId(
  value: HttpRequestEditorValue,
  connectionId: string | undefined
): HttpRequestEditorValue {
  return { ...value, connectionId }
}

export function addHeader(value: HttpRequestEditorValue): HttpRequestEditorValue {
  return withRequest(value, (request) => ({
    ...request,
    // Why: mint a stable id so secret mask-reuse survives later delete/reorder.
    headers: [...request.headers, { key: '', value: '', id: crypto.randomUUID() }]
  }))
}

export function removeHeader(value: HttpRequestEditorValue, index: number): HttpRequestEditorValue {
  return withRequest(value, (request) => ({
    ...request,
    headers: request.headers.filter((_, i) => i !== index)
  }))
}

export function updateHeader(
  value: HttpRequestEditorValue,
  index: number,
  patch: Partial<HttpKeyValue>
): HttpRequestEditorValue {
  return withRequest(value, (request) => ({
    ...request,
    headers: request.headers.map((h, i) => (i === index ? { ...h, ...patch } : h))
  }))
}

export function toggleHeaderSecret(
  value: HttpRequestEditorValue,
  index: number
): HttpRequestEditorValue {
  return withRequest(value, (request) => ({
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

export function toggleBodySecret(value: HttpRequestEditorValue): HttpRequestEditorValue {
  return withRequest(value, (request) => {
    const bodySecret = !request.bodySecret
    // Why: mirror the header fix — un-secreting a sealed body clears the mask
    // sentinel so it can't seal/send as a literal request body.
    if (!bodySecret && request.body === HTTP_SECRET_MASK) {
      return { ...request, bodySecret, body: '' }
    }
    return { ...request, bodySecret }
  })
}

export function addQuery(value: HttpRequestEditorValue): HttpRequestEditorValue {
  return withRequest(value, (request) => ({
    ...request,
    // Why: mint a stable id so secret mask-reuse survives later delete/reorder.
    query: [...request.query, { key: '', value: '', id: crypto.randomUUID() }]
  }))
}

export function removeQuery(value: HttpRequestEditorValue, index: number): HttpRequestEditorValue {
  return withRequest(value, (request) => ({
    ...request,
    query: request.query.filter((_, i) => i !== index)
  }))
}

export function updateQuery(
  value: HttpRequestEditorValue,
  index: number,
  patch: Partial<HttpKeyValue>
): HttpRequestEditorValue {
  return withRequest(value, (request) => ({
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

export function applyTestMapping(
  value: HttpRequestEditorValue,
  mapping: TestMapping
): HttpRequestEditorValue {
  return {
    ...value,
    itemsPath: mapping.itemsPath,
    sampleResponse: mapping.sampleResponse,
    fields: mergeDiscoveredFields(value.fields, mapping.fields)
  }
}

export function toggleFieldEnabled(
  value: HttpRequestEditorValue,
  path: string
): HttpRequestEditorValue {
  return {
    ...value,
    fields: value.fields.map((f) => (f.path === path ? { ...f, enabled: !f.enabled } : f))
  }
}

export function renameField(
  value: HttpRequestEditorValue,
  path: string,
  variableName: string
): HttpRequestEditorValue {
  return {
    ...value,
    fields: value.fields.map((f) => (f.path === path ? { ...f, variableName } : f))
  }
}
