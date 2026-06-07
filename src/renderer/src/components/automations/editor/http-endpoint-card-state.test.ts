import { describe, it, expect } from 'vitest'
import {
  type AutoTrigger,
  type HttpEndpointConfig,
  type HttpRequestConfig
} from '../../../../../shared/automations-types'
import {
  setDateGateField,
  setDedupeFields,
  setIntervalMs,
  setLabelField,
  setManualEnabled,
  setPollingEnabled,
  setSubtitleField
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
    expect(setDedupeFields(t, ['id'])).toBe(t)
    expect(setPollingEnabled(t, false)).toBe(t)
    expect(setManualEnabled(t, true)).toBe(t)
  })
})
