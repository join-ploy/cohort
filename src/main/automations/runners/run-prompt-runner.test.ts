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

  it('fails fast when openPromptPane throws OpenPromptPaneError', async () => {
    const { OpenPromptPaneError } = await import('../open-prompt-pane')
    const openPromptPane = vi.fn().mockRejectedValue(new OpenPromptPaneError('worktree gone'))
    const runner = new RunPromptRunner({
      openPromptPane,
      getAgentStatus: vi.fn().mockReturnValue(undefined),
      now: () => 0
    })
    const ctx: StepRunnerCtx = { runId: 'r', step: baseStep, state: baseState, context: {} }
    const result = await runner.tick(ctx)
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/worktree gone/)
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

  // ─── Polling lifecycle ───────────────────────────────────────────────────

  it('keeps running while the agent is working', async () => {
    const openPromptPane = vi.fn().mockResolvedValue({ paneKey: 'p1' })
    let now = 0
    const runner = new RunPromptRunner({
      openPromptPane,
      getAgentStatus: () => ({ state: 'working', updatedAt: now }),
      now: () => now
    })
    const ctx: StepRunnerCtx = { runId: 'r', step: baseStep, state: baseState, context: {} }
    // Tick 1: opens pane.
    await runner.tick(ctx)
    now = 1_000
    const tick2 = await runner.tick(ctx)
    expect(tick2).toEqual({ outcome: 'needs-more-time', status: 'running' })
    now = 5_000
    const tick3 = await runner.tick(ctx)
    expect(tick3).toEqual({ outcome: 'needs-more-time', status: 'running' })
  })

  it('fails when the agent reports blocked', async () => {
    const openPromptPane = vi.fn().mockResolvedValue({ paneKey: 'p1' })
    let now = 0
    let state: 'working' | 'blocked' | 'waiting' | 'done' = 'working'
    const runner = new RunPromptRunner({
      openPromptPane,
      getAgentStatus: () => ({ state, updatedAt: now }),
      now: () => now
    })
    const ctx: StepRunnerCtx = { runId: 'r', step: baseStep, state: baseState, context: {} }
    await runner.tick(ctx)
    now = 1_000
    state = 'blocked'
    const result = await runner.tick(ctx)
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/needs human input.*blocked/)
  })

  it('fails when the agent reports waiting', async () => {
    const openPromptPane = vi.fn().mockResolvedValue({ paneKey: 'p1' })
    let now = 0
    let state: 'working' | 'blocked' | 'waiting' | 'done' = 'working'
    const runner = new RunPromptRunner({
      openPromptPane,
      getAgentStatus: () => ({ state, updatedAt: now }),
      now: () => now
    })
    const ctx: StepRunnerCtx = { runId: 'r', step: baseStep, state: baseState, context: {} }
    await runner.tick(ctx)
    now = 1_000
    state = 'waiting'
    const result = await runner.tick(ctx)
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/needs human input.*waiting/)
  })

  it('requires done to persist past the debounce window before succeeding', async () => {
    const openPromptPane = vi.fn().mockResolvedValue({ paneKey: 'p1' })
    let now = 0
    let state: 'working' | 'blocked' | 'waiting' | 'done' = 'working'
    const runner = new RunPromptRunner({
      openPromptPane,
      getAgentStatus: () => ({ state, updatedAt: now }),
      now: () => now
    })
    const ctx: StepRunnerCtx = { runId: 'r', step: baseStep, state: baseState, context: {} }
    // Open pane at t=0.
    await runner.tick(ctx)
    // First `done` ping at t=1s arms the debounce window.
    now = 1_000
    state = 'done'
    const arm = await runner.tick(ctx)
    expect(arm).toEqual({ outcome: 'needs-more-time', status: 'running' })
    // Still inside the 15s debounce window — must keep waiting.
    now = 10_000
    const mid = await runner.tick(ctx)
    expect(mid).toEqual({ outcome: 'needs-more-time', status: 'running' })
    // 15s of continuous done now elapsed (1_000 → 16_000) — succeed.
    now = 16_000
    const succeed = await runner.tick(ctx)
    expect(succeed.outcome).toBe('done')
    expect(succeed.status).toBe('succeeded')
    expect(succeed.output).toEqual({ paneKey: 'p1', durationMs: 16_000, outputTail: '' })
  })

  it('resets the debounce if state flips back to working mid-window', async () => {
    const openPromptPane = vi.fn().mockResolvedValue({ paneKey: 'p1' })
    let now = 0
    let state: 'working' | 'blocked' | 'waiting' | 'done' = 'working'
    const runner = new RunPromptRunner({
      openPromptPane,
      getAgentStatus: () => ({ state, updatedAt: now }),
      now: () => now
    })
    const ctx: StepRunnerCtx = { runId: 'r', step: baseStep, state: baseState, context: {} }
    await runner.tick(ctx)
    // Arm debounce at t=1s.
    now = 1_000
    state = 'done'
    await runner.tick(ctx)
    // Flip back to working before the 15s window expires.
    now = 5_000
    state = 'working'
    const flip = await runner.tick(ctx)
    expect(flip).toEqual({ outcome: 'needs-more-time', status: 'running' })
    // Done again — debounce must re-arm from this moment (not from t=1s).
    now = 6_000
    state = 'done'
    const rearm = await runner.tick(ctx)
    expect(rearm).toEqual({ outcome: 'needs-more-time', status: 'running' })
    // At t=20s — 14s since re-arm. Still short of the 15s window, must wait.
    now = 20_000
    const stillWaiting = await runner.tick(ctx)
    expect(stillWaiting).toEqual({ outcome: 'needs-more-time', status: 'running' })
    // At t=21s — exactly 15s past re-arm — must succeed now.
    now = 21_000
    const finallyDone = await runner.tick(ctx)
    expect(finallyDone.outcome).toBe('done')
    expect(finallyDone.status).toBe('succeeded')
    expect(finallyDone.output).toEqual({ paneKey: 'p1', durationMs: 21_000, outputTail: '' })
  })

  it('times out per step.timeoutSeconds', async () => {
    const openPromptPane = vi.fn().mockResolvedValue({ paneKey: 'p1' })
    let now = 0
    const runner = new RunPromptRunner({
      openPromptPane,
      getAgentStatus: () => ({ state: 'working', updatedAt: now }),
      now: () => now
    })
    const step = { ...baseStep, timeoutSeconds: 30 }
    const ctx: StepRunnerCtx = { runId: 'r', step, state: baseState, context: {} }
    await runner.tick(ctx)
    // 29s elapsed — still under the limit.
    now = 29_000
    const beforeTimeout = await runner.tick(ctx)
    expect(beforeTimeout).toEqual({ outcome: 'needs-more-time', status: 'running' })
    // 30s elapsed — must time out.
    now = 30_000
    const timedOut = await runner.tick(ctx)
    expect(timedOut.outcome).toBe('failed')
    expect(timedOut.status).toBe('timed-out')
    expect(timedOut.error).toMatch(/timeout of 30s/)
  })

  it('treats missing status as still warming up (running)', async () => {
    const openPromptPane = vi.fn().mockResolvedValue({ paneKey: 'p1' })
    let now = 0
    const runner = new RunPromptRunner({
      openPromptPane,
      getAgentStatus: () => undefined,
      now: () => now
    })
    const ctx: StepRunnerCtx = { runId: 'r', step: baseStep, state: baseState, context: {} }
    // Tick 1 opens the pane.
    await runner.tick(ctx)
    // Subsequent ticks with no status yet must keep running, not fail.
    now = 1_000
    const tick2 = await runner.tick(ctx)
    expect(tick2).toEqual({ outcome: 'needs-more-time', status: 'running' })
    now = 5_000
    const tick3 = await runner.tick(ctx)
    expect(tick3).toEqual({ outcome: 'needs-more-time', status: 'running' })
  })

  // ─── paneRef: reuse existing pane ────────────────────────────────────────

  it('with paneRef set: calls sendPromptToPane and records the resolved paneKey', async () => {
    const sendPromptToPane = vi.fn().mockResolvedValue(undefined)
    const openPromptPane = vi.fn() // should NOT be called
    const runner = new RunPromptRunner({
      openPromptPane,
      sendPromptToPane,
      getAgentStatus: vi.fn().mockReturnValue({ state: 'done', updatedAt: 0 }),
      now: () => 0
    })
    const step: Step = {
      ...baseStep,
      config: { ...baseStep.config, paneRef: 'tab-9:1' }
    }
    const ctx: StepRunnerCtx = { runId: 'r', step, state: baseState, context: {} }
    const result = await runner.tick(ctx)
    expect(sendPromptToPane).toHaveBeenCalledWith({ paneKey: 'tab-9:1', prompt: 'Hello' })
    expect(openPromptPane).not.toHaveBeenCalled()
    expect(result.outcome).toBe('needs-more-time')
    expect(result.status).toBe('running')
  })

  it('with paneRef set + agent working: returns needs-more-time WITHOUT sending', async () => {
    const sendPromptToPane = vi.fn()
    const runner = new RunPromptRunner({
      openPromptPane: vi.fn(),
      sendPromptToPane,
      getAgentStatus: vi.fn().mockReturnValue({ state: 'working', updatedAt: 0 }),
      now: () => 0
    })
    const step: Step = { ...baseStep, config: { ...baseStep.config, paneRef: 'tab-9:1' } }
    const result = await runner.tick({ runId: 'r', step, state: baseState, context: {} })
    expect(sendPromptToPane).not.toHaveBeenCalled()
    expect(result.outcome).toBe('needs-more-time')
  })

  it('with paneRef set + agent blocked: fails immediately', async () => {
    const sendPromptToPane = vi.fn()
    const runner = new RunPromptRunner({
      openPromptPane: vi.fn(),
      sendPromptToPane,
      getAgentStatus: vi.fn().mockReturnValue({ state: 'blocked', updatedAt: 0 }),
      now: () => 0
    })
    const step: Step = { ...baseStep, config: { ...baseStep.config, paneRef: 'tab-9:1' } }
    const result = await runner.tick({ runId: 'r', step, state: baseState, context: {} })
    expect(result.outcome).toBe('failed')
    expect(sendPromptToPane).not.toHaveBeenCalled()
  })

  it('with paneRef set + SendPromptToPaneError: fails fast', async () => {
    const { SendPromptToPaneError } = await import('../send-prompt-to-pane')
    const sendPromptToPane = vi.fn().mockRejectedValue(new SendPromptToPaneError('pane gone'))
    const runner = new RunPromptRunner({
      openPromptPane: vi.fn(),
      sendPromptToPane,
      getAgentStatus: vi.fn().mockReturnValue({ state: 'done', updatedAt: 0 }),
      now: () => 0
    })
    const step: Step = { ...baseStep, config: { ...baseStep.config, paneRef: 'tab-9:1' } }
    const result = await runner.tick({ runId: 'r', step, state: baseState, context: {} })
    expect(result.outcome).toBe('failed')
    expect(result.error).toMatch(/pane gone/)
  })

  it('with paneRef template using context: resolves before sending', async () => {
    const sendPromptToPane = vi.fn().mockResolvedValue(undefined)
    const runner = new RunPromptRunner({
      openPromptPane: vi.fn(),
      sendPromptToPane,
      getAgentStatus: vi.fn().mockReturnValue({ state: 'done', updatedAt: 0 }),
      now: () => 0
    })
    const step: Step = {
      ...baseStep,
      config: { ...baseStep.config, paneRef: '{{steps.prior.paneKey}}' }
    }
    const ctx: StepRunnerCtx = {
      runId: 'r',
      step,
      state: baseState,
      context: { steps: { prior: { paneKey: 'tab-9:1' } } }
    }
    await runner.tick(ctx)
    expect(sendPromptToPane).toHaveBeenCalledWith({ paneKey: 'tab-9:1', prompt: 'Hello' })
  })

  // ─── group: branch (grouped-workspaces L3) ───────────────────────────────

  it('opens the pane at the group parentPath when worktreeRef resolves to a group:<id>', async () => {
    const openPromptPane = vi.fn().mockResolvedValue({ paneKey: 'tab-grp:pane-1' })
    const getGroupSummary = vi.fn().mockReturnValue({
      parentPath: '/orca/workspaces/feat-x',
      firstMemberWorktreeId: 'repo-a::/orca/workspaces/feat-x/repo-a',
      connectionId: null
    })
    const getWorktreeSummary = vi.fn() // must NOT be called for group: ids
    const runner = new RunPromptRunner({
      openPromptPane,
      getAgentStatus: vi.fn().mockReturnValue(undefined),
      getGroupSummary,
      getWorktreeSummary,
      now: () => 0
    })
    // Why: simulate the output shape CreateWorkspaceGroupRunner stamps into
    // context.steps — `groupId` is a `group:<uuid>` string.
    const step: Step = {
      ...baseStep,
      config: { ...baseStep.config, worktreeRef: '{{steps.cwg1.groupId}}' }
    }
    const ctx: StepRunnerCtx = {
      runId: 'r-group',
      step,
      state: baseState,
      context: { steps: { cwg1: { groupId: 'group:abc-123' } } }
    }
    const result = await runner.tick(ctx)
    expect(getGroupSummary).toHaveBeenCalledWith('group:abc-123')
    expect(getWorktreeSummary).not.toHaveBeenCalled()
    // The agent is bound to the first member's worktreeId (UI binding) and
    // its CWD points at the group's parentPath (where `pwd` lands).
    expect(openPromptPane).toHaveBeenCalledWith({
      worktreeId: 'repo-a::/orca/workspaces/feat-x/repo-a',
      agentId: 'claude',
      prompt: 'Hello',
      worktreePath: '/orca/workspaces/feat-x',
      connectionId: null
    })
    expect(result.outcome).toBe('needs-more-time')
  })

  it('fails fast when worktreeRef resolves to a group:<id> the store cannot find', async () => {
    const openPromptPane = vi.fn()
    const getGroupSummary = vi.fn().mockReturnValue(null)
    const runner = new RunPromptRunner({
      openPromptPane,
      getAgentStatus: vi.fn().mockReturnValue(undefined),
      getGroupSummary,
      now: () => 0
    })
    const step: Step = {
      ...baseStep,
      config: { ...baseStep.config, worktreeRef: 'group:missing' }
    }
    const ctx: StepRunnerCtx = { runId: 'r', step, state: baseState, context: {} }
    const result = await runner.tick(ctx)
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/Group not found.*group:missing/)
    expect(openPromptPane).not.toHaveBeenCalled()
  })
})
