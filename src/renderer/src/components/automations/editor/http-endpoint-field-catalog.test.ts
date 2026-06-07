import { describe, it, expect } from 'vitest'
import type { MappedField } from '../../../../../shared/automations-types'
import { httpFieldsToCatalog } from './http-endpoint-field-catalog'

const field = (over: Partial<MappedField>): MappedField => ({
  path: 'id',
  variableName: 'id',
  enabled: true,
  type: 'string',
  sampleValue: '',
  ...over
})

describe('httpFieldsToCatalog', () => {
  it('maps number fields to numeric ops and string fields to equality ops', () => {
    const cat = httpFieldsToCatalog([
      field({ path: 'id', variableName: 'id', type: 'number', sampleValue: 1 }),
      field({ path: 's', variableName: 's', type: 'string', sampleValue: 'x' }),
      field({ path: 'off', variableName: 'off', type: 'string', enabled: false })
    ])
    expect(cat.map((d) => d.field)).toEqual(['id', 's']) // disabled excluded
    expect(cat[0].valueKind).toBe('number')
    expect(cat[0].ops).toEqual(['eq', 'gte', 'lte', 'is-any-of'])
    expect(cat[1].valueKind).toBe('string')
    expect(cat[1].ops).toEqual(['is', 'is-not', 'is-any-of', 'is-none-of'])
    expect(cat.every((d) => d.hasFetchOptions === false)).toBe(true)
  })

  it('uses the dot-path as the descriptor label and the variableName as the field id', () => {
    const [d] = httpFieldsToCatalog([
      field({ path: 'author.name', variableName: 'author_name', type: 'string' })
    ])
    expect(d.field).toBe('author_name')
    expect(d.label).toBe('author.name')
  })

  it('treats non-string/number types (boolean/date/null/unknown) as string equality fields', () => {
    const cat = httpFieldsToCatalog([
      field({ path: 'flag', variableName: 'flag', type: 'boolean', sampleValue: true }),
      field({ path: 'when', variableName: 'when', type: 'date', sampleValue: '2026-01-01' })
    ])
    expect(cat.map((d) => d.valueKind)).toEqual(['string', 'string'])
    expect(cat[0].ops).toEqual(['is', 'is-not', 'is-any-of', 'is-none-of'])
  })

  it('excludes json outputs (whole-item / arrays) — not sensible condition targets', () => {
    const cat = httpFieldsToCatalog([
      field({ path: '', variableName: 'item', type: 'json', sampleValue: {} }),
      field({ path: 'labels', variableName: 'labels', type: 'json', sampleValue: [] }),
      field({ path: 'id', variableName: 'id', type: 'number', sampleValue: 1 })
    ])
    expect(cat.map((d) => d.field)).toEqual(['id'])
  })

  it('returns an empty catalog when no fields are enabled', () => {
    expect(httpFieldsToCatalog([field({ enabled: false })])).toEqual([])
  })
})
