import { describe, it, expect } from 'vitest'
import {
  HTTP_SECRET_MASK,
  type HttpRequestConfig,
  type MappedField
} from '../../../../../shared/automations-types'
import {
  addHeader,
  applyTestMapping,
  mergeDiscoveredFields,
  removeHeader,
  setConnectionId,
  setRequestField,
  toggleBodySecret,
  toggleHeaderSecret,
  updateHeader,
  type HttpRequestEditorValue
} from './http-request-editor-state'

const req = (over: Partial<HttpRequestConfig> = {}): HttpRequestConfig => ({
  method: 'GET',
  url: 'https://api.test/items',
  headers: [],
  query: [],
  ...over
})

const value = (over: Partial<HttpRequestEditorValue> = {}): HttpRequestEditorValue => ({
  request: req(),
  itemsPath: null,
  fields: [],
  ...over
})

describe('addHeader', () => {
  it('appends a blank row with a stable id, without mutating the original', () => {
    const v = value({ request: req({ headers: [] }) })
    const next = addHeader(v)
    expect(next.request.headers).toHaveLength(1)
    expect(next.request.headers[0].key).toBe('')
    expect(next.request.headers[0].value).toBe('')
    // Why: the id correlates secret mask-reuse across delete/reorder (FIX I1).
    expect(typeof next.request.headers[0].id).toBe('string')
    expect(v.request.headers).toEqual([])
  })
})

describe('toggleHeaderSecret', () => {
  it('flips the secret flag on the row', () => {
    const v = value({ request: req({ headers: [{ key: 'Authorization', value: 'x' }] }) })
    const on = toggleHeaderSecret(v, 0)
    expect(on.request.headers[0].secret).toBe(true)
    expect(toggleHeaderSecret(on, 0).request.headers[0].secret).toBe(false)
  })

  it('OFF on a masked value clears it so the sentinel never persists', () => {
    const v = value({
      request: req({ headers: [{ key: 'Authorization', value: HTTP_SECRET_MASK, secret: true }] })
    })
    const off = toggleHeaderSecret(v, 0)
    expect(off.request.headers[0].secret).toBe(false)
    expect(off.request.headers[0].value).toBe('')
  })

  it('OFF on a freshly typed value leaves it intact', () => {
    const v = value({
      request: req({ headers: [{ key: 'Authorization', value: 'plain-token', secret: true }] })
    })
    const off = toggleHeaderSecret(v, 0)
    expect(off.request.headers[0].secret).toBe(false)
    expect(off.request.headers[0].value).toBe('plain-token')
  })
})

describe('updateHeader', () => {
  it('patches key/value while preserving the row id (secret mask-reuse correlation)', () => {
    const v = value({
      request: req({ headers: [{ id: 'h1', key: 'Authorization', value: 'x', secret: true }] })
    })
    const next = updateHeader(v, 0, { value: 'y' })
    expect(next.request.headers[0]).toEqual({
      id: 'h1',
      key: 'Authorization',
      value: 'y',
      secret: true
    })
    expect(v.request.headers[0].value).toBe('x') // original untouched
  })
})

describe('removeHeader', () => {
  it('drops the row at the index without touching the others', () => {
    const v = value({
      request: req({
        headers: [
          { key: 'A', value: '1' },
          { key: 'B', value: '2' }
        ]
      })
    })
    expect(removeHeader(v, 0).request.headers).toEqual([{ key: 'B', value: '2' }])
  })
})

describe('setRequestField', () => {
  it('patches a request field without dropping the others', () => {
    const v = value({ request: req({ method: 'GET', url: 'https://a' }) })
    const next = setRequestField(v, { method: 'POST' })
    expect(next.request.method).toBe('POST')
    expect(next.request.url).toBe('https://a')
    expect(v.request.method).toBe('GET') // original untouched
  })
})

describe('toggleBodySecret', () => {
  it('flips bodySecret and leaves a freshly typed body intact', () => {
    const v = value({ request: req({ body: '{"k":1}', bodySecret: false }) })
    const on = toggleBodySecret(v)
    expect(on.request.bodySecret).toBe(true)
    expect(on.request.body).toBe('{"k":1}')
  })

  it('OFF on a masked body clears the sentinel so it never persists as a literal', () => {
    const v = value({ request: req({ body: HTTP_SECRET_MASK, bodySecret: true }) })
    const off = toggleBodySecret(v)
    expect(off.request.bodySecret).toBe(false)
    expect(off.request.body).toBe('')
  })
})

describe('setConnectionId', () => {
  it('sets and clears the connection pointer', () => {
    const v = value()
    expect(setConnectionId(v, 'c1').connectionId).toBe('c1')
    expect(setConnectionId(setConnectionId(v, 'c1'), undefined).connectionId).toBeUndefined()
    expect(v.connectionId).toBeUndefined() // original untouched
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
})

describe('applyTestMapping', () => {
  it('sets itemsPath + sampleResponse and merges fields, preserving user choices', () => {
    const v = value({
      fields: [
        { path: 'id', variableName: 'ticket_id', enabled: false, type: 'number', sampleValue: 1 }
      ]
    })
    const next = applyTestMapping(v, {
      itemsPath: 'data',
      fields: [
        { path: 'id', variableName: 'id', enabled: true, type: 'number', sampleValue: 9 },
        { path: 'name', variableName: 'name', enabled: true, type: 'string', sampleValue: 'x' }
      ],
      sampleResponse: { data: [{ id: 9, name: 'x' }] }
    })
    expect(next.itemsPath).toBe('data')
    expect(next.sampleResponse).toEqual({ data: [{ id: 9, name: 'x' }] })
    expect(next.fields.map((f) => f.path)).toEqual(['id', 'name'])
    expect(next.fields[0].variableName).toBe('ticket_id') // re-Test keeps rename
    expect(next.fields[0].enabled).toBe(false) // re-Test keeps disable
    expect(next.fields[0].sampleValue).toBe(9) // fresh sample
    expect(v.fields[0].variableName).toBe('ticket_id') // original untouched
  })
})
