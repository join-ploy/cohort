import { create } from 'zustand'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { Automation, AutomationCreateInput } from '../../../../shared/automations-types'
import { buildDuplicateAutomationInput, createAutomationsSlice } from './automations'

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-source',
    name: 'My Automation',
    prompt: 'do the thing',
    agentId: 'claude',
    projectId: 'proj-1',
    executionTargetType: 'local',
    executionTargetId: '',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: 'main',
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 1000,
    enabled: true,
    nextRunAt: 5000,
    lastRunAt: 4000,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 30,
    createdAt: 100,
    updatedAt: 200,
    trigger: { kind: 'manual', acceptsLinearTicket: true },
    steps: [
      {
        id: 'cw-1',
        kind: 'create-worktree',
        config: {
          baseBranch: 'main',
          branchName: 'feat/x',
          displayName: 'X',
          linkLinearIssue: false
        },
        onFailure: 'halt',
        timeoutSeconds: null
      }
    ],
    autoTriggers: [],
    target: { kind: 'single', projectId: 'proj-1' },
    ...overrides
  }
}

function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        ...createAutomationsSlice(...a)
      }) as AppState
  )
}

const listMock = vi.fn()
const createMock = vi.fn()

beforeEach(() => {
  listMock.mockReset()
  createMock.mockReset()
  ;(globalThis as unknown as { window: { api: unknown } }).window = {
    api: { automations: { list: listMock, create: createMock } }
  }
})

describe('buildDuplicateAutomationInput', () => {
  it('appends " (copy)" to the source name', () => {
    const out = buildDuplicateAutomationInput(makeAutomation())
    expect(out.name).toBe('My Automation (copy)')
  })

  it('forces enabled=false so the clone does not race the original', () => {
    const out = buildDuplicateAutomationInput(makeAutomation({ enabled: true }))
    expect(out.enabled).toBe(false)
  })

  it('does not carry id / createdAt / updatedAt / nextRunAt / lastRunAt', () => {
    const out = buildDuplicateAutomationInput(makeAutomation()) as Record<string, unknown>
    expect(out.id).toBeUndefined()
    expect(out.createdAt).toBeUndefined()
    expect(out.updatedAt).toBeUndefined()
    expect(out.nextRunAt).toBeUndefined()
    expect(out.lastRunAt).toBeUndefined()
  })

  it('preserves trigger, steps, autoTriggers, prompt, agentId, projectId, target, baseBranch, schedule fields', () => {
    const source = makeAutomation()
    const out = buildDuplicateAutomationInput(source)
    expect(out.prompt).toBe(source.prompt)
    expect(out.agentId).toBe(source.agentId)
    expect(out.projectId).toBe(source.projectId)
    expect(out.target).toEqual(source.target)
    expect(out.workspaceMode).toBe(source.workspaceMode)
    expect(out.baseBranch).toBe(source.baseBranch)
    expect(out.timezone).toBe(source.timezone)
    expect(out.rrule).toBe(source.rrule)
    expect(out.dtstart).toBe(source.dtstart)
    expect(out.missedRunGraceMinutes).toBe(source.missedRunGraceMinutes)
    expect(out.trigger).toEqual(source.trigger)
    expect(out.steps).toEqual(source.steps)
    expect(out.autoTriggers).toEqual(source.autoTriggers)
  })

  it('omits target / trigger / steps / autoTriggers when source has none (legacy row)', () => {
    const legacy = makeAutomation()
    delete (legacy as Partial<Automation>).target
    delete (legacy as Partial<Automation>).trigger
    delete (legacy as Partial<Automation>).steps
    delete (legacy as Partial<Automation>).autoTriggers
    const out = buildDuplicateAutomationInput(legacy) as Record<string, unknown>
    expect(out.target).toBeUndefined()
    expect(out.trigger).toBeUndefined()
    expect(out.steps).toBeUndefined()
    expect(out.autoTriggers).toBeUndefined()
  })
})

describe('duplicateAutomation slice action', () => {
  it('looks up the source by id and calls automations.create with the clone input', async () => {
    const source = makeAutomation()
    listMock.mockResolvedValue([source])
    createMock.mockImplementation(async (input: AutomationCreateInput) => ({
      ...source,
      id: 'auto-new',
      name: input.name,
      enabled: input.enabled ?? true
    }))

    const store = createTestStore()
    const created = await store.getState().duplicateAutomation('auto-source')

    expect(listMock).toHaveBeenCalledOnce()
    expect(createMock).toHaveBeenCalledOnce()
    const passed = createMock.mock.calls[0][0] as AutomationCreateInput
    expect(passed.name).toBe('My Automation (copy)')
    expect(passed.enabled).toBe(false)
    expect(passed.steps).toEqual(source.steps)
    expect(created.id).toBe('auto-new')
  })

  it('throws when the source id is not found', async () => {
    listMock.mockResolvedValue([])
    const store = createTestStore()
    await expect(store.getState().duplicateAutomation('missing')).rejects.toThrow(/not found/i)
    expect(createMock).not.toHaveBeenCalled()
  })
})
