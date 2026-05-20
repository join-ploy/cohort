import { describe, it, expect } from 'vitest'
import { SetupScriptRegistry } from './registry'

describe('SetupScriptRegistry', () => {
  it('returns undefined for unknown worktreeId', () => {
    const r = new SetupScriptRegistry()
    expect(r.get('wt-1')).toBeUndefined()
  })

  it('stores and retrieves the entry by worktreeId', () => {
    const r = new SetupScriptRegistry()
    r.set('wt-1', { state: 'running', exitCode: null, startedAt: 100, finishedAt: null })
    expect(r.get('wt-1')).toEqual({
      state: 'running',
      exitCode: null,
      startedAt: 100,
      finishedAt: null
    })
  })

  it('transitions through the lifecycle (pending → running → exited-success)', () => {
    const r = new SetupScriptRegistry()
    r.set('wt-1', { state: 'pending', exitCode: null, startedAt: null, finishedAt: null })
    r.set('wt-1', { state: 'running', exitCode: null, startedAt: 100, finishedAt: null })
    r.set('wt-1', { state: 'exited-success', exitCode: 0, startedAt: 100, finishedAt: 300 })
    expect(r.get('wt-1')).toMatchObject({ state: 'exited-success', exitCode: 0 })
  })

  it('handles failure transitions (exited-failure with non-zero code)', () => {
    const r = new SetupScriptRegistry()
    r.set('wt-1', { state: 'running', exitCode: null, startedAt: 100, finishedAt: null })
    r.set('wt-1', { state: 'exited-failure', exitCode: 137, startedAt: 100, finishedAt: 300 })
    expect(r.get('wt-1')).toMatchObject({ state: 'exited-failure', exitCode: 137 })
  })

  it('isolates entries per worktreeId', () => {
    const r = new SetupScriptRegistry()
    r.set('wt-1', { state: 'running', exitCode: null, startedAt: 100, finishedAt: null })
    r.set('wt-2', { state: 'exited-success', exitCode: 0, startedAt: 50, finishedAt: 80 })
    expect(r.get('wt-1')?.state).toBe('running')
    expect(r.get('wt-2')?.state).toBe('exited-success')
  })

  it('clear() removes an entry', () => {
    const r = new SetupScriptRegistry()
    r.set('wt-1', { state: 'exited-success', exitCode: 0, startedAt: 100, finishedAt: 200 })
    r.clear('wt-1')
    expect(r.get('wt-1')).toBeUndefined()
  })
})
