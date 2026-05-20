import { describe, it, expect } from 'vitest'
import { AgentStatusRegistry } from './registry'

describe('AgentStatusRegistry', () => {
  it('returns undefined for unknown paneKey', () => {
    const r = new AgentStatusRegistry()
    expect(r.get('p1')).toBeUndefined()
  })

  it('stores the most recent state by paneKey', () => {
    const r = new AgentStatusRegistry()
    r.set('p1', { state: 'working', updatedAt: 1 })
    r.set('p1', { state: 'done', updatedAt: 2 })
    expect(r.get('p1')).toEqual({ state: 'done', updatedAt: 2 })
  })

  it('does not overwrite a newer entry with an older one', () => {
    const r = new AgentStatusRegistry()
    r.set('p1', { state: 'working', updatedAt: 5 })
    r.set('p1', { state: 'done', updatedAt: 3 }) // older
    expect(r.get('p1')).toEqual({ state: 'working', updatedAt: 5 })
  })

  it('treats entries older than staleAfterMs as stale via isFresh()', () => {
    const r = new AgentStatusRegistry({ staleAfterMs: 100 })
    r.set('p1', { state: 'working', updatedAt: 0 })
    expect(r.isFresh('p1', 50)).toBe(true)
    expect(r.isFresh('p1', 150)).toBe(false)
  })

  it('isFresh returns false for unknown paneKey', () => {
    const r = new AgentStatusRegistry()
    expect(r.isFresh('p1', 0)).toBe(false)
  })

  it('isolates entries by paneKey', () => {
    const r = new AgentStatusRegistry()
    r.set('p1', { state: 'working', updatedAt: 1 })
    r.set('p2', { state: 'done', updatedAt: 2 })
    expect(r.get('p1')).toEqual({ state: 'working', updatedAt: 1 })
    expect(r.get('p2')).toEqual({ state: 'done', updatedAt: 2 })
  })
})
