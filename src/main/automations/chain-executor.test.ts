import { describe, it, expect, vi } from 'vitest'
import { ChainExecutor } from './chain-executor'
import type { Automation, AutomationRun, Step } from '../../shared/automations-types'
import type { StepRunner } from './step-runner'

function automation(steps: Step[]): Automation {
  return {
    id: 'a1',
    name: 'test',
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
    steps
  }
}

function run(automationId: string, partial: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'r1',
    automationId,
    title: 'test',
    scheduledFor: 0,
    status: 'running',
    trigger: 'manual',
    workspaceId: 'ws-1',
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    error: null,
    startedAt: 0,
    dispatchedAt: null,
    createdAt: 0,
    stepStates: [],
    context: {},
    ...partial
  }
}

const sampleStep: Step = {
  id: 's1',
  kind: 'run-prompt',
  config: { worktreeRef: 'wt-1', agentId: 'claude', prompt: 'go', doneDebounceSeconds: 15 },
  onFailure: 'halt',
  timeoutSeconds: null
}

describe('ChainExecutor', () => {
  it('initializes step states from the automation steps on first tick', async () => {
    const tick = vi.fn().mockResolvedValue({ outcome: 'needs-more-time', status: 'running' })
    const runner: StepRunner = { tick }
    const persisted: AutomationRun[] = []
    const executor = new ChainExecutor({
      getRunner: () => runner,
      persistRun: (r) => persisted.push(r),
      now: () => 0
    })
    const r = run('a1', { stepStates: [] })
    await executor.tick(automation([sampleStep]), r)
    expect(r.stepStates).toEqual([
      expect.objectContaining({ stepId: 's1', status: 'running', startedAt: 0 })
    ])
  })

  it('advances to the next step when current step returns done', async () => {
    const tick = vi
      .fn()
      .mockResolvedValueOnce({ outcome: 'done', status: 'succeeded', output: { x: 1 } })
      .mockResolvedValueOnce({ outcome: 'needs-more-time', status: 'running' })
    const runner: StepRunner = { tick }
    const executor = new ChainExecutor({
      getRunner: () => runner,
      persistRun: vi.fn(),
      now: () => 100
    })
    const s2: Step = { ...sampleStep, id: 's2' }
    const r = run('a1')
    // Why: a single tick() now loops past any synchronously-done steps so the
    // 60s scheduler cadence doesn't gate trivial advances. The first call
    // both finishes s1 (`done`) and starts s2 (`needs-more-time`).
    await executor.tick(automation([sampleStep, s2]), r)
    expect(r.stepStates![0].status).toBe('succeeded')
    expect(r.stepStates![0].output).toEqual({ x: 1 })
    expect(r.stepStates![1].status).toBe('running')
    expect(r.stepStates![1].startedAt).toBe(100)
  })

  it('marks the run completed when all steps succeed', async () => {
    const tick = vi.fn().mockResolvedValue({ outcome: 'done', status: 'succeeded' })
    const runner: StepRunner = { tick }
    const executor = new ChainExecutor({
      getRunner: () => runner,
      persistRun: vi.fn(),
      now: () => 0
    })
    const r = run('a1')
    await executor.tick(automation([sampleStep]), r) // first/only step
    expect(r.status).toBe('completed')
    expect(r.finishedAt).toBeDefined()
  })

  it('halts the run on failure when onFailure="halt"', async () => {
    const tick = vi.fn().mockResolvedValue({ outcome: 'failed', status: 'failed', error: 'bad' })
    const runner: StepRunner = { tick }
    const executor = new ChainExecutor({
      getRunner: () => runner,
      persistRun: vi.fn(),
      now: () => 0
    })
    const s2: Step = { ...sampleStep, id: 's2' }
    const r = run('a1')
    await executor.tick(automation([sampleStep, s2]), r)
    expect(r.stepStates![0].status).toBe('failed')
    expect(r.stepStates![0].error).toBe('bad')
    // s2 should NOT advance
    expect(r.stepStates!.length).toBe(1)
    expect(r.status).toBe('failed')
  })

  it('continues past a failing step when onFailure="continue"', async () => {
    const tick = vi
      .fn()
      .mockResolvedValueOnce({ outcome: 'failed', status: 'failed', error: 'oops' })
      .mockResolvedValueOnce({ outcome: 'done', status: 'succeeded' })
    const runner: StepRunner = { tick }
    const executor = new ChainExecutor({
      getRunner: () => runner,
      persistRun: vi.fn(),
      now: () => 0
    })
    const s1c: Step = { ...sampleStep, onFailure: 'continue' }
    const s2: Step = { ...sampleStep, id: 's2', onFailure: 'halt' }
    const r = run('a1')
    await executor.tick(automation([s1c, s2]), r) // s1 fails (continue), s2 advances
    await executor.tick(automation([s1c, s2]), r) // s2 succeeds
    expect(r.stepStates![0].status).toBe('failed')
    expect(r.stepStates![1].status).toBe('succeeded')
    expect(r.status).toBe('completed')
  })

  it('applies contextPatch into run.context after a successful step', async () => {
    const tick = vi.fn().mockResolvedValue({
      outcome: 'done',
      status: 'succeeded',
      output: { foo: 'bar' },
      contextPatch: { steps: { s1: { foo: 'bar' } } }
    })
    const runner: StepRunner = { tick }
    const executor = new ChainExecutor({
      getRunner: () => runner,
      persistRun: vi.fn(),
      now: () => 0
    })
    const r = run('a1', { context: { existing: true } })
    await executor.tick(automation([sampleStep]), r)
    expect(r.context).toEqual({
      existing: true,
      steps: { s1: { foo: 'bar' } }
    })
  })

  it('is a no-op for runs without trigger+steps (legacy)', async () => {
    const tick = vi.fn()
    const runner: StepRunner = { tick }
    const executor = new ChainExecutor({
      getRunner: () => runner,
      persistRun: vi.fn(),
      now: () => 0
    })
    const r = run('a1')
    const legacyAutomation = { ...automation([sampleStep]), trigger: undefined, steps: undefined }
    await executor.tick(legacyAutomation as never, r)
    expect(tick).not.toHaveBeenCalled()
  })

  it('throws when getRunner returns undefined for an unknown step kind', async () => {
    const executor = new ChainExecutor({
      getRunner: () => undefined,
      persistRun: vi.fn(),
      now: () => 0
    })
    const r = run('a1')
    await expect(executor.tick(automation([sampleStep]), r)).rejects.toThrow(
      /no runner registered/i
    )
  })

  it('passes accumulated run.context into the StepRunnerCtx', async () => {
    const tick = vi.fn().mockResolvedValue({ outcome: 'needs-more-time', status: 'running' })
    const runner: StepRunner = { tick }
    const executor = new ChainExecutor({
      getRunner: () => runner,
      persistRun: vi.fn(),
      now: () => 0
    })
    const r = run('a1', { context: { trigger: { kind: 'manual' } } })
    await executor.tick(automation([sampleStep]), r)
    expect(tick).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'r1',
        step: sampleStep,
        context: { trigger: { kind: 'manual' } }
      })
    )
  })
})
