import { describe, it, expect, vi } from 'vitest'
import type { Step, StepRunState, WaitForSetupConfig } from '../../../shared/automations-types'
import { WaitForSetupRunner } from './wait-for-setup-runner'
import type { StepRunnerCtx } from '../step-runner'
import type { SetupScriptEntry } from '../../setup-script/registry'

const baseConfig: WaitForSetupConfig = {
  worktreeRef: 'wt-1',
  requireSuccess: true
}

const baseStep: Step = {
  id: 'wfs1',
  kind: 'wait-for-setup',
  config: baseConfig,
  onFailure: 'halt',
  timeoutSeconds: null
}

const baseState: StepRunState = {
  stepId: 'wfs1',
  status: 'pending',
  startedAt: null,
  finishedAt: null,
  output: null,
  error: null
}

const baseCtx = (overrides: Partial<StepRunnerCtx> = {}): StepRunnerCtx => ({
  runId: 'r1',
  step: baseStep,
  state: baseState,
  context: {},
  ...overrides
})

describe('WaitForSetupRunner', () => {
  it('returns needs-more-time when the setup script is running', async () => {
    const entry: SetupScriptEntry = {
      state: 'running',
      exitCode: null,
      startedAt: 100,
      finishedAt: null
    }
    const getSetupScript = vi.fn().mockReturnValue(entry)
    const runner = new WaitForSetupRunner({ getSetupScript, now: () => 200 })
    const result = await runner.tick(baseCtx())
    expect(result.outcome).toBe('needs-more-time')
    expect(result.status).toBe('running')
  })

  it('returns done when the setup script exited successfully', async () => {
    const entry: SetupScriptEntry = {
      state: 'exited-success',
      exitCode: 0,
      startedAt: 100,
      finishedAt: 300
    }
    const getSetupScript = vi.fn().mockReturnValue(entry)
    const runner = new WaitForSetupRunner({ getSetupScript, now: () => 400 })
    const result = await runner.tick(baseCtx())
    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')
    expect(result.output).toEqual({ exitCode: 0, durationMs: 200 })
  })

  it('fails when setup exited with failure and requireSuccess=true', async () => {
    const entry: SetupScriptEntry = {
      state: 'exited-failure',
      exitCode: 1,
      startedAt: 100,
      finishedAt: 300
    }
    const getSetupScript = vi.fn().mockReturnValue(entry)
    const runner = new WaitForSetupRunner({ getSetupScript, now: () => 400 })
    const result = await runner.tick(baseCtx())
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/exit code 1/)
  })

  it('succeeds even on failure when requireSuccess=false', async () => {
    const entry: SetupScriptEntry = {
      state: 'exited-failure',
      exitCode: 2,
      startedAt: 100,
      finishedAt: 300
    }
    const getSetupScript = vi.fn().mockReturnValue(entry)
    const runner = new WaitForSetupRunner({ getSetupScript, now: () => 400 })
    const step: Step = { ...baseStep, config: { worktreeRef: 'wt-1', requireSuccess: false } }
    const result = await runner.tick(baseCtx({ step }))
    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')
    expect(result.output).toEqual({ exitCode: 2, durationMs: 200 })
  })

  it('treats missing registry entry as "no setup script configured" and resolves immediately', async () => {
    const getSetupScript = vi.fn().mockReturnValue(undefined)
    const runner = new WaitForSetupRunner({ getSetupScript, now: () => 100 })
    const result = await runner.tick(baseCtx())
    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')
    expect(result.output).toEqual({ exitCode: 0, durationMs: 0 })
  })

  it('times out per step.timeoutSeconds', async () => {
    const entry: SetupScriptEntry = {
      state: 'running',
      exitCode: null,
      startedAt: 100,
      finishedAt: null
    }
    const getSetupScript = vi.fn().mockReturnValue(entry)
    const step: Step = { ...baseStep, timeoutSeconds: 10 }
    // Use a single runner with a mutable mock clock so openedAt is recorded
    // on the first tick (now=0) and the second tick (now=11_000) trips the
    // 10s timeout. Two ticks against the same (runId, stepId) is required
    // because the runner records openedAt the first time it sees a step.
    let mockNow = 0
    const runner = new WaitForSetupRunner({ getSetupScript, now: () => mockNow })
    mockNow = 0
    await runner.tick(baseCtx({ step }))
    mockNow = 11_000
    const result = await runner.tick(baseCtx({ step }))
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('timed-out')
  })

  it('fails fast on TemplateResolutionError', async () => {
    const getSetupScript = vi.fn()
    const runner = new WaitForSetupRunner({ getSetupScript, now: () => 0 })
    const step: Step = {
      ...baseStep,
      config: { worktreeRef: '{{missing.path}}', requireSuccess: true }
    }
    const result = await runner.tick(baseCtx({ step }))
    expect(result.outcome).toBe('failed')
    expect(result.error).toMatch(/missing\.path/)
    expect(getSetupScript).not.toHaveBeenCalled()
  })
})
