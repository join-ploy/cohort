import { describe, it, expect } from 'vitest'
import { upgradeLegacyAutomation } from './persistence-automation-migration'
import type { Automation } from '../shared/automations-types'

describe('upgradeLegacyAutomation', () => {
  it('returns the input unchanged when trigger + steps are already set', () => {
    const a: Automation = {
      id: 'a1',
      name: 'Already migrated',
      prompt: '',
      agentId: 'claude',
      projectId: 'p',
      executionTargetType: 'local',
      executionTargetId: 'local',
      schedulerOwner: 'local_host_service',
      workspaceMode: 'existing',
      workspaceId: 'ws-1',
      baseBranch: null,
      timezone: 'UTC',
      rrule: '',
      dtstart: 0,
      enabled: true,
      nextRunAt: 0,
      missedRunPolicy: 'run_once_within_grace',
      missedRunGraceMinutes: 30,
      createdAt: 0,
      updatedAt: 0,
      trigger: { kind: 'manual' },
      steps: [
        {
          id: 's1',
          kind: 'run-prompt',
          config: {
            worktreeRef: 'ws-1',
            agentId: 'claude',
            prompt: '',
            doneDebounceSeconds: 15
          },
          onFailure: 'halt',
          timeoutSeconds: null
        }
      ]
    }
    expect(upgradeLegacyAutomation(a)).toBe(a)
  })

  it('upgrades a legacy schedule-driven automation into trigger + one run-prompt step', () => {
    const legacy: Automation = {
      id: 'a2',
      name: 'Legacy',
      prompt: 'Do thing',
      agentId: 'claude',
      projectId: 'p',
      executionTargetType: 'local',
      executionTargetId: 'local',
      schedulerOwner: 'local_host_service',
      workspaceMode: 'existing',
      workspaceId: 'ws-7',
      baseBranch: null,
      timezone: 'UTC',
      rrule: 'FREQ=DAILY',
      dtstart: 1700000000,
      enabled: true,
      nextRunAt: 0,
      missedRunPolicy: 'run_once_within_grace',
      missedRunGraceMinutes: 30,
      createdAt: 0,
      updatedAt: 0
    }
    const upgraded = upgradeLegacyAutomation(legacy)
    expect(upgraded.trigger).toEqual({ kind: 'manual' })
    expect(upgraded.steps).toEqual([
      {
        id: expect.any(String),
        kind: 'run-prompt',
        config: {
          worktreeRef: 'ws-7',
          agentId: 'claude',
          prompt: 'Do thing',
          doneDebounceSeconds: 15
        },
        onFailure: 'halt',
        timeoutSeconds: null
      }
    ])
  })

  it('handles workspaceMode = new_per_run by leaving worktreeRef as a placeholder', () => {
    const legacy: Automation = {
      id: 'a3',
      name: 'Legacy new-per-run',
      prompt: 'Do thing',
      agentId: 'claude',
      projectId: 'p',
      executionTargetType: 'local',
      executionTargetId: 'local',
      schedulerOwner: 'local_host_service',
      workspaceMode: 'new_per_run',
      workspaceId: null,
      baseBranch: 'main',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY',
      dtstart: 1700000000,
      enabled: true,
      nextRunAt: 0,
      missedRunPolicy: 'run_once_within_grace',
      missedRunGraceMinutes: 30,
      createdAt: 0,
      updatedAt: 0
    }
    const upgraded = upgradeLegacyAutomation(legacy)
    expect(upgraded.steps?.[0].config).toMatchObject({
      worktreeRef: '{{automation.workspaceId}}'
    })
  })
})
