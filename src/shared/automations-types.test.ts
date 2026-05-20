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
  RunCommandConfig
} from './automations-types'
import type { TuiAgent } from './types'

describe('chain types', () => {
  it('Automation carries trigger + steps optionally for migration', () => {
    expectTypeOf<Automation['trigger']>().toEqualTypeOf<TriggerConfig | undefined>()
    expectTypeOf<Automation['steps']>().toEqualTypeOf<Step[] | undefined>()
  })

  it('TriggerConfig has a manual variant in Phase 1', () => {
    expectTypeOf<TriggerConfig>().toEqualTypeOf<{ kind: 'manual' }>()
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
