// src/shared/http-endpoint-mapping.test.ts
import { describe, it, expect } from 'vitest'
import {
  detectArrayPaths,
  resolveItems,
  parseDateValue,
  inferFieldType,
  flattenItem,
  defaultVariableName,
  buildDedupKey,
  mapItemToVariables,
  evaluateDateGate
} from './http-endpoint-mapping'

describe('detectArrayPaths', () => {
  it('finds a top-level array', () => {
    expect(detectArrayPaths([1, 2, 3])).toEqual([{ path: '', length: 3 }])
  })
  it('finds nested arrays by dot-path, largest first', () => {
    const body = { meta: { ids: [1] }, data: { results: [1, 2, 3] } }
    expect(detectArrayPaths(body)).toEqual([
      { path: 'data.results', length: 3 },
      { path: 'meta.ids', length: 1 }
    ])
  })
  it('returns [] when there is no array', () => {
    expect(detectArrayPaths({ a: 1 })).toEqual([])
  })
})

describe('resolveItems', () => {
  it('returns the array at the path', () => {
    expect(resolveItems({ data: [{ id: 1 }] }, 'data')).toEqual([{ id: 1 }])
  })
  it('treats a null itemsPath as a single whole-body item', () => {
    expect(resolveItems({ id: 1 }, null)).toEqual([{ id: 1 }])
  })
  it('returns [] when the path is missing or not an array', () => {
    expect(resolveItems({ data: 5 }, 'data')).toEqual([])
    expect(resolveItems({}, 'nope')).toEqual([])
  })
})

describe('parseDateValue', () => {
  it('parses ISO 8601', () => {
    expect(parseDateValue('2026-06-06T10:00:00Z')).toBe(Date.parse('2026-06-06T10:00:00Z'))
  })
  it('parses epoch seconds and milliseconds', () => {
    expect(parseDateValue(1_700_000_000)).toBe(1_700_000_000_000)
    expect(parseDateValue(1_700_000_000_000)).toBe(1_700_000_000_000)
  })
  it('parses ISO date-only strings', () => {
    expect(parseDateValue('2026-06-06')).toBe(Date.parse('2026-06-06'))
  })
  it('returns null for unparseable values', () => {
    expect(parseDateValue('not a date')).toBeNull()
    expect(parseDateValue(null)).toBeNull()
    expect(parseDateValue({})).toBeNull()
  })
  it('rejects non-ISO numeric-ish strings Date.parse would otherwise accept', () => {
    // Version strings, bare years, and short ids must not be read as dates.
    expect(parseDateValue('5')).toBeNull()
    expect(parseDateValue('2026')).toBeNull()
    expect(parseDateValue('1.2.3')).toBeNull()
  })
})

describe('inferFieldType', () => {
  it('classifies primitives and dates', () => {
    expect(inferFieldType('2026-06-06T10:00:00Z')).toBe('date')
    expect(inferFieldType('hello')).toBe('string')
    expect(inferFieldType(42)).toBe('number')
    expect(inferFieldType(true)).toBe('boolean')
    expect(inferFieldType(null)).toBe('null')
  })
  it('does not mislabel version/id/year strings as dates', () => {
    expect(inferFieldType('1.2.3')).toBe('string')
    expect(inferFieldType('2026')).toBe('string')
    expect(inferFieldType('5')).toBe('string')
  })
})

describe('flattenItem', () => {
  it('flattens nested objects and arrays into dot/bracket paths', () => {
    const item = { id: 7, author: { name: 'Ada' }, labels: [{ name: 'bug' }] }
    const fields = flattenItem(item)
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f]))
    expect(byPath['id'].type).toBe('number')
    expect(byPath['author.name'].sampleValue).toBe('Ada')
    expect(byPath['labels[0].name'].type).toBe('string')
  })
  it('defaults every field enabled with a sanitized variable name', () => {
    const [f] = flattenItem({ 'author.name': 'x' })
    expect(f.enabled).toBe(true)
    expect(f.variableName).toBe(defaultVariableName('author.name'))
  })
})

describe('defaultVariableName', () => {
  it('sanitizes dots and brackets to underscores', () => {
    expect(defaultVariableName('labels[0].name')).toBe('labels_0_name')
  })
})

describe('buildDedupKey', () => {
  it('encodes the chosen field values positionally and deterministically', () => {
    expect(buildDedupKey({ id: 7, k: 'a' }, ['id', 'k'])).toBe(JSON.stringify([7, 'a']))
    expect(buildDedupKey({ id: 7, k: 'a' }, ['id', 'k'])).toBe(
      buildDedupKey({ id: 7, k: 'a' }, ['id', 'k'])
    )
  })
  it('does not alias distinct items whose values contain the separator', () => {
    // Pre-fix these both joined to '1 2 3'; positional JSON keeps them distinct.
    const a = buildDedupKey({ a: '1 2', b: '3' }, ['a', 'b'])
    const b = buildDedupKey({ a: '1', b: '2 3' }, ['a', 'b'])
    expect(a).not.toBe(b)
  })
  it('falls back to a stable hash of the whole item when no fields resolve', () => {
    const a = buildDedupKey({ x: 1 }, [])
    const b = buildDedupKey({ x: 1 }, [])
    expect(a).toBe(b)
    expect(a).not.toBe(buildDedupKey({ x: 2 }, []))
  })
})

describe('mapItemToVariables', () => {
  it('emits only enabled fields keyed by variableName', () => {
    const fields = [
      { path: 'id', variableName: 'id', enabled: true, type: 'number' as const, sampleValue: 1 },
      { path: 'x', variableName: 'x', enabled: false, type: 'string' as const, sampleValue: '' }
    ]
    expect(mapItemToVariables({ id: 9, x: 'no' }, fields)).toEqual({ id: 9 })
  })
})

describe('evaluateDateGate', () => {
  const enabledAt = Date.parse('2026-06-01T00:00:00Z')
  it('passes when the gate field is later than enabledAt', () => {
    expect(evaluateDateGate({ at: '2026-06-02T00:00:00Z' }, 'at', enabledAt)).toBe(true)
  })
  it('fails closed when later-or-equal is not met', () => {
    expect(evaluateDateGate({ at: '2026-05-30T00:00:00Z' }, 'at', enabledAt)).toBe(false)
  })
  it('fails closed when the field is missing/unparseable', () => {
    expect(evaluateDateGate({}, 'at', enabledAt)).toBe(false)
    expect(evaluateDateGate({ at: 'nope' }, 'at', enabledAt)).toBe(false)
  })
  it('passes everything when no gate field is configured', () => {
    expect(evaluateDateGate({}, null, enabledAt)).toBe(true)
  })
})
