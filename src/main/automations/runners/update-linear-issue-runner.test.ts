import { describe, it, expect, vi } from 'vitest'
import type { Step, StepRunState, UpdateLinearIssueConfig } from '../../../shared/automations-types'
import { UpdateLinearIssueRunner } from './update-linear-issue-runner'
import type { StepRunnerCtx } from '../step-runner'

const baseConfig: UpdateLinearIssueConfig = {
  issueRef: 'issue-abc',
  assigneeRef: 'user-1',
  stateRef: 'state-1'
}

const baseStep: Step = {
  id: 'uli1',
  kind: 'update-linear-issue',
  config: baseConfig,
  onFailure: 'halt',
  timeoutSeconds: null
}

const baseState: StepRunState = {
  stepId: 'uli1',
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

describe('UpdateLinearIssueRunner', () => {
  it('calls updateIssue with both assigneeId and stateId when both refs are set', async () => {
    const updateIssue = vi.fn().mockResolvedValue({ ok: true })
    const runner = new UpdateLinearIssueRunner({ updateIssue })
    const result = await runner.tick(baseCtx())
    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')
    expect(result.output).toEqual({})
    expect(updateIssue).toHaveBeenCalledWith('issue-abc', {
      assigneeId: 'user-1',
      stateId: 'state-1'
    })
  })

  it('omits stateId when only assigneeRef is set', async () => {
    const updateIssue = vi.fn().mockResolvedValue({ ok: true })
    const runner = new UpdateLinearIssueRunner({ updateIssue })
    const step: Step = {
      ...baseStep,
      config: { issueRef: 'issue-abc', assigneeRef: 'user-1' }
    }
    const result = await runner.tick(baseCtx({ step }))
    expect(result.outcome).toBe('done')
    expect(updateIssue).toHaveBeenCalledWith('issue-abc', { assigneeId: 'user-1' })
  })

  it('omits assigneeId when only stateRef is set', async () => {
    const updateIssue = vi.fn().mockResolvedValue({ ok: true })
    const runner = new UpdateLinearIssueRunner({ updateIssue })
    const step: Step = {
      ...baseStep,
      config: { issueRef: 'issue-abc', stateRef: 'state-1' }
    }
    const result = await runner.tick(baseCtx({ step }))
    expect(result.outcome).toBe('done')
    expect(updateIssue).toHaveBeenCalledWith('issue-abc', { stateId: 'state-1' })
  })

  it('treats empty-string assignee/state refs as unset (fail-fast)', async () => {
    const updateIssue = vi.fn()
    const runner = new UpdateLinearIssueRunner({ updateIssue })
    const step: Step = {
      ...baseStep,
      config: { issueRef: 'issue-abc', assigneeRef: '   ', stateRef: '' }
    }
    const result = await runner.tick(baseCtx({ step }))
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/at least one of assigneeRef or stateRef/)
    expect(updateIssue).not.toHaveBeenCalled()
  })

  it('fails fast when neither assigneeRef nor stateRef are present', async () => {
    const updateIssue = vi.fn()
    const runner = new UpdateLinearIssueRunner({ updateIssue })
    const step: Step = {
      ...baseStep,
      config: { issueRef: 'issue-abc' }
    }
    const result = await runner.tick(baseCtx({ step }))
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/at least one of assigneeRef or stateRef/)
    expect(updateIssue).not.toHaveBeenCalled()
  })

  it('fails fast on template resolution error', async () => {
    const updateIssue = vi.fn()
    const runner = new UpdateLinearIssueRunner({ updateIssue })
    const step: Step = {
      ...baseStep,
      config: {
        issueRef: '{{missing.path}}',
        assigneeRef: 'user-1'
      }
    }
    const result = await runner.tick(baseCtx({ step }))
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/missing\.path/)
    expect(updateIssue).not.toHaveBeenCalled()
  })

  it('fails fast when issueRef resolves to an empty string', async () => {
    const updateIssue = vi.fn()
    const runner = new UpdateLinearIssueRunner({ updateIssue })
    const step: Step = {
      ...baseStep,
      config: { issueRef: '   ', assigneeRef: 'user-1' }
    }
    const result = await runner.tick(baseCtx({ step }))
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/issueRef resolved to an empty string/)
    expect(updateIssue).not.toHaveBeenCalled()
  })

  it('returns failed when updateIssue returns ok:false', async () => {
    const updateIssue = vi.fn().mockResolvedValue({ ok: false, error: 'Linear update failed' })
    const runner = new UpdateLinearIssueRunner({ updateIssue })
    const result = await runner.tick(baseCtx())
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/Linear update failed/)
  })

  it('resolves templates from the run context', async () => {
    const updateIssue = vi.fn().mockResolvedValue({ ok: true })
    const runner = new UpdateLinearIssueRunner({ updateIssue })
    const step: Step = {
      ...baseStep,
      config: {
        issueRef: '{{trigger.linear.issue.id}}',
        assigneeRef: '{{trigger.linear.issue.assigneeId}}',
        stateRef: 'state-literal'
      }
    }
    const ctx = baseCtx({
      step,
      context: {
        trigger: {
          linear: { issue: { id: 'issue-xyz', assigneeId: 'user-from-template' } }
        }
      }
    })
    const result = await runner.tick(ctx)
    expect(result.outcome).toBe('done')
    expect(updateIssue).toHaveBeenCalledWith('issue-xyz', {
      assigneeId: 'user-from-template',
      stateId: 'state-literal'
    })
  })

  it('is idempotent: a re-tick returns the cached outcome without re-firing updateIssue', async () => {
    const updateIssue = vi.fn().mockResolvedValue({ ok: true })
    const runner = new UpdateLinearIssueRunner({ updateIssue })
    const result1 = await runner.tick(baseCtx())
    const result2 = await runner.tick(baseCtx())
    expect(result1.outcome).toBe('done')
    expect(result2.outcome).toBe('done')
    expect(updateIssue).toHaveBeenCalledTimes(1)
  })

  it('dropRun clears the cached outcome so a fresh tick re-fires updateIssue', async () => {
    const updateIssue = vi.fn().mockResolvedValue({ ok: true })
    const runner = new UpdateLinearIssueRunner({ updateIssue })
    await runner.tick(baseCtx())
    runner.dropRun('r1')
    await runner.tick(baseCtx())
    expect(updateIssue).toHaveBeenCalledTimes(2)
  })

  it('dropStep clears just the targeted (runId, stepId) entry', async () => {
    const updateIssue = vi.fn().mockResolvedValue({ ok: true })
    const runner = new UpdateLinearIssueRunner({ updateIssue })
    await runner.tick(baseCtx())
    runner.dropStep('r1', 'uli1')
    await runner.tick(baseCtx())
    expect(updateIssue).toHaveBeenCalledTimes(2)
  })
})
