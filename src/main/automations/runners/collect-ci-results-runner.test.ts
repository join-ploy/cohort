import { describe, it, expect, vi } from 'vitest'
import { CollectCiResultsRunner, type CollectCiResultsDeps } from './collect-ci-results-runner'
import type { StepRunnerCtx } from '../step-runner'
import type { CollectCiResultsConfig, Step } from '../../../shared/automations-types'
import type { PRCheckDetail, PRComment, WorkspaceGroup } from '../../../shared/types'

function makeDeps(overrides: Partial<CollectCiResultsDeps> = {}): CollectCiResultsDeps {
  return {
    getWorktreeMeta: () => ({ linkedPR: 42, path: '/tmp/wt', repoPath: '/tmp/repo' }),
    getWorkspaceGroups: () => [],
    hasChangesFromMain: async () => true,
    getPRChecks: async () => [],
    getPRComments: async () => [],
    getRepoPath: () => '/tmp/repo',
    getConnectionId: () => null,
    resolveLinkedPR: async () => null,
    now: () => 1000,
    ...overrides
  }
}

function makeCtx(
  configOverrides: Partial<CollectCiResultsConfig> = {},
  stepId = 'step-1'
): StepRunnerCtx {
  const config: CollectCiResultsConfig = {
    worktreeRef: 'repo-a::/tmp/wt',
    pollIntervalSeconds: 30,
    includeComments: true,
    ...configOverrides
  }
  const step: Step = {
    id: stepId,
    kind: 'collect-ci-results',
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
      output: null,
      error: null
    },
    context: {}
  }
}

function makeGroup(overrides: Partial<WorkspaceGroup> = {}): WorkspaceGroup {
  return {
    id: 'group:g1',
    workspaceName: 'feat-x',
    displayName: 'feat-x',
    parentPath: '/ws/feat-x',
    memberWorktreeIds: ['repo-a::/ws/feat-x/repo-a', 'repo-b::/ws/feat-x/repo-b'],
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
    linkedLinearIssue: null,
    ...overrides
  }
}

const completedCheck = (
  name: string,
  conclusion: PRCheckDetail['conclusion'] = 'success'
): PRCheckDetail => ({
  name,
  status: 'completed',
  conclusion,
  url: null
})

const pendingCheck = (name: string): PRCheckDetail => ({
  name,
  status: 'in_progress',
  conclusion: null,
  url: null
})

describe('CollectCiResultsRunner', () => {
  it('succeeds with empty results when no worktrees have changes', async () => {
    const deps = makeDeps({ hasChangesFromMain: async () => false })
    const runner = new CollectCiResultsRunner(deps)
    const result = await runner.tick(makeCtx())

    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')
    expect(result.output).toMatchObject({ prCount: 0, hasFailures: false })
  })

  it('waits for PR linkage when linkedPR is null', async () => {
    let linkedPR: number | null = null
    let time = 50_000
    const deps = makeDeps({
      getWorktreeMeta: () => ({ linkedPR, path: '/tmp/wt', repoPath: '/tmp/repo' }),
      now: () => time
    })
    const runner = new CollectCiResultsRunner(deps)
    const ctx = makeCtx()

    // Phase 1 resolves targets, falls through to phase 2 which finds no PR
    const r1 = await runner.tick(ctx)
    expect(r1.outcome).toBe('needs-more-time')

    // Still no PR
    const r2 = await runner.tick(ctx)
    expect(r2.outcome).toBe('needs-more-time')

    // Link the PR — advances past poll interval so phase 3 can poll
    linkedPR = 99
    time = 100_000
    const r3 = await runner.tick(ctx)
    expect(r3.outcome).toBe('done')
  })

  it('waits for CI checks to complete', async () => {
    let time = 1000
    let checks: PRCheckDetail[] = [pendingCheck('build'), pendingCheck('lint')]

    const deps = makeDeps({
      now: () => time,
      getPRChecks: async () => checks
    })
    const runner = new CollectCiResultsRunner(deps)
    const ctx = makeCtx()

    // Phase 1 (resolving-targets) + Phase 2 (waiting-for-prs) + Phase 3 first poll (in_progress)
    const r1 = await runner.tick(ctx)
    expect(r1.outcome).toBe('needs-more-time')

    // Advance time past poll interval
    time += 31_000
    checks = [completedCheck('build'), completedCheck('lint')]

    // Phase 3 re-poll (all completed) → Phase 4 (collecting) → done
    const r2 = await runner.tick(ctx)
    expect(r2.outcome).toBe('done')
    expect(r2.status).toBe('succeeded')
  })

  it('collects checks and comments on completion', async () => {
    const checks: PRCheckDetail[] = [
      completedCheck('build', 'success'),
      completedCheck('lint', 'failure'),
      completedCheck('deploy', 'cancelled')
    ]
    const comments: PRComment[] = [
      {
        id: 1,
        author: 'reviewer',
        authorAvatarUrl: '',
        body: 'Looks good but fix the lint',
        createdAt: '2026-01-01',
        url: 'https://github.com/pr/1#comment-1',
        path: 'src/index.ts',
        line: 10
      }
    ]

    const deps = makeDeps({
      getPRChecks: async () => checks,
      getPRComments: async () => comments,
      now: () => 50_000
    })
    const runner = new CollectCiResultsRunner(deps)
    const ctx = makeCtx()

    const result = await runner.tick(ctx)
    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')

    const output = result.output as Record<string, unknown>
    expect(output.hasFailures).toBe(true)
    expect(output.failedChecks).toBe('lint, deploy')
    expect(output.prCount).toBe(1)

    const parsedChecks = JSON.parse(output.checksJson as string)
    expect(parsedChecks).toHaveLength(1)
    expect(parsedChecks[0].prNumber).toBe(42)
    expect(parsedChecks[0].checks).toHaveLength(3)

    const parsedComments = JSON.parse(output.commentsJson as string)
    expect(parsedComments).toHaveLength(1)
    expect(parsedComments[0].comments).toHaveLength(1)

    expect(output.summary).toContain('#42')
    expect(output.summary).toContain('lint')

    expect(result.contextPatch).toBeDefined()
    expect((result.contextPatch as Record<string, unknown>).steps).toBeDefined()
  })

  it('respects poll interval', async () => {
    let time = 1000
    const getPRChecks = vi.fn(async () => [pendingCheck('build')])

    const deps = makeDeps({
      now: () => time,
      getPRChecks
    })
    const runner = new CollectCiResultsRunner(deps)
    const ctx = makeCtx({ pollIntervalSeconds: 30 })

    // First tick: resolves targets → waiting-for-prs → waiting-for-ci (first poll)
    await runner.tick(ctx)
    const callsAfterFirstTick = getPRChecks.mock.calls.length

    // Tick again within poll interval — should NOT call getPRChecks again
    time += 5_000
    const r2 = await runner.tick(ctx)
    expect(r2.outcome).toBe('needs-more-time')
    expect(getPRChecks).toHaveBeenCalledTimes(callsAfterFirstTick)

    // Advance past poll interval — should call getPRChecks
    time += 30_000
    await runner.tick(ctx)
    expect(getPRChecks.mock.calls.length).toBeGreaterThan(callsAfterFirstTick)
  })

  it('respects step timeout', async () => {
    let time = 0
    const deps = makeDeps({
      now: () => time,
      getPRChecks: async () => [pendingCheck('build')]
    })
    const runner = new CollectCiResultsRunner(deps)
    const step: Step = {
      id: 'step-1',
      kind: 'collect-ci-results',
      config: { worktreeRef: 'repo-a::/tmp/wt', pollIntervalSeconds: 30, includeComments: true },
      onFailure: 'halt',
      timeoutSeconds: 60
    }
    const ctx: StepRunnerCtx = {
      runId: 'run-1',
      step,
      state: {
        stepId: 'step-1',
        status: 'pending',
        startedAt: null,
        finishedAt: null,
        output: null,
        error: null
      },
      context: {}
    }

    // First tick creates the tracker with startedAt = 0
    const r1 = await runner.tick(ctx)
    expect(r1.outcome).toBe('needs-more-time')

    // Advance past timeout
    time = 61_000
    const r2 = await runner.tick(ctx)
    expect(r2.outcome).toBe('failed')
    expect(r2.status).toBe('timed-out')
    expect(r2.error).toMatch(/60s/)
  })

  it('handles group refs', async () => {
    const group = makeGroup()
    const metas: Record<string, { linkedPR: number | null; path: string; repoPath: string }> = {
      'repo-a::/ws/feat-x/repo-a': { linkedPR: 10, path: '/ws/feat-x/repo-a', repoPath: '/repo-a' },
      'repo-b::/ws/feat-x/repo-b': { linkedPR: 20, path: '/ws/feat-x/repo-b', repoPath: '/repo-b' }
    }

    const deps = makeDeps({
      getWorkspaceGroups: () => [group],
      getWorktreeMeta: (id) => metas[id],
      getRepoPath: () => '/tmp/repo',
      getPRChecks: async () => [completedCheck('build')],
      now: () => 50_000
    })
    const runner = new CollectCiResultsRunner(deps)
    const ctx = makeCtx({ worktreeRef: 'group:g1' })

    const result = await runner.tick(ctx)
    expect(result.outcome).toBe('done')

    const output = result.output as Record<string, unknown>
    expect(output.prCount).toBe(2)

    const parsedChecks = JSON.parse(output.checksJson as string)
    expect(parsedChecks).toHaveLength(2)
    const prNumbers = parsedChecks.map((e: { prNumber: number }) => e.prNumber)
    expect(prNumbers).toContain(10)
    expect(prNumbers).toContain(20)
  })

  it('skips comments when includeComments is false', async () => {
    const getPRComments = vi.fn(async () => [])

    const deps = makeDeps({
      getPRChecks: async () => [completedCheck('build')],
      getPRComments,
      now: () => 50_000
    })
    const runner = new CollectCiResultsRunner(deps)
    const ctx = makeCtx({ includeComments: false })

    const result = await runner.tick(ctx)
    expect(result.outcome).toBe('done')

    expect(getPRComments).not.toHaveBeenCalled()

    const output = result.output as Record<string, unknown>
    expect(output.commentsJson).toBe('[]')
  })

  it('dropRun cleans up tracker so next tick starts fresh', async () => {
    let time = 1000
    const deps = makeDeps({
      now: () => time,
      getPRChecks: async () => [pendingCheck('build')]
    })
    const runner = new CollectCiResultsRunner(deps)
    const ctx = makeCtx()

    // Create tracker
    const r1 = await runner.tick(ctx)
    expect(r1.outcome).toBe('needs-more-time')

    // Drop it
    runner.dropRun('run-1')

    // Next tick should not crash and should create a fresh tracker
    time = 2000
    const r2 = await runner.tick(ctx)
    expect(r2.outcome).toBe('needs-more-time')
  })

  it('resolves PR via fallback when meta.linkedPR is null', async () => {
    const deps = makeDeps({
      getWorktreeMeta: () => ({ linkedPR: null, path: '/tmp/wt', repoPath: '/tmp/repo' }),
      resolveLinkedPR: async () => 77,
      getPRChecks: async () => [completedCheck('build')],
      now: () => 50_000
    })
    const runner = new CollectCiResultsRunner(deps)
    const ctx = makeCtx()

    const result = await runner.tick(ctx)
    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')

    const output = result.output as Record<string, unknown>
    expect(output.prCount).toBe(1)
    const parsedChecks = JSON.parse(output.checksJson as string)
    expect(parsedChecks[0].prNumber).toBe(77)
  })

  it('fails fast on template resolution error', async () => {
    const deps = makeDeps()
    const runner = new CollectCiResultsRunner(deps)
    const ctx = makeCtx({ worktreeRef: '{{steps.missing.id}}' })

    const result = await runner.tick(ctx)
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/missing/)
  })
})
