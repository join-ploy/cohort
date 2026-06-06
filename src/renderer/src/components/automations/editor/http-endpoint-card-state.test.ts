import { describe, it, expect } from 'vitest'
import type {
  AutoTrigger,
  HttpEndpointConfig,
  HttpRequestConfig,
  MappedField
} from '../../../../../shared/automations-types'
import {
  addHeader,
  addQuery,
  applyTestMapping,
  mergeDiscoveredFields,
  removeHeader,
  removeQuery,
  renameField,
  setDateGateField,
  setDedupeFields,
  setIntervalMs,
  setLabelField,
  setManualEnabled,
  setPollingEnabled,
  setRequestField,
  setSubtitleField,
  toggleFieldEnabled,
  toggleHeaderSecret,
  updateHeader,
  updateQuery
} from './http-endpoint-card-state'

const req = (over: Partial<HttpRequestConfig> = {}): HttpRequestConfig => ({
  method: 'GET',
  url: 'https://api.test/items',
  headers: [],
  query: [],
  ...over
})

const httpConfig = (over: Partial<HttpEndpointConfig> = {}): HttpEndpointConfig => ({
  request: req(),
  itemsPath: null,
  fields: [],
  dedupeFields: [],
  dateGateField: null,
  ...over
})

const httpTrigger = (
  http: Partial<HttpEndpointConfig> = {},
  top: Partial<AutoTrigger> = {}
): AutoTrigger => ({
  id: 't1',
  source: 'http-endpoint',
  enabled: true,
  enabledAt: 0,
  rules: [],
  pollingEnabled: true,
  manualEnabled: false,
  http: httpConfig(http),
  ...top
})

const nonHttpTrigger = (): AutoTrigger => ({
  id: 'lin',
  source: 'linear-issue',
  enabled: true,
  enabledAt: 0,
  rules: []
})

describe('request reducers', () => {
  it('setRequestField merges a partial request patch immutably', () => {
    const t = httpTrigger({ request: req({ method: 'GET', url: '' }) })
    const next = setRequestField(t, { method: 'POST', url: 'https://x' })
    expect(next.http?.request.method).toBe('POST')
    expect(next.http?.request.url).toBe('https://x')
    expect(next.http?.request.headers).toEqual([])
    expect(t.http?.request.method).toBe('GET') // original untouched
  })

  it('addHeader appends a blank row without mutating the original', () => {
    const t = httpTrigger({ request: req({ headers: [] }) })
    const next = addHeader(t)
    expect(next.http?.request.headers).toEqual([{ key: '', value: '' }])
    expect(t.http?.request.headers).toEqual([])
  })

  it('updateHeader patches a single row by index', () => {
    const t = httpTrigger({
      request: req({
        headers: [
          { key: 'A', value: '1' },
          { key: 'B', value: '2' }
        ]
      })
    })
    const next = updateHeader(t, 1, { value: '99' })
    expect(next.http?.request.headers[1]).toEqual({ key: 'B', value: '99' })
    expect(next.http?.request.headers[0]).toEqual({ key: 'A', value: '1' })
  })

  it('removeHeader drops the row at the index', () => {
    const t = httpTrigger({
      request: req({
        headers: [
          { key: 'A', value: '1' },
          { key: 'B', value: '2' }
        ]
      })
    })
    expect(removeHeader(t, 0).http?.request.headers).toEqual([{ key: 'B', value: '2' }])
  })

  it('toggleHeaderSecret flips the secret flag on the row', () => {
    const t = httpTrigger({ request: req({ headers: [{ key: 'Authorization', value: 'x' }] }) })
    const on = toggleHeaderSecret(t, 0)
    expect(on.http?.request.headers[0].secret).toBe(true)
    expect(toggleHeaderSecret(on, 0).http?.request.headers[0].secret).toBe(false)
  })

  it('query reducers mirror header reducers', () => {
    const t = httpTrigger({ request: req({ query: [] }) })
    const added = addQuery(t)
    expect(added.http?.request.query).toEqual([{ key: '', value: '' }])
    const patched = updateQuery(added, 0, { key: 'page', value: '1' })
    expect(patched.http?.request.query[0]).toEqual({ key: 'page', value: '1' })
    expect(removeQuery(patched, 0).http?.request.query).toEqual([])
  })
})

describe('mergeDiscoveredFields (drift)', () => {
  it('preserves prior enabled + variableName for surviving paths and drops vanished ones', () => {
    const prior: MappedField[] = [
      { path: 'id', variableName: 'ticket_id', enabled: true, type: 'number', sampleValue: 1 },
      { path: 'title', variableName: 'title', enabled: false, type: 'string', sampleValue: 'a' },
      { path: 'gone', variableName: 'gone', enabled: true, type: 'string', sampleValue: 'x' }
    ]
    const discovered: MappedField[] = [
      { path: 'id', variableName: 'id', enabled: true, type: 'number', sampleValue: 42 },
      { path: 'title', variableName: 'title', enabled: true, type: 'string', sampleValue: 'b' },
      { path: 'fresh', variableName: 'fresh', enabled: true, type: 'string', sampleValue: 'n' }
    ]
    const merged = mergeDiscoveredFields(prior, discovered)
    expect(merged.map((f) => f.path)).toEqual(['id', 'title', 'fresh']) // 'gone' dropped
    expect(merged[0].variableName).toBe('ticket_id') // prior rename kept
    expect(merged[0].sampleValue).toBe(42) // fresh sample taken
    expect(merged[1].enabled).toBe(false) // prior disable kept
    expect(merged[2].variableName).toBe('fresh') // new field uses discovered default
    expect(merged[2].enabled).toBe(true)
  })

  it('is idempotent when fed an already-merged result', () => {
    const prior: MappedField[] = [
      { path: 'id', variableName: 'ticket_id', enabled: false, type: 'number', sampleValue: 1 }
    ]
    const discovered: MappedField[] = [
      { path: 'id', variableName: 'id', enabled: true, type: 'number', sampleValue: 9 }
    ]
    const once = mergeDiscoveredFields(prior, discovered)
    expect(mergeDiscoveredFields(prior, once)).toEqual(once)
  })
})

describe('applyTestMapping', () => {
  it('sets itemsPath + sampleResponse and merges fields, preserving user choices', () => {
    const t = httpTrigger({
      fields: [
        { path: 'id', variableName: 'ticket_id', enabled: false, type: 'number', sampleValue: 1 }
      ]
    })
    const next = applyTestMapping(t, {
      itemsPath: 'data',
      fields: [
        { path: 'id', variableName: 'id', enabled: true, type: 'number', sampleValue: 9 },
        { path: 'name', variableName: 'name', enabled: true, type: 'string', sampleValue: 'x' }
      ],
      sampleResponse: { data: [{ id: 9, name: 'x' }] }
    })
    expect(next.http?.itemsPath).toBe('data')
    expect(next.http?.sampleResponse).toEqual({ data: [{ id: 9, name: 'x' }] })
    expect(next.http?.fields.map((f) => f.path)).toEqual(['id', 'name'])
    expect(next.http?.fields[0].variableName).toBe('ticket_id') // re-Test keeps rename
    expect(next.http?.fields[0].enabled).toBe(false) // re-Test keeps disable
    expect(next.http?.fields[0].sampleValue).toBe(9) // fresh sample
    expect(t.http?.fields[0].variableName).toBe('ticket_id') // original untouched
  })
})

describe('field mapping reducers', () => {
  it('toggleFieldEnabled flips only the matching path', () => {
    const t = httpTrigger({
      fields: [
        { path: 'id', variableName: 'id', enabled: true, type: 'number', sampleValue: 1 },
        { path: 'name', variableName: 'name', enabled: true, type: 'string', sampleValue: 'x' }
      ]
    })
    const next = toggleFieldEnabled(t, 'name')
    expect(next.http?.fields[0].enabled).toBe(true)
    expect(next.http?.fields[1].enabled).toBe(false)
  })

  it('renameField sets the variableName of the matching path', () => {
    const t = httpTrigger({
      fields: [{ path: 'id', variableName: 'id', enabled: true, type: 'number', sampleValue: 1 }]
    })
    expect(renameField(t, 'id', 'ticket').http?.fields[0].variableName).toBe('ticket')
  })
})

describe('poll + manual setters', () => {
  it('updates dedupe / date-gate / interval / label / subtitle', () => {
    const t = httpTrigger()
    expect(setDedupeFields(t, ['id', 'k']).http?.dedupeFields).toEqual(['id', 'k'])
    expect(setDateGateField(t, 'updated').http?.dateGateField).toBe('updated')
    expect(setDateGateField(t, null).http?.dateGateField).toBeNull()
    expect(setIntervalMs(t, 60_000).http?.intervalMs).toBe(60_000)
    expect(setLabelField(t, 'title').http?.labelField).toBe('title')
    expect(setSubtitleField(t, 'sub').http?.subtitleField).toBe('sub')
  })
})

describe('capability toggles derive enabled', () => {
  it('setPollingEnabled(false) keeps enabled true while manual is on', () => {
    const t = httpTrigger({}, { pollingEnabled: true, manualEnabled: true, enabled: true })
    const next = setPollingEnabled(t, false)
    expect(next.pollingEnabled).toBe(false)
    expect(next.manualEnabled).toBe(true)
    expect(next.enabled).toBe(true) // derived from manualEnabled
  })

  it('setPollingEnabled(false) derives enabled false when manual is off', () => {
    const t = httpTrigger({}, { pollingEnabled: true, manualEnabled: false, enabled: true })
    expect(setPollingEnabled(t, false).enabled).toBe(false)
  })

  it('setManualEnabled(true) derives enabled true even with polling off', () => {
    const t = httpTrigger({}, { pollingEnabled: false, manualEnabled: false, enabled: false })
    const next = setManualEnabled(t, true)
    expect(next.manualEnabled).toBe(true)
    expect(next.enabled).toBe(true)
  })
})

describe('reducer edge cases', () => {
  it('updateHeader/removeHeader/updateQuery no-op on an out-of-range index', () => {
    const t = httpTrigger({ request: req({ headers: [{ key: 'A', value: '1' }] }) })
    expect(updateHeader(t, 9, { value: 'x' }).http?.request.headers).toEqual([
      { key: 'A', value: '1' }
    ])
    expect(removeHeader(t, 9).http?.request.headers).toEqual([{ key: 'A', value: '1' }])
    expect(updateQuery(t, 9, { value: 'x' }).http?.request.query).toEqual([])
  })

  it('clears optional fields when set to undefined', () => {
    const t = httpTrigger({ intervalMs: 5000, labelField: 'name', subtitleField: 'at' })
    expect(setIntervalMs(t, undefined).http?.intervalMs).toBeUndefined()
    expect(setLabelField(t, undefined).http?.labelField).toBeUndefined()
    expect(setSubtitleField(t, undefined).http?.subtitleField).toBeUndefined()
  })

  it('setManualEnabled(false) with polling off also clears the master enabled', () => {
    const t = httpTrigger({}, { pollingEnabled: false, manualEnabled: true, enabled: true })
    const next = setManualEnabled(t, false)
    expect(next.manualEnabled).toBe(false)
    expect(next.enabled).toBe(false)
  })

  it('setManualEnabled(true) with polling on keeps enabled true', () => {
    const t = httpTrigger({}, { pollingEnabled: true, manualEnabled: false, enabled: true })
    expect(setManualEnabled(t, true).enabled).toBe(true)
  })
})

describe('non-http triggers are left untouched', () => {
  it('returns the same reference for triggers without an http config', () => {
    const t = nonHttpTrigger()
    expect(setRequestField(t, { url: 'https://x' })).toBe(t)
    expect(addHeader(t)).toBe(t)
    expect(setPollingEnabled(t, false)).toBe(t)
    expect(applyTestMapping(t, { itemsPath: null, fields: [], sampleResponse: {} })).toBe(t)
  })
})
