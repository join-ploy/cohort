import { describe, it, expectTypeOf } from 'vitest'
import type {
  Automation,
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
    expectTypeOf<TriggerConfig['acceptsWorktreeSelection']>().toEqualTypeOf<boolean | undefined>()
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
    const t3: TriggerConfig = { kind: 'manual', acceptsWorktreeSelection: true }
    const t4: TriggerConfig = {
      kind: 'manual',
      acceptsLinearTicket: true,
      acceptsWorktreeSelection: true
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
