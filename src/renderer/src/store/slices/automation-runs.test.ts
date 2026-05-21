import { create } from 'zustand'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { AutomationRun, AutomationRunStatus } from '../../../../shared/automations-types'
import { createAutomationRunsSlice, isAutomationRunActive } from './automation-runs'

function makeRun(id: string, status: AutomationRunStatus): AutomationRun {
  return {
    id,
    automationId: 'auto-1',
    title: 't',
    scheduledFor: 0,
    status,
    trigger: 'manual',
    workspaceId: null,
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    error: null,
    startedAt: null,
    dispatchedAt: null,
    createdAt: 0
  }
}

function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        ...createAutomationRunsSlice(...a)
      }) as AppState
  )
}

const listRunsMock = vi.fn()

beforeEach(() => {
  listRunsMock.mockReset()
  // Why: only the listRuns surface is consumed by this slice; the rest of
  // window.api is irrelevant here. Cast through `unknown` to avoid pulling in
  // the full Api type just to satisfy a one-call mock.
  ;(globalThis as unknown as { window: { api: unknown } }).window = {
    api: { automations: { listRuns: listRunsMock } }
  }
})

describe('isAutomationRunActive', () => {
  it.each<[AutomationRunStatus, boolean]>([
    ['pending', true],
    ['dispatching', true],
    ['dispatched', true],
    ['running', true],
    ['completed', false],
    ['failed', false],
    ['cancelled', false],
    ['skipped_missed', false],
    ['skipped_unavailable', false],
    ['skipped_needs_interactive_auth', false],
    ['dispatch_failed', false]
  ])('classifies %s as active=%s', (status, active) => {
    expect(isAutomationRunActive(status)).toBe(active)
  })
})

describe('automation-runs slice', () => {
  it('starts un-hydrated with an empty cache', () => {
    const store = createTestStore()
    expect(store.getState().automationRunsHydrated).toBe(false)
    expect(store.getState().automationRunsById).toEqual({})
  })

  it('hydrates runs by id on fetch', async () => {
    listRunsMock.mockResolvedValue([makeRun('r1', 'running'), makeRun('r2', 'completed')])
    const store = createTestStore()
    await store.getState().fetchAutomationRuns()
    const s = store.getState()
    expect(s.automationRunsHydrated).toBe(true)
    expect(s.automationRunsById['r1']?.status).toBe('running')
    expect(s.automationRunsById['r2']?.status).toBe('completed')
  })

  it('marks hydrated even when listRuns rejects', async () => {
    listRunsMock.mockRejectedValue(new Error('ipc unavailable'))
    const store = createTestStore()
    await store.getState().fetchAutomationRuns()
    expect(store.getState().automationRunsHydrated).toBe(true)
    expect(store.getState().automationRunsById).toEqual({})
  })

  it('replaces the cache (does not merge) on each fetch', async () => {
    listRunsMock.mockResolvedValueOnce([makeRun('r1', 'running')])
    const store = createTestStore()
    await store.getState().fetchAutomationRuns()
    expect(Object.keys(store.getState().automationRunsById)).toEqual(['r1'])

    listRunsMock.mockResolvedValueOnce([makeRun('r2', 'completed')])
    await store.getState().fetchAutomationRuns()
    // Why: stale runs (pruned server-side) should not linger in the cache,
    // otherwise the sidebar could keep showing an active badge for a run the
    // backend no longer tracks.
    expect(Object.keys(store.getState().automationRunsById)).toEqual(['r2'])
  })
})
