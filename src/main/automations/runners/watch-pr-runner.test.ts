import { describe, it, expect, vi } from 'vitest'
import { WatchPrRunner, type WatchPrDeps, type AgentLiveStatus } from './watch-pr-runner'
import type { StepRunnerCtx } from '../step-runner'
import type { WatchPrConfig, Step } from '../../../shared/automations-types'
import type { PRWatchState, PRReview } from '../../github/client'
import type { PRComment, WorkspaceGroup } from '../../../shared/types'

function makeDeps(overrides: Partial<WatchPrDeps> = {}): WatchPrDeps {
  return {
    getWorktreeMeta: () => ({ linkedPR: 42, path: '/tmp/wt', repoPath: '/tmp/repo' }),
    getRepoPath: () => '/tmp/repo',
    resolveLinkedPR: async () => null,
    getWorkspaceGroups: vi.fn(() => []),
    hasChangesFromMain: vi.fn(async () => true),
    getConnectionId: vi.fn(() => null),
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
    expect(result.statusMessage).toBe('Waiting for PRs to be linked')
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
    const members = output.members as Record<string, unknown>[]
    expect(output.phase).toBe('watching')
    expect(members[0].prNumber).toBe(42)
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
    const members = output.members as Record<string, unknown>[]
    expect(output.phase).toBe('watching')
    expect(members[0].prNumber).toBe(7)
  })

  it('rehydrates from persisted state.output without resetting', async () => {
    const runner = new WatchPrRunner(makeDeps())
    const result = await runner.tick(
      makeCtx({
        stateOutput: {
          phase: 'watching',
          members: [
            {
              worktreeId: 'repo-a::/tmp/wt',
              prNumber: 99,
              repoPath: '/repo',
              prUrl: '',
              handledCursor: '2026-06-01T00:00:00Z',
              pendingWatermark: '',
              dirty: false,
              settled: 'open'
            }
          ],
          paneKey: 'tab1:2',
          activeChildRunId: null,
          cycleIndex: 3
        }
      })
    )
    const output = result.output as Record<string, unknown>
    const members = output.members as Record<string, unknown>[]
    expect(output.cycleIndex).toBe(3)
    expect(members[0].prNumber).toBe(99)
    expect(output.phase).toBe('watching')
  })

  it('unknown worktree (meta gone) is skipped → clean done with no members', async () => {
    // A gone member is skipped (mirrors collect-ci); a single-worktree ref with
    // no eligible members resolves to the empty-group clean done, not a failure.
    const runner = new WatchPrRunner(makeDeps({ getWorktreeMeta: () => undefined }))
    const result = await runner.tick(makeCtx({}))
    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')
    expect(result.endChain).toBeFalsy()
    const output = result.output as Record<string, unknown>
    expect(output.memberCount).toBe(0)
    expect(output.finalState).toBe('all-merged')
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
// on its first tick (skips resolving). memberOverrides re-paths the old scalar
// per-PR fields (dirty/handledCursor/pendingWatermark) onto the single member;
// top-level overrides cover phase/activeChildRunId/cycleIndex.
function watchingState(
  overrides: Record<string, unknown> = {},
  memberOverrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    phase: 'watching',
    members: [
      {
        worktreeId: 'repo-a::/tmp/wt',
        prNumber: 42,
        repoPath: '/tmp/repo',
        prUrl: '',
        handledCursor: '',
        pendingWatermark: '',
        dirty: false,
        settled: 'open',
        ...memberOverrides
      }
    ],
    paneKey: 'tab1:2',
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
  it('merged → done/succeeded, endChain falsy, finalState "all-merged"', async () => {
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
            reviewDecision: null,
            title: 'Test PR',
            url: 'https://github.com/owner/repo/pull/42'
          }) as PRWatchState
      })
    )
    const result = await runner.tick(makeCtx({ stateOutput: watchingState() }))
    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')
    // Single member merging → all settled, all merged → all-merged → continue.
    expect(result.endChain).toBeFalsy()
    const output = result.output as Record<string, unknown>
    expect(output.finalState).toBe('all-merged')
    expect(output.mergedCount).toBe(1)
    // Merge before any response cycle ran: the sweep caches state.url onto the
    // member so finishAggregate emits the PR url even though buildCycleOutput
    // (the usual cache point) never ran.
    expect(output.prUrl).toBe('https://github.com/owner/repo/pull/42')
    const patch = result.contextPatch as { steps: Record<string, Record<string, unknown>> }
    expect(patch.steps['step-1'].finalState).toBe('all-merged')
    expect(patch.steps['step-1'].prUrl).toBe('https://github.com/owner/repo/pull/42')
  })

  it('closed → done/succeeded + endChain true, finalState "partial-closed"', async () => {
    const runner = new WatchPrRunner(
      makeDeps({
        // now() past one poll interval so the cadence-gated terminal check runs.
        now: () => 1_000_000,
        getPRState: async () =>
          ({
            state: 'CLOSED',
            mergedAt: null,
            closedAt: '2026-06-03T00:00:00Z',
            reviewDecision: null,
            title: 'Test PR',
            url: 'https://github.com/owner/repo/pull/42'
          }) as PRWatchState
      })
    )
    const result = await runner.tick(makeCtx({ stateOutput: watchingState() }))
    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')
    // Single member closed → all settled, not all merged → partial-closed → stop.
    expect(result.endChain).toBe(true)
    const output = result.output as Record<string, unknown>
    expect(output.finalState).toBe('partial-closed')
    expect(output.closedCount).toBe(1)
    const patch = result.contextPatch as { steps: Record<string, Record<string, unknown>> }
    expect(patch.steps['step-1'].finalState).toBe('partial-closed')
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
    const members = output.members as Record<string, unknown>[]
    expect(members[0].dirty).toBe(true)
    expect(members[0].pendingWatermark).toBe('2026-06-02T00:00:00Z')
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
    const members = output.members as Record<string, unknown>[]
    expect(members[0].dirty).toBe(false)
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
    const members = output.members as Record<string, unknown>[]
    expect(members[0].dirty).toBe(true)
    expect(members[0].pendingWatermark).toBe('2026-06-02T00:00:00Z')
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

// A watching-phase state.output whose single member is already dirty (changes
// requested) with a pending watermark, so the four-part idle gate is exercised on
// the first tick. `overrides` cover the top-level tracker fields (e.g.
// activeChildRunId); the member is always dirty at the watermark.
function dirtyWatchingState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return watchingState(overrides, {
    dirty: true,
    pendingWatermark: '2026-06-02T00:00:00Z',
    handledCursor: ''
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
    const members = output.members as Record<string, unknown>[]
    expect(output.phase).toBe('responding')
    expect(output.activeChildRunId).toBe('child-1')
    expect(members[0].dirty).toBe(false)
    expect(members[0].handledCursor).toBe('2026-06-02T00:00:00Z')
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
    // WATCH_PR_CYCLE_SCHEMA keys present with the right types (no top-level prTitle).
    expect(typeof cycleOutput.memberCount).toBe('number')
    expect(typeof cycleOutput.combinedSummary).toBe('string')
    expect(typeof cycleOutput.membersJson).toBe('string')
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
    // prTitle lives per-member inside membersJson, not at the top level.
    const members = JSON.parse(cycleOutput.membersJson as string) as { prTitle: string }[]
    expect(members[0].prTitle).toBe('Test PR')
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
    members: [
      {
        worktreeId: 'repo-a::/tmp/wt',
        prNumber: 42,
        repoPath: '/tmp/repo',
        prUrl: '',
        handledCursor: '',
        pendingWatermark: '',
        dirty: false,
        settled: 'open'
      }
    ],
    paneKey: 'tab1:2',
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
    expect(output.finalState).toBe('all-merged')
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
    expect((t3.output.members as Record<string, unknown>[])[0].dirty).toBe(true)

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

// ─── Group expansion ────────────────────────────────────────────────────
// A two-member group: repoA::/a (PR 101) and repoB::/b (PR 202). The shared
// pane is the same single paneRef the single-PR config uses. Per-member mocks
// are keyed by repoPath ('/a' vs '/b') so members get distinct PR data.

const GROUP_ID = 'group:g1'
const MEMBER_A = 'repoA::/a'
const MEMBER_B = 'repoB::/b'
const MEMBER_C = 'repoC::/c'

function group(memberWorktreeIds: string[]): WorkspaceGroup {
  return {
    id: GROUP_ID,
    workspaceName: 'feat-x',
    displayName: 'Feat X',
    parentPath: 'workspaces/feat-x/',
    memberWorktreeIds,
    branchName: 'feat-x',
    isArchived: false,
    archivedAt: null,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    isUnread: false,
    comment: '',
    createdAt: 0,
    linkedIssue: null,
    linkedLinearIssue: null
  }
}

// getWorktreeMeta keyed by worktreeId so each member carries its own linkedPR.
function metaFor(
  id: string
): { linkedPR: number | null; path: string; repoPath: string } | undefined {
  const byId: Record<string, { linkedPR: number | null; path: string; repoPath: string }> = {
    [MEMBER_A]: { linkedPR: 101, path: '/a/wt', repoPath: '/a' },
    [MEMBER_B]: { linkedPR: 202, path: '/b/wt', repoPath: '/b' },
    [MEMBER_C]: { linkedPR: 303, path: '/c/wt', repoPath: '/c' }
  }
  return byId[id]
}

function prState(overrides: Partial<PRWatchState>): PRWatchState {
  return {
    state: 'OPEN',
    mergedAt: null,
    closedAt: null,
    reviewDecision: null,
    title: 'PR',
    url: '',
    ...overrides
  } as PRWatchState
}

// makeDeps tuned for a group: getWorkspaceGroups returns the seeded group,
// per-member metas, every member has changes by default.
function makeGroupDeps(members: string[], overrides: Partial<WatchPrDeps> = {}): WatchPrDeps {
  return makeDeps({
    getWorkspaceGroups: vi.fn(() => [group(members)]),
    getWorktreeMeta: (id) => metaFor(id),
    getRepoPath: (repoId) => `/${repoId.replace('repo', '').toLowerCase()}`,
    hasChangesFromMain: vi.fn(async () => true),
    getConnectionId: vi.fn(() => null),
    getPRState: async (repoPath) =>
      prState({ url: `https://gh/pull${repoPath}`, title: `PR ${repoPath}` }),
    getPRReviews: async () => [],
    ...overrides
  })
}

// A group state.output landing directly in the watching phase with two open
// members (A=101, B=202). memberOverrides re-paths per-member fields onto BOTH
// members; top-level overrides cover phase/activeChildRunId/cycleIndex.
function groupWatchingState(
  overrides: Record<string, unknown> = {},
  aOverrides: Record<string, unknown> = {},
  bOverrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const base = (id: string, prNumber: number, repoPath: string): Record<string, unknown> => ({
    worktreeId: id,
    prNumber,
    repoPath,
    prUrl: '',
    handledCursor: '',
    pendingWatermark: '',
    dirty: false,
    settled: 'open'
  })
  return {
    phase: 'watching',
    members: [
      { ...base(MEMBER_A, 101, '/a'), ...aOverrides },
      { ...base(MEMBER_B, 202, '/b'), ...bOverrides }
    ],
    paneKey: 'tab1:2',
    activeChildRunId: null,
    cycleIndex: 0,
    ...overrides
  }
}

function groupCtx(opts: {
  configOverrides?: Partial<WatchPrConfig>
  stateOutput?: unknown
}): StepRunnerCtx {
  return makeCtx({
    configOverrides: { worktreeRef: GROUP_ID, paneRef: 'tab1:2', ...opts.configOverrides },
    stateOutput: opts.stateOutput
  })
}

describe('WatchPrRunner — group', () => {
  it('member-scoped ref resolves to a single member', async () => {
    // `member:<groupId>:<worktreeId>` expands to just that one worktree.
    const runner = new WatchPrRunner(makeGroupDeps([MEMBER_A, MEMBER_B]))
    const result = await runner.tick(
      groupCtx({ configOverrides: { worktreeRef: `member:${GROUP_ID}:${MEMBER_A}` } })
    )
    expect(result.outcome).toBe('needs-more-time')
    const output = result.output as Record<string, unknown>
    const members = output.members as Record<string, unknown>[]
    expect(output.phase).toBe('watching')
    expect(members).toHaveLength(1)
    expect(members[0].prNumber).toBe(101)
  })

  it('fails when a group: ref resolves to no known group', async () => {
    const runner = new WatchPrRunner(
      makeGroupDeps([MEMBER_A], { getWorkspaceGroups: vi.fn(() => []) })
    )
    const result = await runner.tick(groupCtx({}))
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
    expect(result.error).toContain('Could not resolve')
  })

  it('does NOT tear down a group when isWorktreeArchived uses real (meta-keyed) semantics', async () => {
    // Regression guard: the real dep returns true for any id without worktree
    // meta — including the group:<uuid> ref. The runner must check per MEMBER
    // worktreeId (which has meta), not the raw group ref, or it would falsely
    // archive-tear-down on the first sweep.
    const realArchived = (id: string): boolean => id !== MEMBER_A && id !== MEMBER_B
    const runner = new WatchPrRunner(
      makeGroupDeps([MEMBER_A, MEMBER_B], { isWorktreeArchived: realArchived })
    )
    const result = await runner.tick(
      groupCtx({ stateOutput: groupWatchingState(), configOverrides: { pollIntervalSeconds: 0 } })
    )
    expect(result.outcome).toBe('needs-more-time')
    const output = result.output as Record<string, unknown>
    expect(output.phase).toBe('watching')
  })

  it('tears down when an open member worktree is archived', async () => {
    const runner = new WatchPrRunner(
      makeGroupDeps([MEMBER_A, MEMBER_B], { isWorktreeArchived: (id) => id === MEMBER_A })
    )
    const result = await runner.tick(
      groupCtx({ stateOutput: groupWatchingState(), configOverrides: { pollIntervalSeconds: 0 } })
    )
    expect(result.outcome).toBe('done')
    expect(result.endChain).toBe(true)
    const output = result.output as Record<string, unknown>
    expect(output.finalState).toBe('archived')
  })

  it('expansion: 2 members with changes + PRs → 2 members; no-diff 3rd skipped', async () => {
    const runner = new WatchPrRunner(
      makeGroupDeps([MEMBER_A, MEMBER_B, MEMBER_C], {
        // MEMBER_C has no diff from main → no PR → skipped.
        hasChangesFromMain: vi.fn(async (id) => id !== MEMBER_C)
      })
    )
    const result = await runner.tick(groupCtx({}))
    expect(result.outcome).toBe('needs-more-time')
    const output = result.output as Record<string, unknown>
    const members = output.members as Record<string, unknown>[]
    expect(output.phase).toBe('watching')
    expect(members).toHaveLength(2)
    expect(members.map((m) => m.worktreeId).sort()).toEqual([MEMBER_A, MEMBER_B])
    expect(members.find((m) => m.worktreeId === MEMBER_C)).toBeUndefined()
  })

  it('waits until all member PRs are linked', async () => {
    const runner = new WatchPrRunner(
      makeGroupDeps([MEMBER_A, MEMBER_B], {
        // MEMBER_B isn't PR-linked yet and resolveLinkedPR can't find one.
        getWorktreeMeta: (id) =>
          id === MEMBER_B ? { linkedPR: null, path: '/b/wt', repoPath: '/b' } : metaFor(id),
        resolveLinkedPR: async () => null
      })
    )
    const result = await runner.tick(groupCtx({}))
    expect(result.outcome).toBe('needs-more-time')
    expect(result.status).toBe('waiting')
    expect(result.statusMessage).toBe('Waiting for PRs to be linked')
    // Phase still resolving — no members populated until the whole group is ready.
    const output = result.output as Record<string, unknown>
    expect(output.phase).toBe('resolving')
    expect((output.members as unknown[]).length).toBe(0)
  })

  it('batched arming/firing: both members armed → ONE spawn over the batch of 2', async () => {
    const spawnChildRun = makeSpawnChildRun()
    let nowValue = 1_000_000
    const reviewA = review({
      state: 'CHANGES_REQUESTED',
      submittedAt: '2026-06-02T00:00:00Z',
      body: 'fix a'
    })
    const reviewB = review({
      state: 'CHANGES_REQUESTED',
      submittedAt: '2026-06-03T00:00:00Z',
      body: 'fix b'
    })
    const runner = new WatchPrRunner(
      makeGroupDeps([MEMBER_A, MEMBER_B], {
        now: () => nowValue,
        getAgentLiveStatus: (): AgentLiveStatus => 'idle',
        getPRReviews: async (repoPath) => (repoPath === '/a' ? [reviewA] : [reviewB]),
        getPRState: async (repoPath) =>
          prState({ url: `https://gh/pull${repoPath}`, title: `PR ${repoPath}` }),
        spawnChildRun
      })
    )
    // Tick 1: poll arms both members; idle → sets idleSince (debounce not met).
    await runner.tick(groupCtx({ stateOutput: groupWatchingState() }))
    expect(spawnChildRun).not.toHaveBeenCalled()
    // Tick 2: past debounce → exactly ONE batched cycle over both members.
    nowValue += 6_000
    const result = await runner.tick(groupCtx({ stateOutput: groupWatchingState() }))
    expect(spawnChildRun).toHaveBeenCalledTimes(1)
    const cycleOutput = spawnChildRun.mock.calls[0][0].cycleOutput
    expect(cycleOutput.memberCount).toBe(2)
    // combinedSummary carries a section per member PR.
    expect(cycleOutput.combinedSummary).toContain('## PR #101')
    expect(cycleOutput.combinedSummary).toContain('## PR #202')
    const membersJson = JSON.parse(cycleOutput.membersJson as string) as unknown[]
    expect(membersJson).toHaveLength(2)
    // Both members consumed their watermark: handledCursor advanced, dirty cleared.
    const output = result.output as Record<string, unknown>
    const outMembers = output.members as Record<string, unknown>[]
    const a = outMembers.find((m) => m.worktreeId === MEMBER_A)!
    const b = outMembers.find((m) => m.worktreeId === MEMBER_B)!
    expect(a.dirty).toBe(false)
    expect(a.handledCursor).toBe('2026-06-02T00:00:00Z')
    expect(b.dirty).toBe(false)
    expect(b.handledCursor).toBe('2026-06-03T00:00:00Z')
    expect(output.phase).toBe('responding')
  })

  it('per-member settle: A merges while B open → keep watching; then B merges → all-merged', async () => {
    let aState: 'OPEN' | 'MERGED' = 'MERGED'
    const bStateRef = { value: 'OPEN' as 'OPEN' | 'MERGED' }
    let nowValue = 1_000_000
    const runner = new WatchPrRunner(
      makeGroupDeps([MEMBER_A, MEMBER_B], {
        now: () => nowValue,
        getPRState: async (repoPath) => {
          if (repoPath === '/a') {
            return prState({ state: aState, url: 'https://gh/pull/a' })
          }
          return prState({ state: bStateRef.value, url: 'https://gh/pull/b' })
        }
      })
    )
    // Tick 1: A MERGED, B still open → not all settled → keep watching.
    const t1 = await runner.tick(groupCtx({ stateOutput: groupWatchingState() }))
    expect(t1.outcome).toBe('needs-more-time')
    const out1 = t1.output as Record<string, unknown>
    expect(out1.phase).toBe('watching')
    const m1 = out1.members as Record<string, unknown>[]
    expect(m1.find((m) => m.worktreeId === MEMBER_A)!.settled).toBe('merged')
    expect(m1.find((m) => m.worktreeId === MEMBER_B)!.settled).toBe('open')
    // Tick 2: B now MERGED → every member settled → finishAggregate all-merged.
    bStateRef.value = 'MERGED'
    aState = 'MERGED'
    nowValue += 40_000 // past poll interval so the terminal sweep re-runs
    const t2 = await runner.tick(groupCtx({ stateOutput: groupWatchingState() }))
    // Seed the prior settle (A merged) so this tick only needs B to settle.
    expect(t2.outcome).toBe('done')
    const out2 = t2.output as Record<string, unknown>
    expect(out2.finalState).toBe('all-merged')
    expect(t2.endChain).toBeFalsy()
  })

  it('aggregate any-closed: A merged + B closed → partial-closed, endChain true', async () => {
    const runner = new WatchPrRunner(
      makeGroupDeps([MEMBER_A, MEMBER_B], {
        now: () => 1_000_000,
        getPRState: async (repoPath) =>
          repoPath === '/a'
            ? prState({ state: 'MERGED', url: 'https://gh/pull/a' })
            : prState({ state: 'CLOSED', url: 'https://gh/pull/b' })
      })
    )
    const result = await runner.tick(groupCtx({ stateOutput: groupWatchingState() }))
    expect(result.outcome).toBe('done')
    const output = result.output as Record<string, unknown>
    expect(output.finalState).toBe('partial-closed')
    expect(output.mergedCount).toBe(1)
    expect(output.closedCount).toBe(1)
    expect(result.endChain).toBe(true)
  })

  it('settle-mid-cycle (last member): A pre-settled, B merges → cancel child + finish', async () => {
    const cancel = vi.fn()
    const runner = new WatchPrRunner(
      makeGroupDeps([MEMBER_A, MEMBER_B], {
        now: () => 1_000_000,
        getChildRunStatus: () => 'active',
        cancelChildRunsForStep: cancel,
        getPRState: async (repoPath) =>
          repoPath === '/b' ? prState({ state: 'MERGED', url: 'https://gh/pull/b' }) : prState({})
      })
    )
    // Responding with an active child; A already settled (merged), B about to merge.
    const result = await runner.tick(
      groupCtx({
        stateOutput: {
          phase: 'responding',
          members: [
            {
              worktreeId: MEMBER_A,
              prNumber: 101,
              repoPath: '/a',
              prUrl: 'https://gh/pull/a',
              handledCursor: '',
              pendingWatermark: '',
              dirty: false,
              settled: 'merged'
            },
            {
              worktreeId: MEMBER_B,
              prNumber: 202,
              repoPath: '/b',
              prUrl: '',
              handledCursor: '',
              pendingWatermark: '',
              dirty: false,
              settled: 'open'
            }
          ],
          paneKey: 'tab1:2',
          activeChildRunId: 'child-1',
          cycleIndex: 1
        }
      })
    )
    expect(cancel).toHaveBeenCalledWith('run-1', 'step-1')
    expect(result.outcome).toBe('done')
    const output = result.output as Record<string, unknown>
    expect(output.finalState).toBe('all-merged')
  })

  it('cross-member coalesce: child active with batch [A]; B arms mid-cycle → next gate fires batch [B]', async () => {
    const spawnChildRun = vi.fn<WatchPrDeps['spawnChildRun']>((args) => `child-${args.cycleIndex}`)
    let nowValue = 1_000_000
    let childStatus: 'active' | 'completed' = 'active'
    // A's review armed cycle 1 (already consumed). B's review arrives later.
    const reviewsByRepo: Record<string, PRReview[]> = {
      '/a': [
        review({ state: 'CHANGES_REQUESTED', submittedAt: '2026-06-02T00:00:00Z', body: 'a' })
      ],
      '/b': []
    }
    const runner = new WatchPrRunner(
      makeGroupDeps([MEMBER_A, MEMBER_B], {
        now: () => nowValue,
        getAgentLiveStatus: (): AgentLiveStatus => 'idle',
        getPRReviews: async (repoPath) => reviewsByRepo[repoPath] ?? [],
        getPRState: async (repoPath) =>
          prState({ url: `https://gh/pull${repoPath}`, title: `PR ${repoPath}` }),
        getChildRunStatus: () => childStatus,
        spawnChildRun
      })
    )
    const tick = (state: unknown): Promise<unknown> => runner.tick(groupCtx({ stateOutput: state }))

    // Tick 1: A dirty (handledCursor ''), B clean; idle → sets idleSince.
    await tick(groupWatchingState({}, { dirty: false }, { dirty: false }))
    expect(spawnChildRun).not.toHaveBeenCalled()
    // Tick 2: past debounce → fires cycle 1 over batch [A] only (B not dirty).
    nowValue += 6_000
    const t2 = (await tick(groupWatchingState({}, { dirty: false }, { dirty: false }))) as {
      output: Record<string, unknown>
    }
    expect(spawnChildRun).toHaveBeenCalledTimes(1)
    expect(spawnChildRun.mock.calls[0][0].cycleOutput.memberCount).toBe(1)
    const batch1 = JSON.parse(spawnChildRun.mock.calls[0][0].cycleOutput.membersJson as string) as {
      prNumber: number
    }[]
    expect(batch1[0].prNumber).toBe(101)
    expect(t2.output.phase).toBe('responding')

    // B's review arrives mid-cycle.
    reviewsByRepo['/b'] = [
      review({ state: 'CHANGES_REQUESTED', submittedAt: '2026-06-04T00:00:00Z', body: 'b' })
    ]
    // Tick 3: responding, child active, re-poll arms B dirty (coalesced).
    nowValue += 40_000
    const t3 = (await tick(groupWatchingState({}, { dirty: false }, { dirty: false }))) as {
      output: Record<string, unknown>
    }
    expect(t3.output.phase).toBe('responding')
    expect(
      (t3.output.members as Record<string, unknown>[]).find((m) => m.worktreeId === MEMBER_B)!.dirty
    ).toBe(true)

    // Tick 4: child completes → back to watching.
    childStatus = 'completed'
    await tick(groupWatchingState({}, { dirty: false }, { dirty: false }))

    // Tick 5 + 6: watching, B dirty + idle past debounce → fires cycle 2 over [B].
    nowValue += 40_000
    await tick(groupWatchingState({}, { dirty: false }, { dirty: false }))
    nowValue += 6_000
    await tick(groupWatchingState({}, { dirty: false }, { dirty: false }))
    expect(spawnChildRun).toHaveBeenCalledTimes(2)
    expect(spawnChildRun.mock.calls[1][0].cycleIndex).toBe(2)
    expect(spawnChildRun.mock.calls[1][0].cycleOutput.memberCount).toBe(1)
    const batch2 = JSON.parse(spawnChildRun.mock.calls[1][0].cycleOutput.membersJson as string) as {
      prNumber: number
    }[]
    expect(batch2[0].prNumber).toBe(202)
  })

  it('empty group: no member has changes → clean done, memberCount 0, endChain falsy', async () => {
    const runner = new WatchPrRunner(
      makeGroupDeps([MEMBER_A, MEMBER_B], {
        hasChangesFromMain: vi.fn(async () => false)
      })
    )
    const result = await runner.tick(groupCtx({}))
    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')
    expect(result.endChain).toBeFalsy()
    const output = result.output as Record<string, unknown>
    expect(output.memberCount).toBe(0)
    expect(output.finalState).toBe('all-merged')
    expect(output.membersJson).toBe('[]')
  })

  it('restart: a settled member is not re-polled/armed; the open member is still swept', async () => {
    const getPRState = vi.fn<WatchPrDeps['getPRState']>(async (repoPath) =>
      prState({ state: 'OPEN', url: `https://gh/pull${repoPath}` })
    )
    const getPRReviews = vi.fn<WatchPrDeps['getPRReviews']>(async () => [] as PRReview[])
    const runner = new WatchPrRunner(
      makeGroupDeps([MEMBER_A, MEMBER_B], {
        now: () => 1_000_000,
        getPRState,
        getPRReviews
      })
    )
    // A already merged (settled), B open — rehydrated from persisted output.
    await runner.tick(
      groupCtx({
        stateOutput: groupWatchingState({}, { settled: 'merged', prUrl: 'https://gh/pull/a' }, {})
      })
    )
    // The settled member (A=/a) is never re-read; only the open member (B=/b) is swept.
    const stateRepos = getPRState.mock.calls.map((c) => c[0])
    expect(stateRepos).not.toContain('/a')
    expect(stateRepos).toContain('/b')
    const reviewRepos = getPRReviews.mock.calls.map((c) => c[0])
    expect(reviewRepos).not.toContain('/a')
  })
})

describe('WatchPrRunner — end on approve', () => {
  it('single approved PR + endOnApprove → continues (approved, endChain false)', async () => {
    const runner = new WatchPrRunner(
      makeDeps({ getPRState: async () => prState({ reviewDecision: 'APPROVED', url: 'u' }) })
    )
    const result = await runner.tick(
      makeCtx({
        stateOutput: watchingState(),
        configOverrides: { endOnApprove: true, pollIntervalSeconds: 0 }
      })
    )
    expect(result.outcome).toBe('done')
    expect(result.endChain).toBeFalsy()
    const output = result.output as Record<string, unknown>
    expect(output.finalState).toBe('approved')
    expect(output.approvedCount).toBe(1)
  })

  it('approved but endOnApprove off (default) → keeps watching', async () => {
    const runner = new WatchPrRunner(
      makeDeps({ getPRState: async () => prState({ reviewDecision: 'APPROVED', url: 'u' }) })
    )
    const result = await runner.tick(
      makeCtx({ stateOutput: watchingState(), configOverrides: { pollIntervalSeconds: 0 } })
    )
    expect(result.outcome).toBe('needs-more-time')
  })

  it('group all approved + endOnApprove → continues (approved, count 2)', async () => {
    const runner = new WatchPrRunner(
      makeGroupDeps([MEMBER_A, MEMBER_B], {
        getPRState: async (repoPath) => prState({ reviewDecision: 'APPROVED', url: `u${repoPath}` })
      })
    )
    const result = await runner.tick(
      groupCtx({
        stateOutput: groupWatchingState(),
        configOverrides: { endOnApprove: true, pollIntervalSeconds: 0 }
      })
    )
    expect(result.outcome).toBe('done')
    expect(result.endChain).toBeFalsy()
    const output = result.output as Record<string, unknown>
    expect(output.finalState).toBe('approved')
    expect(output.approvedCount).toBe(2)
  })

  it('group one approved + one closed → stops (partial-closed)', async () => {
    const runner = new WatchPrRunner(
      makeGroupDeps([MEMBER_A, MEMBER_B], {
        getPRState: async (repoPath) =>
          repoPath === '/a'
            ? prState({ reviewDecision: 'APPROVED', url: 'ua' })
            : prState({ state: 'CLOSED', url: 'ub' })
      })
    )
    const result = await runner.tick(
      groupCtx({
        stateOutput: groupWatchingState(),
        configOverrides: { endOnApprove: true, pollIntervalSeconds: 0 }
      })
    )
    expect(result.outcome).toBe('done')
    expect(result.endChain).toBe(true)
    const output = result.output as Record<string, unknown>
    expect(output.finalState).toBe('partial-closed')
  })
})
