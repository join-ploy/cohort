import { describe, it, expect, vi } from 'vitest'
import { WatchPrRunner, type WatchPrDeps, type AgentLiveStatus } from './watch-pr-runner'
import type { StepRunnerCtx } from '../step-runner'
import type { WatchPrConfig, Step } from '../../../shared/automations-types'
import type { PRWatchState, PRReview } from '../../github/client'
import type { PRComment } from '../../../shared/types'

function makeDeps(overrides: Partial<WatchPrDeps> = {}): WatchPrDeps {
  return {
    getWorktreeMeta: () => ({ linkedPR: 42, path: '/tmp/wt', repoPath: '/tmp/repo' }),
    getRepoPath: () => '/tmp/repo',
    resolveLinkedPR: async () => null,
    isWorktreeArchived: () => false,
    getPRState: async () =>
      ({
        state: 'OPEN',
        mergedAt: null,
        closedAt: null,
        reviewDecision: null,
        title: 'Test PR',
        url: 'https://github.com/owner/repo/pull/42'
      }) as PRWatchState,
    getPRReviews: async () => [],
    getPRComments: vi.fn(async () => [] as PRComment[]),
    getAgentLiveStatus: (): AgentLiveStatus => 'idle',
    spawnChildRun: vi.fn(() => 'child-1'),
    getChildRunStatus: () => 'missing',
    cancelChildRunsForStep: vi.fn(),
    now: () => 1000,
    ...overrides
  }
}

function makeCtx(opts: {
  configOverrides?: Partial<WatchPrConfig>
  context?: Record<string, unknown>
  stateOutput?: unknown
  stepId?: string
}): StepRunnerCtx {
  const stepId = opts.stepId ?? 'step-1'
  const config: WatchPrConfig = {
    worktreeRef: 'repo-a::/tmp/wt',
    paneRef: 'tab1:2',
    events: { changesRequested: true, newReviewComments: false, anyReview: false },
    pollIntervalSeconds: 30,
    agentIdleDebounceSeconds: 5,
    branchSteps: [],
    ...opts.configOverrides
  }
  const step: Step = {
    id: stepId,
    kind: 'watch-pr',
    config,
    onFailure: 'halt',
    timeoutSeconds: null
  }
  return {
    runId: 'run-1',
    step,
    state: {
      stepId,
      status: 'pending',
      startedAt: null,
      finishedAt: null,
      output: opts.stateOutput ?? null,
      error: null
    },
    context: opts.context ?? {}
  }
}

describe('WatchPrRunner — resolving phase', () => {
  it('waits for a linked PR when none is resolvable', async () => {
    const runner = new WatchPrRunner(
      makeDeps({
        getWorktreeMeta: () => ({ linkedPR: null, path: '/wt', repoPath: '/repo' }),
        resolveLinkedPR: async () => null
      })
    )
    const result = await runner.tick(makeCtx({}))
    expect(result.outcome).toBe('needs-more-time')
    expect(result.status).toBe('waiting')
    expect(result.statusMessage).toBe('Waiting for PR to be linked')
  })

  it('resolves PR (via linkedPR) + pane and advances to watching', async () => {
    const runner = new WatchPrRunner(
      makeDeps({ getWorktreeMeta: () => ({ linkedPR: 42, path: '/wt', repoPath: '/repo' }) })
    )
    const result = await runner.tick(
      makeCtx({
        configOverrides: { paneRef: '{{steps.rp.paneKey}}' },
        context: { steps: { rp: { paneKey: 'tab1:2' } } }
      })
    )
    expect(result.outcome).toBe('needs-more-time')
    expect(result.status).toBe('waiting')
    expect(result.statusMessage).toBe('Watching #42')
    const output = result.output as Record<string, unknown>
    expect(output.phase).toBe('watching')
    expect(output.prNumber).toBe(42)
    expect(output.paneKey).toBe('tab1:2')
  })

  it('resolves PR via resolveLinkedPR fallback when linkedPR is null', async () => {
    const runner = new WatchPrRunner(
      makeDeps({
        getWorktreeMeta: () => ({ linkedPR: null, path: '/wt', repoPath: '/repo' }),
        resolveLinkedPR: async () => 7
      })
    )
    const result = await runner.tick(makeCtx({}))
    expect(result.outcome).toBe('needs-more-time')
    expect(result.status).toBe('waiting')
    const output = result.output as Record<string, unknown>
    expect(output.phase).toBe('watching')
    expect(output.prNumber).toBe(7)
  })

  it('rehydrates from persisted state.output without resetting', async () => {
    const runner = new WatchPrRunner(makeDeps())
    const result = await runner.tick(
      makeCtx({
        stateOutput: {
          phase: 'watching',
          prNumber: 99,
          repoPath: '/repo',
          paneKey: 'tab1:2',
          handledCursor: '2026-06-01T00:00:00Z',
          pendingWatermark: '',
          dirty: false,
          activeChildRunId: null,
          cycleIndex: 3
        }
      })
    )
    const output = result.output as Record<string, unknown>
    expect(output.cycleIndex).toBe(3)
    expect(output.prNumber).toBe(99)
    expect(output.phase).toBe('watching')
  })

  it('fails on unknown worktree', async () => {
    const runner = new WatchPrRunner(makeDeps({ getWorktreeMeta: () => undefined }))
    const result = await runner.tick(makeCtx({}))
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
  })

  it('fails on a bad worktreeRef template (unresolved intermediate path)', async () => {
    // resolveTemplate throws TemplateResolutionError when an intermediate
    // segment is missing (reachedEnd: false). `{{trigger.missing}}` over an
    // empty context breaks at `trigger`, which triggers the throw.
    const runner = new WatchPrRunner(makeDeps())
    const result = await runner.tick(
      makeCtx({ configOverrides: { worktreeRef: '{{trigger.missing}}' }, context: {} })
    )
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
  })
})

// A persisted state.output that lands the runner directly in the watching phase
// on its first tick (skips resolving).
function watchingState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: 'watching',
    prNumber: 42,
    repoPath: '/tmp/repo',
    paneKey: 'tab1:2',
    handledCursor: '',
    pendingWatermark: '',
    dirty: false,
    activeChildRunId: null,
    cycleIndex: 0,
    ...overrides
  }
}

function review(overrides: Partial<PRReview> = {}): PRReview {
  return {
    id: 'r1',
    author: 'reviewer',
    state: 'COMMENTED',
    submittedAt: '2026-06-02T00:00:00Z',
    body: '',
    ...overrides
  }
}

function comment(overrides: Partial<PRComment> = {}): PRComment {
  return {
    id: 1,
    author: 'reviewer',
    authorAvatarUrl: '',
    body: 'please fix this',
    createdAt: '2026-06-02T00:00:00Z',
    url: 'https://example.com/c/1',
    ...overrides
  }
}

describe('WatchPrRunner — watching phase', () => {
  it('merged → done/succeeded, endChain falsy, finalState "merged"', async () => {
    const runner = new WatchPrRunner(
      makeDeps({
        // now() past one poll interval so the cadence-gated terminal check runs
        // on the first watching tick (lastPollAt seeds to 0).
        now: () => 1_000_000,
        getPRState: async () =>
          ({
            state: 'MERGED',
            mergedAt: '2026-06-03T00:00:00Z',
            closedAt: null,
            reviewDecision: null
          }) as PRWatchState
      })
    )
    const result = await runner.tick(makeCtx({ stateOutput: watchingState() }))
    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')
    expect(result.endChain).toBeFalsy()
    const output = result.output as Record<string, unknown>
    expect(output.finalState).toBe('merged')
    const patch = result.contextPatch as { steps: Record<string, Record<string, unknown>> }
    expect(patch.steps['step-1'].finalState).toBe('merged')
  })

  it('closed → done/succeeded + endChain true, finalState "closed"', async () => {
    const runner = new WatchPrRunner(
      makeDeps({
        // now() past one poll interval so the cadence-gated terminal check runs.
        now: () => 1_000_000,
        getPRState: async () =>
          ({
            state: 'CLOSED',
            mergedAt: null,
            closedAt: '2026-06-03T00:00:00Z',
            reviewDecision: null
          }) as PRWatchState
      })
    )
    const result = await runner.tick(makeCtx({ stateOutput: watchingState() }))
    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')
    expect(result.endChain).toBe(true)
    const output = result.output as Record<string, unknown>
    expect(output.finalState).toBe('closed')
    const patch = result.contextPatch as { steps: Record<string, Record<string, unknown>> }
    expect(patch.steps['step-1'].finalState).toBe('closed')
  })

  it('archived → endChain true, finalState "archived", cancelChildRunsForStep called', async () => {
    const cancel = vi.fn()
    const getPRState = vi.fn(async () => ({ state: 'OPEN' }) as unknown as PRWatchState)
    const runner = new WatchPrRunner(
      makeDeps({
        // now() past one poll interval so the cadence-gated terminal check runs.
        now: () => 1_000_000,
        isWorktreeArchived: () => true,
        cancelChildRunsForStep: cancel,
        getPRState
      })
    )
    const result = await runner.tick(makeCtx({ stateOutput: watchingState() }))
    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')
    expect(result.endChain).toBe(true)
    const output = result.output as Record<string, unknown>
    expect(output.finalState).toBe('archived')
    expect(cancel).toHaveBeenCalledWith('run-1', 'step-1')
    // Archived is checked first, so the PR state read is skipped entirely.
    expect(getPRState).not.toHaveBeenCalled()
  })

  it('arming: a CHANGES_REQUESTED review newer than handledCursor sets dirty', async () => {
    const runner = new WatchPrRunner(
      makeDeps({
        // now() past one poll interval so the first watching tick polls
        // (lastPollAt seeds to 0).
        now: () => 1_000_000,
        getPRState: async () => ({ state: 'OPEN' }) as unknown as PRWatchState,
        getPRReviews: async () => [
          review({ state: 'CHANGES_REQUESTED', submittedAt: '2026-06-02T00:00:00Z' })
        ]
      })
    )
    const result = await runner.tick(
      makeCtx({
        configOverrides: {
          events: { changesRequested: true, newReviewComments: false, anyReview: false }
        },
        stateOutput: watchingState()
      })
    )
    expect(result.status).toBe('waiting')
    const output = result.output as Record<string, unknown>
    expect(output.dirty).toBe(true)
    expect(output.pendingWatermark).toBe('2026-06-02T00:00:00Z')
  })

  it('arming negative: a COMMENTED review does NOT arm when only changesRequested enabled', async () => {
    const runner = new WatchPrRunner(
      makeDeps({
        getPRState: async () => ({ state: 'OPEN' }) as unknown as PRWatchState,
        getPRReviews: async () => [
          review({ state: 'COMMENTED', submittedAt: '2026-06-02T00:00:00Z' })
        ]
      })
    )
    const result = await runner.tick(
      makeCtx({
        configOverrides: {
          events: { changesRequested: true, newReviewComments: false, anyReview: false }
        },
        stateOutput: watchingState()
      })
    )
    const output = result.output as Record<string, unknown>
    expect(output.dirty).toBe(false)
  })

  it('arming positive: a COMMENTED review arms when newReviewComments enabled', async () => {
    const runner = new WatchPrRunner(
      makeDeps({
        now: () => 1_000_000,
        getPRState: async () => ({ state: 'OPEN' }) as unknown as PRWatchState,
        getPRReviews: async () => [
          review({ state: 'COMMENTED', submittedAt: '2026-06-02T00:00:00Z' })
        ]
      })
    )
    const result = await runner.tick(
      makeCtx({
        configOverrides: {
          events: { changesRequested: false, newReviewComments: true, anyReview: false }
        },
        stateOutput: watchingState()
      })
    )
    const output = result.output as Record<string, unknown>
    expect(output.dirty).toBe(true)
    expect(output.pendingWatermark).toBe('2026-06-02T00:00:00Z')
  })

  it('poll cadence: within pollInterval, getPRReviews is NOT called again', async () => {
    let nowValue = 1_000_000
    const getPRReviews = vi.fn(async () => [] as PRReview[])
    const runner = new WatchPrRunner(
      makeDeps({
        getPRState: async () => ({ state: 'OPEN' }) as unknown as PRWatchState,
        getPRReviews,
        now: () => nowValue
      })
    )
    // First watching tick polls (lastPollAt starts at 0).
    await runner.tick(makeCtx({ stateOutput: watchingState() }))
    expect(getPRReviews).toHaveBeenCalledTimes(1)
    // Advance the clock by less than pollIntervalSeconds*1000 (30s) — should skip.
    nowValue = 1_000_000 + 10_000
    await runner.tick(makeCtx({ stateOutput: watchingState() }))
    expect(getPRReviews).toHaveBeenCalledTimes(1)
  })
})

// A watching-phase state.output that is already dirty (changes requested) with a
// pending watermark, so the four-part idle gate is exercised on the first tick.
function dirtyWatchingState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return watchingState({
    dirty: true,
    pendingWatermark: '2026-06-02T00:00:00Z',
    handledCursor: '',
    ...overrides
  })
}

// Typed spawnChildRun mock so `.mock.calls[0][0]` is the structured arg, not an
// inferred empty-args tuple.
function makeSpawnChildRun(): ReturnType<typeof vi.fn<WatchPrDeps['spawnChildRun']>> {
  return vi.fn<WatchPrDeps['spawnChildRun']>(() => 'child-1')
}

// Reviews feed seeded so buildCycleOutput finds one CHANGES_REQUESTED review at
// the watermark.
function changesRequestedDeps(): Partial<WatchPrDeps> {
  return {
    getPRReviews: async () => [
      review({ state: 'CHANGES_REQUESTED', submittedAt: '2026-06-02T00:00:00Z', body: 'fix it' })
    ]
  }
}

describe('WatchPrRunner — idle gate + cycle spawn', () => {
  it('agent working → no spawn, parks waiting for agent to finish', async () => {
    const spawnChildRun = makeSpawnChildRun()
    const runner = new WatchPrRunner(
      makeDeps({
        ...changesRequestedDeps(),
        getAgentLiveStatus: (): AgentLiveStatus => 'working',
        spawnChildRun
      })
    )
    const result = await runner.tick(makeCtx({ stateOutput: dirtyWatchingState() }))
    expect(spawnChildRun).not.toHaveBeenCalled()
    expect(result.status).toBe('waiting')
    expect(result.statusMessage).toContain('waiting for agent to finish')
    const output = result.output as Record<string, unknown>
    expect(output.phase).toBe('watching')
  })

  it('idle but within debounce → no spawn yet (first tick sets idleSince)', async () => {
    const spawnChildRun = makeSpawnChildRun()
    const runner = new WatchPrRunner(
      makeDeps({
        ...changesRequestedDeps(),
        getAgentLiveStatus: (): AgentLiveStatus => 'idle',
        spawnChildRun
      })
    )
    const result = await runner.tick(
      makeCtx({
        configOverrides: { agentIdleDebounceSeconds: 10 },
        stateOutput: dirtyWatchingState()
      })
    )
    expect(spawnChildRun).not.toHaveBeenCalled()
    expect(result.status).toBe('waiting')
    expect(result.statusMessage).toContain('confirming')
    const output = result.output as Record<string, unknown>
    expect(output.phase).toBe('watching')
  })

  it('idle past debounce → spawns once and advances to responding', async () => {
    const spawnChildRun = makeSpawnChildRun()
    let nowValue = 1000
    const runner = new WatchPrRunner(
      makeDeps({
        ...changesRequestedDeps(),
        getAgentLiveStatus: (): AgentLiveStatus => 'idle',
        spawnChildRun,
        now: () => nowValue
      })
    )
    // Tick 1: idleSince is null → set to now (1000); 0 < debounce → no spawn yet.
    await runner.tick(
      makeCtx({
        configOverrides: { agentIdleDebounceSeconds: 5 },
        stateOutput: dirtyWatchingState()
      })
    )
    expect(spawnChildRun).not.toHaveBeenCalled()
    // Tick 2: advance now past the 5s debounce; same runner keeps idleSince in memory.
    nowValue = 1000 + 6000
    const result = await runner.tick(
      makeCtx({
        configOverrides: { agentIdleDebounceSeconds: 5 },
        stateOutput: dirtyWatchingState()
      })
    )
    expect(spawnChildRun).toHaveBeenCalledTimes(1)
    const arg = spawnChildRun.mock.calls[0][0] as {
      parentRunId: string
      parentStepId: string
      cycleIndex: number
      cycleOutput: Record<string, unknown>
    }
    expect(arg.parentRunId).toBe('run-1')
    expect(arg.parentStepId).toBe('step-1')
    expect(arg.cycleIndex).toBe(1)
    expect(arg.cycleOutput.prNumber).toBe(42)
    expect(arg.cycleOutput.reviewState).toBe('CHANGES_REQUESTED')
    expect(arg.cycleOutput.cycleIndex).toBe(1)
    expect(arg.cycleOutput.changeRequestCount).toBe(1)
    const output = result.output as Record<string, unknown>
    expect(output.phase).toBe('responding')
    expect(output.activeChildRunId).toBe('child-1')
    expect(output.dirty).toBe(false)
    expect(output.handledCursor).toBe('2026-06-02T00:00:00Z')
    expect(result.statusMessage).toContain('Responding to #42')
  })

  it('buildCycleOutput: full WATCH_PR_CYCLE_SCHEMA shape, resolved comments excluded', async () => {
    const spawnChildRun = makeSpawnChildRun()
    let nowValue = 1000
    const unresolved = comment({
      id: 1,
      body: 'unresolved feedback',
      isResolved: false,
      path: 'a.ts',
      line: 3
    })
    const resolved = comment({ id: 2, body: 'already addressed', isResolved: true })
    const runner = new WatchPrRunner(
      makeDeps({
        ...changesRequestedDeps(),
        getPRComments: vi.fn(async () => [unresolved, resolved]),
        getAgentLiveStatus: (): AgentLiveStatus => 'idle',
        spawnChildRun,
        now: () => nowValue
      })
    )
    await runner.tick(
      makeCtx({
        configOverrides: { agentIdleDebounceSeconds: 5 },
        stateOutput: dirtyWatchingState()
      })
    )
    nowValue = 1000 + 6000
    await runner.tick(
      makeCtx({
        configOverrides: { agentIdleDebounceSeconds: 5 },
        stateOutput: dirtyWatchingState()
      })
    )
    expect(spawnChildRun).toHaveBeenCalledTimes(1)
    const cycleOutput = (spawnChildRun.mock.calls[0][0] as { cycleOutput: Record<string, unknown> })
      .cycleOutput
    // All 10 WATCH_PR_CYCLE_SCHEMA keys present with the right types.
    expect(typeof cycleOutput.prNumber).toBe('number')
    expect(typeof cycleOutput.prUrl).toBe('string')
    expect(typeof cycleOutput.prTitle).toBe('string')
    expect(typeof cycleOutput.reviewState).toBe('string')
    expect(typeof cycleOutput.reviewAuthor).toBe('string')
    expect(typeof cycleOutput.reviewBody).toBe('string')
    expect(typeof cycleOutput.commentsJson).toBe('string')
    expect(typeof cycleOutput.commentsSummary).toBe('string')
    expect(typeof cycleOutput.cycleIndex).toBe('number')
    expect(typeof cycleOutput.changeRequestCount).toBe('number')
    // commentsJson holds only the unresolved comment.
    const parsed = JSON.parse(cycleOutput.commentsJson as string) as PRComment[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0].id).toBe(1)
    expect(parsed[0].body).toBe('unresolved feedback')
    expect(cycleOutput.prUrl).toBe('https://github.com/owner/repo/pull/42')
    expect(cycleOutput.prTitle).toBe('Test PR')
  })

  it('child already active → gate blocks a spawn even when idle + dirty', async () => {
    const spawnChildRun = makeSpawnChildRun()
    let nowValue = 1000
    const runner = new WatchPrRunner(
      makeDeps({
        ...changesRequestedDeps(),
        getAgentLiveStatus: (): AgentLiveStatus => 'idle',
        spawnChildRun,
        now: () => nowValue
      })
    )
    // Phase stays 'watching' (not 'responding') with an active child to verify the
    // gate's `activeChildRunId == null` guard, independent of the responding phase.
    await runner.tick(
      makeCtx({
        configOverrides: { agentIdleDebounceSeconds: 5 },
        stateOutput: dirtyWatchingState({ activeChildRunId: 'child-x' })
      })
    )
    nowValue = 1000 + 6000
    const result = await runner.tick(
      makeCtx({
        configOverrides: { agentIdleDebounceSeconds: 5 },
        stateOutput: dirtyWatchingState({ activeChildRunId: 'child-x' })
      })
    )
    expect(spawnChildRun).not.toHaveBeenCalled()
    expect(result.status).toBe('waiting')
  })
})

// A persisted state.output that lands the runner directly in the responding
// phase with an in-flight child cycle. lastPollAt is implicitly 0 in-memory.
function respondingState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: 'responding',
    prNumber: 42,
    repoPath: '/tmp/repo',
    paneKey: 'tab1:2',
    handledCursor: '',
    pendingWatermark: '',
    dirty: false,
    activeChildRunId: 'child-1',
    cycleIndex: 1,
    ...overrides
  }
}

describe('WatchPrRunner — responding phase', () => {
  it('child active → stays responding', async () => {
    const runner = new WatchPrRunner(
      makeDeps({
        getChildRunStatus: () => 'active',
        getPRState: async () => ({ state: 'OPEN' }) as unknown as PRWatchState
      })
    )
    const result = await runner.tick(makeCtx({ stateOutput: respondingState() }))
    expect(result.status).toBe('waiting')
    expect(result.statusMessage).toContain('Responding to #42 (round 1)')
    const output = result.output as Record<string, unknown>
    expect(output.phase).toBe('responding')
    expect(output.activeChildRunId).toBe('child-1')
  })

  it('child completed → back to watching', async () => {
    const runner = new WatchPrRunner(
      makeDeps({
        getChildRunStatus: () => 'completed',
        getPRState: async () => ({ state: 'OPEN' }) as unknown as PRWatchState
      })
    )
    const result = await runner.tick(makeCtx({ stateOutput: respondingState() }))
    expect(result.status).toBe('waiting')
    const output = result.output as Record<string, unknown>
    expect(output.phase).toBe('watching')
    expect(output.activeChildRunId).toBe(null)
  })

  it('merged mid-cycle → cancels child + finishes merged', async () => {
    const cancel = vi.fn()
    const runner = new WatchPrRunner(
      makeDeps({
        // now() past one poll interval so the cadence-gated terminal check runs.
        now: () => 1_000_000,
        getChildRunStatus: () => 'active',
        cancelChildRunsForStep: cancel,
        getPRState: async () =>
          ({
            state: 'MERGED',
            mergedAt: '2026-06-03T00:00:00Z',
            closedAt: null,
            reviewDecision: null
          }) as PRWatchState
      })
    )
    const result = await runner.tick(makeCtx({ stateOutput: respondingState() }))
    expect(cancel).toHaveBeenCalledWith('run-1', 'step-1')
    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')
    expect(result.endChain).toBeFalsy()
    const output = result.output as Record<string, unknown>
    expect(output.finalState).toBe('merged')
  })

  it('child failed + failedCycleHaltsLoop true → run fails', async () => {
    const runner = new WatchPrRunner(
      makeDeps({
        getChildRunStatus: () => 'failed',
        getPRState: async () => ({ state: 'OPEN' }) as unknown as PRWatchState
      })
    )
    const result = await runner.tick(
      makeCtx({
        configOverrides: { failedCycleHaltsLoop: true },
        stateOutput: respondingState()
      })
    )
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
  })

  it('child failed + default (failedCycleHaltsLoop false) → loops back to watching', async () => {
    const runner = new WatchPrRunner(
      makeDeps({
        getChildRunStatus: () => 'failed',
        getPRState: async () => ({ state: 'OPEN' }) as unknown as PRWatchState
      })
    )
    const result = await runner.tick(makeCtx({ stateOutput: respondingState() }))
    expect(result.outcome).not.toBe('failed')
    const output = result.output as Record<string, unknown>
    expect(output.phase).toBe('watching')
  })

  it('COALESCE: full loop on one instance spawns twice (cycle 1 then coalesced cycle 2)', async () => {
    // ONE runner instance keeps the in-memory tracker across every tick. This
    // drives the whole machine: watching → spawn cycle 1 → responding (new
    // feedback arrives mid-cycle → coalesces dirty) → child completes → watching
    // → spawn cycle 2. The seeded child id changes per cycle so coalescing is real.
    const spawnChildRun = vi.fn<WatchPrDeps['spawnChildRun']>((args) => `child-${args.cycleIndex}`)
    let nowValue = 1_000_000
    let childStatus: 'active' | 'completed' = 'active'
    // A new CHANGES_REQUESTED review newer than handledCursor ('') arms dirty.
    const reviews: PRReview[] = [
      review({ state: 'CHANGES_REQUESTED', submittedAt: '2026-06-02T00:00:00Z', body: 'more' })
    ]
    const runner = new WatchPrRunner(
      makeDeps({
        now: () => nowValue,
        getAgentLiveStatus: (): AgentLiveStatus => 'idle',
        getPRState: async () => ({ state: 'OPEN' }) as unknown as PRWatchState,
        getPRReviews: async () => reviews,
        getChildRunStatus: () => childStatus,
        spawnChildRun
      })
    )
    const cfg = {
      events: { changesRequested: true, newReviewComments: false, anyReview: false },
      agentIdleDebounceSeconds: 5
    }
    const tick = (): Promise<unknown> =>
      runner.tick(makeCtx({ configOverrides: cfg, stateOutput: watchingState() }))

    // Tick 1: watching, polls + arms dirty, agent idle → sets idleSince (debounce).
    await tick()
    expect(spawnChildRun).not.toHaveBeenCalled()
    // Tick 2: past debounce → fires cycle 1, advances to responding.
    nowValue += 6_000
    const t2 = (await tick()) as { output: Record<string, unknown> }
    expect(spawnChildRun).toHaveBeenCalledTimes(1)
    expect(spawnChildRun.mock.calls[0][0].cycleIndex).toBe(1)
    expect(t2.output.phase).toBe('responding')
    expect(t2.output.activeChildRunId).toBe('child-1')

    // A FRESH review arrives mid-cycle, newer than the just-consumed cursor.
    reviews.push(
      review({ state: 'CHANGES_REQUESTED', submittedAt: '2026-06-04T00:00:00Z', body: 'again' })
    )
    // Tick 3: responding, child-1 still active; cadence-gated arming coalesces dirty.
    nowValue += 40_000 // past poll interval so responding re-polls reviews
    const t3 = (await tick()) as { output: Record<string, unknown> }
    expect(t3.output.phase).toBe('responding')
    expect(t3.output.dirty).toBe(true)

    // Tick 4: child-1 completes → loop back to watching.
    childStatus = 'completed'
    const t4 = (await tick()) as { output: Record<string, unknown> }
    expect(t4.output.phase).toBe('watching')

    // Tick 5 + 6: watching, dirty + idle past debounce → fires the COALESCED cycle 2.
    nowValue += 40_000 // first watching tick sets idleSince
    await tick()
    expect(spawnChildRun).toHaveBeenCalledTimes(1) // still just cycle 1 — debounce not met
    nowValue += 6_000
    await tick()
    expect(spawnChildRun).toHaveBeenCalledTimes(2)
    expect(spawnChildRun.mock.calls[1][0].cycleIndex).toBe(2)
  })
})

describe('WatchPrRunner — dropRun / dropStep cancel active child runs', () => {
  it('dropRun cancels children for every tracked step then clears the tracker', async () => {
    const cancel = vi.fn()
    const runner = new WatchPrRunner(makeDeps({ cancelChildRunsForStep: cancel }))
    // One tick lands in watching → creates an in-memory tracker for (run-1, step-1).
    await runner.tick(makeCtx({ stateOutput: watchingState() }))
    runner.dropRun('run-1')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledWith('run-1', 'step-1')
    // Tracker cleared: a second dropRun finds no map → no further cancel.
    runner.dropRun('run-1')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('dropStep cancels the step’s children then removes that step’s tracker', async () => {
    const cancel = vi.fn()
    const runner = new WatchPrRunner(makeDeps({ cancelChildRunsForStep: cancel }))
    await runner.tick(makeCtx({ stateOutput: watchingState() }))
    runner.dropStep('run-1', 'step-1')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledWith('run-1', 'step-1')
    // Tracker for that step removed: dropRun (which only cancels for *tracked*
    // steps) now finds an empty/absent run map and does not cancel again.
    runner.dropRun('run-1')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('dropRun with no tracker for the run is a no-op (no cancel, no throw)', () => {
    const cancel = vi.fn()
    const runner = new WatchPrRunner(makeDeps({ cancelChildRunsForStep: cancel }))
    expect(() => runner.dropRun('run-1')).not.toThrow()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('dropStep prunes the run map when the last step is removed', async () => {
    const cancel = vi.fn()
    const runner = new WatchPrRunner(makeDeps({ cancelChildRunsForStep: cancel }))
    await runner.tick(makeCtx({ stateOutput: watchingState() }))
    runner.dropStep('run-1', 'step-1')
    // The run map was pruned (last step removed), so dropRun finds no tracker
    // and does not cancel again.
    runner.dropRun('run-1')
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})

describe('WatchPrRunner — poll cost (Part A)', () => {
  it('two watching ticks within one poll interval → getPRState called at most once', async () => {
    let nowValue = 1_000_000
    const getPRState = vi.fn(async () => ({ state: 'OPEN' }) as unknown as PRWatchState)
    const runner = new WatchPrRunner(
      makeDeps({
        getPRState,
        getPRReviews: async () => [],
        now: () => nowValue
      })
    )
    // Tick 1 polls (lastPollAt seeds to 0).
    await runner.tick(makeCtx({ stateOutput: watchingState() }))
    expect(getPRState).toHaveBeenCalledTimes(1)
    // Tick 2 within the 30s poll interval → cadence gate skips the state read.
    nowValue = 1_000_000 + 10_000
    await runner.tick(makeCtx({ stateOutput: watchingState() }))
    expect(getPRState).toHaveBeenCalledTimes(1)
  })
})
