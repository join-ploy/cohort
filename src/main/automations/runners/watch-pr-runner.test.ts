import { describe, it, expect, vi } from 'vitest'
import { WatchPrRunner, type WatchPrDeps, type AgentLiveStatus } from './watch-pr-runner'
import type { StepRunnerCtx } from '../step-runner'
import type { WatchPrConfig, Step } from '../../../shared/automations-types'
import type { PRWatchState } from '../../github/client'

function makeDeps(overrides: Partial<WatchPrDeps> = {}): WatchPrDeps {
  return {
    getWorktreeMeta: () => ({ linkedPR: 42, path: '/tmp/wt', repoPath: '/tmp/repo' }),
    getRepoPath: () => '/tmp/repo',
    resolveLinkedPR: async () => null,
    isWorktreeArchived: () => false,
    getPRState: async () => ({ state: 'OPEN', reviewDecision: null }) as unknown as PRWatchState,
    getPRReviews: async () => [],
    getPRComments: async () => [],
    getAgentLiveStatus: (): AgentLiveStatus => 'idle',
    spawnChildRun: () => 'child-run-1',
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
