import { describe, it, expect, vi } from 'vitest'
import { ChainExecutor } from './chain-executor'
import type { Automation, AutomationRun, Step, StepOrGroup } from '../../shared/automations-types'
import type { StepRunner } from './step-runner'

function automation(steps: StepOrGroup[]): Automation {
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

  it('persists step output on a non-terminal (needs-more-time) tick', async () => {
    // Long-lived runners (watch-pr) emit durable progress as `output` on every
    // waiting tick and rehydrate from state.output after a restart. The executor
    // must write that output even though the step has not finished.
    const tick = vi.fn().mockResolvedValue({
      outcome: 'needs-more-time',
      status: 'waiting',
      output: { phase: 'watching', cycleIndex: 2 }
    })
    const runner: StepRunner = { tick }
    const persisted: AutomationRun[] = []
    const executor = new ChainExecutor({
      getRunner: () => runner,
      persistRun: (r) => persisted.push(structuredClone(r)),
      now: () => 0
    })
    const r = run('a1', { stepStates: [] })
    await executor.tick(automation([sampleStep]), r)
    expect(r.stepStates![0]).toMatchObject({
      status: 'waiting',
      finishedAt: null, // still in progress
      output: { phase: 'watching', cycleIndex: 2 }
    })
    // And it was flushed to the store, so a restart can rehydrate from it.
    expect(persisted.at(-1)!.stepStates![0].output).toEqual({ phase: 'watching', cycleIndex: 2 })
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

  describe('endChain', () => {
    it('finalizes the run completed without advancing downstream', async () => {
      // The first step ends the chain cleanly; the second must never run.
      const tick = vi
        .fn()
        .mockResolvedValueOnce({ outcome: 'done', status: 'succeeded', endChain: true })
        .mockResolvedValueOnce({ outcome: 'done', status: 'succeeded' })
      const runner: StepRunner = { tick }
      const executor = new ChainExecutor({
        getRunner: () => runner,
        persistRun: vi.fn(),
        now: () => 1000
      })
      const s1: Step = { ...sampleStep, id: 's1' }
      const s2: Step = { ...sampleStep, id: 's2' }
      const r = run('a1')
      await executor.tick(automation([s1, s2]), r)
      expect(r.status).toBe('completed')
      expect(r.finishedAt).toBe(1000)
      // s2 never materialized.
      expect(r.stepStates!.map((s) => s.stepId)).toEqual(['s1'])
      expect(tick).toHaveBeenCalledTimes(1)
    })

    it('finalizes the run completed when a parallel sibling ends the chain', async () => {
      // One sibling ends the chain; the group settles then finalizes completed
      // and the downstream solo step never runs.
      const tick = vi
        .fn()
        .mockResolvedValueOnce({ outcome: 'done', status: 'succeeded', endChain: true })
        .mockResolvedValueOnce({ outcome: 'done', status: 'succeeded' })
        .mockResolvedValueOnce({ outcome: 'done', status: 'succeeded' })
      const runner: StepRunner = { tick }
      const executor = new ChainExecutor({
        getRunner: () => runner,
        persistRun: vi.fn(),
        now: () => 1000
      })
      const s1: Step = { ...sampleStep, id: 's1' }
      const s2: Step = { ...sampleStep, id: 's2' }
      const s3: Step = { ...sampleStep, id: 's3' }
      const r = run('a1')
      await executor.tick(automation([[s1, s2], s3]), r)
      expect(r.status).toBe('completed')
      expect(r.finishedAt).toBe(1000)
      // s3 (downstream) never materialized.
      expect(r.stepStates!.map((s) => s.stepId)).toEqual(['s1', 's2'])
    })

    it('halt-failure takes precedence over a sibling that ends the chain', async () => {
      // A halt-policy sibling failing must poison the run even when another
      // sibling asks to end the chain cleanly — the run is 'failed', not
      // 'completed', and the downstream step never runs.
      const tick = vi
        .fn()
        .mockResolvedValueOnce({ outcome: 'failed', status: 'failed' })
        .mockResolvedValueOnce({ outcome: 'done', status: 'succeeded', endChain: true })
        .mockResolvedValueOnce({ outcome: 'done', status: 'succeeded' })
      const runner: StepRunner = { tick }
      const executor = new ChainExecutor({
        getRunner: () => runner,
        persistRun: vi.fn(),
        now: () => 1000
      })
      const s1: Step = { ...sampleStep, id: 's1', onFailure: 'halt' }
      const s2: Step = { ...sampleStep, id: 's2' }
      const s3: Step = { ...sampleStep, id: 's3' }
      const r = run('a1')
      await executor.tick(automation([[s1, s2], s3]), r)
      expect(r.status).toBe('failed')
      // s3 (downstream) never materialized.
      expect(r.stepStates!.map((s) => s.stepId)).toEqual(['s1', 's2'])
    })
  })

  describe('parallel groups', () => {
    it('persists the materialised group before awaiting the (blocking) sibling ticks', async () => {
      // Why: a run-prompt sibling can block up to 30s on the openPromptPane /
      // sendPromptToPane renderer round-trip. If the group is only persisted
      // AFTER Promise.all, a restart during that window loses the entire
      // materialised group from disk — it vanishes from run history. The
      // executor must persist the freshly-materialised 'running' group before
      // entering the blocking sibling ticks.
      let resolveTick!: (value: { outcome: 'needs-more-time'; status: 'running' }) => void
      const hangingTick = new Promise<{ outcome: 'needs-more-time'; status: 'running' }>((res) => {
        resolveTick = res
      })
      const tick = vi.fn().mockReturnValue(hangingTick)
      const runner: StepRunner = { tick }
      const persistedSnapshots: { length: number; statuses: string[] }[] = []
      const executor = new ChainExecutor({
        getRunner: () => runner,
        persistRun: (r) => {
          persistedSnapshots.push({
            length: r.stepStates?.length ?? 0,
            statuses: (r.stepStates ?? []).map((s) => s.status)
          })
        },
        now: () => 0
      })
      const s1: Step = { ...sampleStep, id: 's1' }
      const s2: Step = { ...sampleStep, id: 's2' }
      const r = run('a1')

      // Fire the tick but do NOT await — the sibling ticks hang (mirroring a
      // 30s openPromptPane wait), so executor.tick() stays pending.
      void executor.tick(automation([[s1, s2]]), r)
      // Flush the synchronous materialisation + persist that should precede the
      // blocking Promise.all.
      await Promise.resolve()
      await Promise.resolve()

      expect(
        persistedSnapshots.some(
          (snap) => snap.length === 2 && snap.statuses.every((s) => s === 'running')
        )
      ).toBe(true)

      // Release the hang so the pending tick can settle cleanly.
      resolveTick({ outcome: 'needs-more-time', status: 'running' })
    })

    it('ticks all siblings in a parallel group', async () => {
      const tick = vi.fn().mockResolvedValue({ outcome: 'needs-more-time', status: 'running' })
      const runner: StepRunner = { tick }
      const executor = new ChainExecutor({
        getRunner: () => runner,
        persistRun: vi.fn(),
        now: () => 0
      })
      const s1: Step = { ...sampleStep, id: 's1' }
      const s2: Step = { ...sampleStep, id: 's2' }
      const r = run('a1')
      await executor.tick(automation([[s1, s2]]), r)
      expect(r.stepStates).toHaveLength(2)
      expect(r.stepStates![0]).toMatchObject({ stepId: 's1', status: 'running' })
      expect(r.stepStates![1]).toMatchObject({ stepId: 's2', status: 'running' })
      expect(tick).toHaveBeenCalledTimes(2)
    })

    it('waits for all siblings before advancing past the group', async () => {
      const tick = vi
        .fn()
        .mockResolvedValueOnce({ outcome: 'done', status: 'succeeded' })
        .mockResolvedValueOnce({ outcome: 'needs-more-time', status: 'running' })
      const runner: StepRunner = { tick }
      const executor = new ChainExecutor({
        getRunner: () => runner,
        persistRun: vi.fn(),
        now: () => 0
      })
      const s1: Step = { ...sampleStep, id: 's1' }
      const s2: Step = { ...sampleStep, id: 's2' }
      const s3: Step = { ...sampleStep, id: 's3' }
      const r = run('a1')
      await executor.tick(automation([[s1, s2], s3]), r)
      expect(r.stepStates).toHaveLength(2)
      expect(r.stepStates![0].status).toBe('succeeded')
      expect(r.stepStates![1].status).toBe('running')
    })

    it('advances past the group when all siblings are terminal', async () => {
      const tick = vi
        .fn()
        .mockResolvedValueOnce({ outcome: 'done', status: 'succeeded' })
        .mockResolvedValueOnce({ outcome: 'done', status: 'succeeded' })
        .mockResolvedValueOnce({ outcome: 'needs-more-time', status: 'running' })
      const runner: StepRunner = { tick }
      const executor = new ChainExecutor({
        getRunner: () => runner,
        persistRun: vi.fn(),
        now: () => 0
      })
      const s1: Step = { ...sampleStep, id: 's1' }
      const s2: Step = { ...sampleStep, id: 's2' }
      const s3: Step = { ...sampleStep, id: 's3' }
      const r = run('a1')
      await executor.tick(automation([[s1, s2], s3]), r)
      expect(r.stepStates).toHaveLength(3)
      expect(r.stepStates![2]).toMatchObject({ stepId: 's3', status: 'running' })
    })

    it('halts the run when a halt-policy sibling fails (after all finish)', async () => {
      const tick = vi
        .fn()
        .mockResolvedValueOnce({ outcome: 'failed', status: 'failed', error: 'boom' })
        .mockResolvedValueOnce({ outcome: 'done', status: 'succeeded' })
      const runner: StepRunner = { tick }
      const executor = new ChainExecutor({
        getRunner: () => runner,
        persistRun: vi.fn(),
        now: () => 0
      })
      const s1: Step = { ...sampleStep, id: 's1', onFailure: 'halt' }
      const s2: Step = { ...sampleStep, id: 's2' }
      const s3: Step = { ...sampleStep, id: 's3' }
      const r = run('a1')
      await executor.tick(automation([[s1, s2], s3]), r)
      expect(r.status).toBe('failed')
      expect(r.stepStates).toHaveLength(2)
    })

    it('continues past group when all failures are continue-policy', async () => {
      const tick = vi
        .fn()
        .mockResolvedValueOnce({ outcome: 'failed', status: 'failed', error: 'oops' })
        .mockResolvedValueOnce({ outcome: 'done', status: 'succeeded' })
        .mockResolvedValueOnce({ outcome: 'done', status: 'succeeded' })
      const runner: StepRunner = { tick }
      const executor = new ChainExecutor({
        getRunner: () => runner,
        persistRun: vi.fn(),
        now: () => 0
      })
      const s1: Step = { ...sampleStep, id: 's1', onFailure: 'continue' }
      const s2: Step = { ...sampleStep, id: 's2' }
      const s3: Step = { ...sampleStep, id: 's3' }
      const r = run('a1')
      await executor.tick(automation([[s1, s2], s3]), r)
      expect(r.stepStates).toHaveLength(3)
      expect(r.status).toBe('completed')
    })

    it('merges context patches from parallel siblings without clobbering', async () => {
      const tick = vi
        .fn()
        .mockResolvedValueOnce({
          outcome: 'done',
          status: 'succeeded',
          contextPatch: { steps: { s1: { out: 'a' } } }
        })
        .mockResolvedValueOnce({
          outcome: 'done',
          status: 'succeeded',
          contextPatch: { steps: { s2: { out: 'b' } } }
        })
      const runner: StepRunner = { tick }
      const executor = new ChainExecutor({
        getRunner: () => runner,
        persistRun: vi.fn(),
        now: () => 0
      })
      const s1: Step = { ...sampleStep, id: 's1' }
      const s2: Step = { ...sampleStep, id: 's2' }
      const r = run('a1')
      await executor.tick(automation([[s1, s2]]), r)
      expect(r.context).toMatchObject({
        steps: { s1: { out: 'a' }, s2: { out: 'b' } }
      })
    })
  })
})
