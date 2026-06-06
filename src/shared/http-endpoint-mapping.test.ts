// src/shared/http-endpoint-mapping.test.ts
import { describe, it, expect } from 'vitest'
import { detectArrayPaths, resolveItems } from './http-endpoint-mapping'

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
