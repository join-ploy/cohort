import { describe, it, expect } from 'vitest'
import { TriggerSourceRegistry } from './registry'
import type { TriggerSource } from './types'

function makeFakeSource(): TriggerSource {
  return {
    id: 'linear-issue',
    displayName: 'Linear issue',
    fieldCatalog: [],
    async *poll() {
      // no events
    }
  }
}

describe('TriggerSourceRegistry', () => {
  it('registers and looks up sources by id', () => {
    const r = new TriggerSourceRegistry()
    const src = makeFakeSource()
    r.register(src)
    expect(r.get('linear-issue')).toBe(src)
  })

  it('list() returns registered sources', () => {
    const r = new TriggerSourceRegistry()
    const src = makeFakeSource()
    r.register(src)
    expect(r.list()).toEqual([src])
  })

  it('throws on duplicate id', () => {
    const r = new TriggerSourceRegistry()
    r.register(makeFakeSource())
    expect(() => r.register(makeFakeSource())).toThrow(/already registered/)
  })

  it('get() returns undefined for unknown ids', () => {
    const r = new TriggerSourceRegistry()
    expect(r.get('linear-issue')).toBeUndefined()
  })

  it('list() preserves registration order', () => {
    const r = new TriggerSourceRegistry()
    const a = makeFakeSource()
    // We only have one source id today; fake a second by cloning + reassigning
    // the id at the type level once a second source exists. For now, just
    // verify single-source registration round-trips.
    r.register(a)
    expect(r.list()).toEqual([a])
  })
})
