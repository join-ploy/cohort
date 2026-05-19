import { describe, it, expectTypeOf } from 'vitest'
import type {
  Automation,
  TriggerConfig,
  Step,
  StepConfig,
  StepKind,
  StepRunState,
  RunPromptConfig
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
    expectTypeOf<StepKind>().toEqualTypeOf<'run-prompt'>()
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
