import { describe, it, expect, vi } from 'vitest'
import type { Step, StepRunState } from '../../../shared/automations-types'
import { RunPromptRunner } from './run-prompt-runner'
import type { StepRunnerCtx } from '../step-runner'

const baseStep: Step = {
  id: 'send-prompt',
  kind: 'run-prompt',
  config: {
    worktreeRef: 'wt-123',
    agentId: 'claude',
    prompt: 'Hello',
    doneDebounceSeconds: 15
  },
  onFailure: 'halt',
  timeoutSeconds: null
}

const baseState: StepRunState = {
  stepId: 'send-prompt',
  status: 'pending',
  startedAt: null,
  finishedAt: null,
  output: null,
  error: null
}

describe('RunPromptRunner', () => {
  it('opens a prompt pane on the first tick and returns needs-more-time', async () => {
    const openPromptPane = vi.fn().mockResolvedValue({ paneKey: 'tab-1:pane-1' })
    const runner = new RunPromptRunner({
      openPromptPane,
      getAgentStatus: vi.fn().mockReturnValue(undefined),
      now: () => 0
    })
    const ctx: StepRunnerCtx = { runId: 'r1', step: baseStep, state: baseState, context: {} }
    const next = await runner.tick(ctx)
    expect(openPromptPane).toHaveBeenCalledWith({
      worktreeId: 'wt-123',
      agentId: 'claude',
      prompt: 'Hello'
    })
    expect(next.status).toBe('running')
    expect(next.outcome).toBe('needs-more-time')
  })

  it('resolves templated worktreeRef and prompt from context before opening the pane', async () => {
    const openPromptPane = vi.fn().mockResolvedValue({ paneKey: 'tab-1:pane-1' })
    const runner = new RunPromptRunner({
      openPromptPane,
      getAgentStatus: vi.fn().mockReturnValue(undefined),
      now: () => 0
    })
    const step: Step = {
      ...baseStep,
      config: {
        ...baseStep.config,
        worktreeRef: '{{automation.workspaceId}}',
        prompt: 'Implement {{trigger.title}}'
      }
    }
    const ctx: StepRunnerCtx = {
      runId: 'r2',
      step,
      state: baseState,
      context: {
        automation: { workspaceId: 'wt-from-template' },
        trigger: { title: 'Fix X' }
      }
    }
    await runner.tick(ctx)
    expect(openPromptPane).toHaveBeenCalledWith({
      worktreeId: 'wt-from-template',
      agentId: 'claude',
      prompt: 'Implement Fix X'
    })
  })

  it('does not call openPromptPane on subsequent ticks for the same step', async () => {
    const openPromptPane = vi.fn().mockResolvedValue({ paneKey: 'tab-1:pane-1' })
    const runner = new RunPromptRunner({
      openPromptPane,
      getAgentStatus: vi.fn().mockReturnValue(undefined),
      now: () => 0
    })
    const ctx: StepRunnerCtx = { runId: 'r3', step: baseStep, state: baseState, context: {} }
    await runner.tick(ctx)
    await runner.tick(ctx)
    await runner.tick(ctx)
    expect(openPromptPane).toHaveBeenCalledTimes(1)
  })

  it('fails fast when a template references an unresolved path', async () => {
    const openPromptPane = vi.fn().mockResolvedValue({ paneKey: 'p' })
    const runner = new RunPromptRunner({
      openPromptPane,
      getAgentStatus: vi.fn().mockReturnValue(undefined),
      now: () => 0
    })
    const step: Step = {
      ...baseStep,
      config: { ...baseStep.config, prompt: 'Implement {{trigger.missing}}' }
    }
    const ctx: StepRunnerCtx = { runId: 'r', step, state: baseState, context: {} }
    const result = await runner.tick(ctx)
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/trigger\.missing/)
    expect(openPromptPane).not.toHaveBeenCalled()
  })

  it('retries the pane open on transient failures (does not record a tracker)', async () => {
    const openPromptPane = vi
      .fn()
      .mockRejectedValueOnce(new Error('worktree not ready'))
      .mockResolvedValueOnce({ paneKey: 'p' })
    const runner = new RunPromptRunner({
      openPromptPane,
      getAgentStatus: vi.fn().mockReturnValue(undefined),
      now: () => 0
    })
    const ctx: StepRunnerCtx = { runId: 'r', step: baseStep, state: baseState, context: {} }
    // First tick throws — caller would surface this as an error to step state
    await expect(runner.tick(ctx)).rejects.toThrow(/worktree not ready/)
    // Second tick retries openPromptPane (no tracker recorded yet)
    const result = await runner.tick(ctx)
    expect(result.outcome).toBe('needs-more-time')
    expect(openPromptPane).toHaveBeenCalledTimes(2)
  })

  it('two different runs of the same step.id get independent trackers', async () => {
    const openPromptPane = vi.fn().mockResolvedValue({ paneKey: 'p' })
    const runner = new RunPromptRunner({
      openPromptPane,
      getAgentStatus: vi.fn().mockReturnValue(undefined),
      now: () => 0
    })
    const ctxA: StepRunnerCtx = { runId: 'runA', step: baseStep, state: baseState, context: {} }
    const ctxB: StepRunnerCtx = { runId: 'runB', step: baseStep, state: baseState, context: {} }
    await runner.tick(ctxA)
    await runner.tick(ctxB)
    expect(openPromptPane).toHaveBeenCalledTimes(2)
  })
})
