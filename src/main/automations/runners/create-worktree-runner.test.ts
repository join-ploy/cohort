import { describe, it, expect, vi } from 'vitest'
import type { Step, StepRunState, CreateWorktreeConfig } from '../../../shared/automations-types'
import { CreateWorktreeRunner } from './create-worktree-runner'
import type { StepRunnerCtx } from '../step-runner'

const baseConfig: CreateWorktreeConfig = {
  baseBranch: 'main',
  branchName: 'feature/x',
  displayName: 'Feature X',
  linkLinearIssue: false
}

const baseStep: Step = {
  id: 'cw1',
  kind: 'create-worktree',
  config: baseConfig,
  onFailure: 'halt',
  timeoutSeconds: null
}

const baseState: StepRunState = {
  stepId: 'cw1',
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
  context: { automation: { projectId: 'repo-1', workspaceId: null } },
  ...overrides
})

// PR-mode dep stub for new-branch tests that never exercise it.
const stubCreateWorktreeFromPr = () =>
  vi.fn().mockResolvedValue({ worktreeId: 'wt-pr', path: '/p/pr', branch: 'pr-branch' })

describe('CreateWorktreeRunner', () => {
  it('resolves templates and calls createWorktree on the first tick', async () => {
    const createWorktree = vi.fn().mockResolvedValue({
      worktreeId: 'wt-1',
      path: '/p/wt-1',
      branch: 'feature/x'
    })
    const runner = new CreateWorktreeRunner({
      createWorktree,
      createWorktreeFromPr: stubCreateWorktreeFromPr(),
      now: () => 100
    })
    const result = await runner.tick(baseCtx())
    expect(createWorktree).toHaveBeenCalledWith({
      repoId: 'repo-1',
      baseBranch: 'main',
      branchName: 'feature/x',
      displayName: 'Feature X',
      linkedIssue: null,
      createdByAutomationRunId: 'r1'
    })
    expect(result).toMatchObject({
      outcome: 'done',
      status: 'succeeded',
      output: { worktreeId: 'wt-1', path: '/p/wt-1', branch: 'feature/x' }
    })
    expect(result.contextPatch).toEqual({
      steps: { cw1: { worktreeId: 'wt-1', path: '/p/wt-1', branch: 'feature/x' } }
    })
  })

  it('resolves template references from context', async () => {
    const createWorktree = vi.fn().mockResolvedValue({
      worktreeId: 'wt-2',
      path: '/p',
      branch: 'feature/abc'
    })
    const runner = new CreateWorktreeRunner({
      createWorktree,
      createWorktreeFromPr: stubCreateWorktreeFromPr(),
      now: () => 0
    })
    const step: Step = {
      ...baseStep,
      config: {
        baseBranch: '{{trigger.baseBranch}}',
        branchName: 'feature/{{trigger.id}}',
        displayName: '{{trigger.title}}',
        linkLinearIssue: false
      }
    }
    await runner.tick(
      baseCtx({
        step,
        context: {
          automation: { projectId: 'repo-2' },
          trigger: { baseBranch: 'develop', id: 'abc', title: 'Fix X' }
        }
      })
    )
    expect(createWorktree).toHaveBeenCalledWith({
      repoId: 'repo-2',
      baseBranch: 'develop',
      branchName: 'feature/abc',
      displayName: 'Fix X',
      linkedIssue: null,
      createdByAutomationRunId: 'r1'
    })
  })

  it('attaches Linear issue when linkLinearIssue=true and trigger has linear data', async () => {
    const createWorktree = vi.fn().mockResolvedValue({
      worktreeId: 'wt-3',
      path: '/p',
      branch: 'b'
    })
    const runner = new CreateWorktreeRunner({
      createWorktree,
      createWorktreeFromPr: stubCreateWorktreeFromPr(),
      now: () => 0
    })
    const step: Step = { ...baseStep, config: { ...baseConfig, linkLinearIssue: true } }
    await runner.tick(
      baseCtx({
        step,
        context: {
          automation: { projectId: 'repo-1' },
          trigger: { linear: { issue: { id: 'LIN-123', title: 'X' } } }
        }
      })
    )
    expect(createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        linkedIssue: { provider: 'linear', id: 'LIN-123' }
      })
    )
  })

  it('passes linkedIssue=null when linkLinearIssue=true but no linear trigger data', async () => {
    const createWorktree = vi.fn().mockResolvedValue({
      worktreeId: 'wt-4',
      path: '/p',
      branch: 'b'
    })
    const runner = new CreateWorktreeRunner({
      createWorktree,
      createWorktreeFromPr: stubCreateWorktreeFromPr(),
      now: () => 0
    })
    const step: Step = { ...baseStep, config: { ...baseConfig, linkLinearIssue: true } }
    // No trigger.linear in context — non-Linear triggers can still opt-in via the flag.
    await runner.tick(
      baseCtx({
        step,
        context: { automation: { projectId: 'repo-1' } }
      })
    )
    expect(createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        linkedIssue: null
      })
    )
  })

  it('fails fast on TemplateResolutionError', async () => {
    const createWorktree = vi.fn()
    const runner = new CreateWorktreeRunner({
      createWorktree,
      createWorktreeFromPr: stubCreateWorktreeFromPr(),
      now: () => 0
    })
    const step: Step = {
      ...baseStep,
      config: { ...baseConfig, baseBranch: '{{missing.path}}' }
    }
    const result = await runner.tick(baseCtx({ step }))
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/missing\.path/)
    expect(createWorktree).not.toHaveBeenCalled()
  })

  it('fails when createWorktree rejects (deterministic failure)', async () => {
    const createWorktree = vi.fn().mockRejectedValue(new Error('git failure'))
    const runner = new CreateWorktreeRunner({
      createWorktree,
      createWorktreeFromPr: stubCreateWorktreeFromPr(),
      now: () => 0
    })
    const result = await runner.tick(baseCtx())
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/git failure/)
  })

  it('does not call createWorktree again if ticked after the first success', async () => {
    const createWorktree = vi.fn().mockResolvedValue({
      worktreeId: 'wt-5',
      path: '/p',
      branch: 'b'
    })
    const runner = new CreateWorktreeRunner({
      createWorktree,
      createWorktreeFromPr: stubCreateWorktreeFromPr(),
      now: () => 0
    })
    const result1 = await runner.tick(baseCtx())
    expect(result1.outcome).toBe('done')
    // In practice the chain executor never re-ticks a succeeded step, but the
    // runner should be defensive against double-create.
    const result2 = await runner.tick(baseCtx())
    expect(result2.outcome).toBe('done')
    expect(createWorktree).toHaveBeenCalledTimes(1)
  })

  it('pull-request mode resolves the PR number and calls createWorktreeFromPr', async () => {
    const createWorktree = vi.fn(() => {
      throw new Error('createWorktree must not be called in PR mode')
    })
    const createWorktreeFromPr = vi.fn().mockResolvedValue({
      worktreeId: 'w',
      path: '/p',
      branch: 'fix-7'
    })
    const runner = new CreateWorktreeRunner({ createWorktree, createWorktreeFromPr, now: () => 0 })
    const step: Step = {
      ...baseStep,
      config: {
        mode: 'pull-request',
        pullRequestRef: '{{trigger.github.pr.number}}',
        baseBranch: '',
        branchName: '',
        displayName: '{{trigger.github.pr.title}}',
        linkLinearIssue: false
      }
    }
    const result = await runner.tick(
      baseCtx({
        step,
        context: {
          automation: { projectId: 'r1' },
          trigger: {
            github: { pr: { number: 7, headRef: 'fix-7', isCrossRepository: false, title: 'Fix' } }
          }
        }
      })
    )
    expect(result.status).toBe('succeeded')
    expect(createWorktree).not.toHaveBeenCalled()
    expect(createWorktreeFromPr).toHaveBeenCalledTimes(1)
    expect(createWorktreeFromPr).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'r1',
        prNumber: 7,
        headRefName: 'fix-7',
        isCrossRepository: false,
        displayName: 'Fix'
      })
    )
    const tracker = { worktreeId: 'w', path: '/p', branch: 'fix-7' }
    expect(result.output).toEqual(tracker)
    expect(result.contextPatch).toEqual({ steps: { cw1: tracker } })
  })

  it('pull-request mode fails when pullRequestRef is missing/blank', async () => {
    const createWorktree = vi.fn()
    const createWorktreeFromPr = vi.fn()
    const runner = new CreateWorktreeRunner({ createWorktree, createWorktreeFromPr, now: () => 0 })
    const step: Step = {
      ...baseStep,
      config: {
        mode: 'pull-request',
        baseBranch: '',
        branchName: '',
        displayName: 'X',
        linkLinearIssue: false
      }
    }
    const result = await runner.tick(
      baseCtx({ step, context: { automation: { projectId: 'r1' } } })
    )
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
    expect(result.error).toBeTruthy()
    expect(createWorktreeFromPr).not.toHaveBeenCalled()
  })

  it('pull-request mode fails when the resolved PR number is not a positive integer', async () => {
    const createWorktree = vi.fn()
    const createWorktreeFromPr = vi.fn()
    const runner = new CreateWorktreeRunner({ createWorktree, createWorktreeFromPr, now: () => 0 })
    const step: Step = {
      ...baseStep,
      config: {
        mode: 'pull-request',
        pullRequestRef: '{{trigger.ref}}',
        baseBranch: '',
        branchName: '',
        displayName: 'X',
        linkLinearIssue: false
      }
    }
    const result = await runner.tick(
      baseCtx({
        step,
        context: { automation: { projectId: 'r1' }, trigger: { ref: 'abc' } }
      })
    )
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
    expect(result.error).toBeTruthy()
    expect(createWorktreeFromPr).not.toHaveBeenCalled()
  })

  it('new-branch mode still calls createWorktree (regression)', async () => {
    const createWorktree = vi.fn().mockResolvedValue({
      worktreeId: 'wt-nb',
      path: '/p/nb',
      branch: 'feature/x'
    })
    const createWorktreeFromPr = vi.fn(() => {
      throw new Error('createWorktreeFromPr must not be called in new-branch mode')
    })
    const runner = new CreateWorktreeRunner({ createWorktree, createWorktreeFromPr, now: () => 0 })
    const result = await runner.tick(baseCtx())
    expect(result.status).toBe('succeeded')
    expect(createWorktree).toHaveBeenCalledTimes(1)
    expect(createWorktreeFromPr).not.toHaveBeenCalled()
  })
})
