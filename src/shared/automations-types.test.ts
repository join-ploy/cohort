import { describe, it, expect, expectTypeOf } from 'vitest'
import type {
  Automation,
  AutoTrigger,
  Rule,
  Condition,
  TriggerConfig,
  Step,
  StepConfig,
  StepKind,
  StepRunState,
  RunPromptConfig,
  CreateWorktreeConfig,
  WaitForSetupConfig,
  RunCommandConfig,
  LinearIssuePayload
} from './automations-types'
import type { TuiAgent } from './types'

describe('chain types', () => {
  it('Automation carries trigger + steps optionally for migration', () => {
    expectTypeOf<Automation['trigger']>().toEqualTypeOf<TriggerConfig | undefined>()
    expectTypeOf<Automation['steps']>().toEqualTypeOf<Step[] | undefined>()
  })

  it('TriggerConfig has a manual variant with optional accept-flags', () => {
    expectTypeOf<TriggerConfig['kind']>().toEqualTypeOf<'manual'>()
    expectTypeOf<TriggerConfig['acceptsLinearTicket']>().toEqualTypeOf<boolean | undefined>()
    expectTypeOf<TriggerConfig['acceptsProjectSelection']>().toEqualTypeOf<boolean | undefined>()
  })

  it('Step carries id, kind, config, onFailure, timeoutSeconds', () => {
    expectTypeOf<Step['id']>().toEqualTypeOf<string>()
    expectTypeOf<Step['kind']>().toEqualTypeOf<StepKind>()
    expectTypeOf<Step['config']>().toEqualTypeOf<StepConfig>()
    expectTypeOf<Step['onFailure']>().toEqualTypeOf<'halt' | 'continue'>()
    expectTypeOf<Step['timeoutSeconds']>().toEqualTypeOf<number | null>()
  })

  it('RunPromptConfig matches the design doc shape', () => {
    expectTypeOf<RunPromptConfig['worktreeRef']>().toEqualTypeOf<string>()
    expectTypeOf<RunPromptConfig['agentId']>().toEqualTypeOf<TuiAgent>()
    expectTypeOf<RunPromptConfig['prompt']>().toEqualTypeOf<string>()
    expectTypeOf<RunPromptConfig['doneDebounceSeconds']>().toEqualTypeOf<number>()
  })

  it('StepRunState records status + timing + output + error', () => {
    expectTypeOf<StepRunState['status']>().toEqualTypeOf<
      'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'timed-out'
    >()
  })
})

describe('Phase 2 step configs', () => {
  it('StepKind covers all 4 kinds', () => {
    expectTypeOf<StepKind>().toEqualTypeOf<
      'run-prompt' | 'create-worktree' | 'wait-for-setup' | 'run-command'
    >()
  })

  it('CreateWorktreeConfig shape', () => {
    expectTypeOf<CreateWorktreeConfig['baseBranch']>().toEqualTypeOf<string>()
    expectTypeOf<CreateWorktreeConfig['branchName']>().toEqualTypeOf<string>()
    expectTypeOf<CreateWorktreeConfig['displayName']>().toEqualTypeOf<string>()
    expectTypeOf<CreateWorktreeConfig['linkLinearIssue']>().toEqualTypeOf<boolean>()
  })

  it('WaitForSetupConfig shape', () => {
    expectTypeOf<WaitForSetupConfig['worktreeRef']>().toEqualTypeOf<string>()
    expectTypeOf<WaitForSetupConfig['requireSuccess']>().toEqualTypeOf<boolean>()
  })

  it('RunCommandConfig shape with source discriminator', () => {
    expectTypeOf<RunCommandConfig['source']>().toEqualTypeOf<'review' | 'create-pr' | 'custom'>()
    expectTypeOf<RunCommandConfig['captureStdout']>().toEqualTypeOf<boolean>()
    expectTypeOf<RunCommandConfig['worktreeRef']>().toEqualTypeOf<string>()
  })

  it('StepConfig is a union of all four configs', () => {
    // A value of any of the four shapes should be assignable to StepConfig.
    const cw: StepConfig = {
      baseBranch: 'main',
      branchName: 'b',
      displayName: 'd',
      linkLinearIssue: false
    }
    const wfs: StepConfig = { worktreeRef: 'wt', requireSuccess: true }
    const rc: StepConfig = { worktreeRef: 'wt', source: 'custom', captureStdout: false }
    const rp: StepConfig = {
      worktreeRef: 'wt',
      agentId: 'claude',
      prompt: 'p',
      doneDebounceSeconds: 15
    }
    expectTypeOf(cw).toMatchTypeOf<StepConfig>()
    expectTypeOf(wfs).toMatchTypeOf<StepConfig>()
    expectTypeOf(rc).toMatchTypeOf<StepConfig>()
    expectTypeOf(rp).toMatchTypeOf<StepConfig>()
  })
})

describe('manual payload types', () => {
  it('TriggerConfig manual variant accepts the two optional booleans', () => {
    const t1: TriggerConfig = { kind: 'manual' }
    const t2: TriggerConfig = { kind: 'manual', acceptsLinearTicket: true }
    const t3: TriggerConfig = { kind: 'manual', acceptsProjectSelection: true }
    const t4: TriggerConfig = {
      kind: 'manual',
      acceptsLinearTicket: true,
      acceptsProjectSelection: true
    }
    expectTypeOf(t1).toMatchTypeOf<TriggerConfig>()
    expectTypeOf(t2).toMatchTypeOf<TriggerConfig>()
    expectTypeOf(t3).toMatchTypeOf<TriggerConfig>()
    expectTypeOf(t4).toMatchTypeOf<TriggerConfig>()
  })

  it('RunPromptConfig gains optional paneRef', () => {
    expectTypeOf<RunPromptConfig['paneRef']>().toEqualTypeOf<string | undefined>()
  })

  it('LinearIssuePayload has the documented fields', () => {
    expectTypeOf<LinearIssuePayload['id']>().toEqualTypeOf<string>()
    expectTypeOf<LinearIssuePayload['identifier']>().toEqualTypeOf<string>()
    expectTypeOf<LinearIssuePayload['title']>().toEqualTypeOf<string>()
    expectTypeOf<LinearIssuePayload['description']>().toEqualTypeOf<string>()
    expectTypeOf<LinearIssuePayload['url']>().toEqualTypeOf<string>()
    expectTypeOf<LinearIssuePayload['assigneeEmail']>().toEqualTypeOf<string>()
    expectTypeOf<LinearIssuePayload['stateName']>().toEqualTypeOf<string>()
    expectTypeOf<LinearIssuePayload['priority']>().toEqualTypeOf<number>()
  })
})

describe('AutoTrigger shape', () => {
  it('accepts a minimal linear-issue auto trigger', () => {
    const cond: Condition = {
      field: 'linear.assignee',
      op: 'is',
      value: 'me@example.com'
    }
    const rule: Rule = {
      id: 'r1',
      conditions: [cond],
      projectId: 'p1'
    }
    const trig: AutoTrigger = {
      id: 'at1',
      source: 'linear-issue',
      enabled: true,
      enabledAt: 1_700_000_000_000,
      rules: [rule]
    }
    const a: Automation = {
      id: 'a1',
      name: 'x',
      prompt: 'p',
      agentId: 'claude',
      projectId: 'p1',
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
      autoTriggers: [trig]
    }
    expect(a.autoTriggers?.[0]?.rules[0]?.projectId).toBe('p1')
  })
})
