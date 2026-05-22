import { describe, it, expect } from 'vitest'
import { normalizeAutomationTarget } from './automation-target-migration'
import type { Automation, AutomationTarget } from './automations-types'

// Minimal Automation builder so each spec only has to spell out the fields
// relevant to target normalization.
function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    name: 'x',
    prompt: 'p',
    agentId: 'claude',
    projectId: 'proj-legacy',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: 'main',
    timezone: 'UTC',
    rrule: '',
    dtstart: 0,
    enabled: true,
    nextRunAt: 0,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 5,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

describe('normalizeAutomationTarget', () => {
  it('inflates a legacy automation (no target) into a single-kind target using projectId', () => {
    const a = makeAutomation({ projectId: 'proj-42' })
    const t = normalizeAutomationTarget(a)
    expect(t).toEqual({ kind: 'single', projectId: 'proj-42' })
  })

  it('returns an already-set single target as-is', () => {
    const target: AutomationTarget = { kind: 'single', projectId: 'proj-explicit' }
    const a = makeAutomation({ projectId: 'proj-legacy', target })
    const t = normalizeAutomationTarget(a)
    expect(t).toBe(target)
  })

  it('returns an already-set group target as-is, preserving projectIds and groupBranchName', () => {
    const target: AutomationTarget = {
      kind: 'group',
      projectIds: ['p1', 'p2', 'p3'],
      groupBranchName: 'feature/grouped'
    }
    const a = makeAutomation({ projectId: 'p1', target })
    const t = normalizeAutomationTarget(a)
    expect(t).toBe(target)
    expect(t).toEqual({
      kind: 'group',
      projectIds: ['p1', 'p2', 'p3'],
      groupBranchName: 'feature/grouped'
    })
  })

  it('does not mutate the input automation when inflating a legacy row', () => {
    const a = makeAutomation({ projectId: 'proj-1' })
    const before = { ...a }
    normalizeAutomationTarget(a)
    expect(a).toEqual(before)
    expect(a.target).toBeUndefined()
  })
})
