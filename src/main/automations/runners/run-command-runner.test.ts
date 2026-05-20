import { describe, it, expect, vi } from 'vitest'
import type { RunCommandConfig, Step, StepRunState } from '../../../shared/automations-types'
import { RunCommandRunner } from './run-command-runner'
import type { StepRunnerCtx } from '../step-runner'
import type { PtyExitEntry } from '../../pty/exit-registry'

const baseConfig: RunCommandConfig = {
  worktreeRef: 'wt-1',
  source: 'review',
  commandId: 'cmd-review-1',
  captureStdout: false
}

const baseStep: Step = {
  id: 'run-review',
  kind: 'run-command',
  config: baseConfig,
  onFailure: 'halt',
  timeoutSeconds: null
}

const baseState: StepRunState = {
  stepId: 'run-review',
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

describe('RunCommandRunner', () => {
  it('opens a command pane on the first tick and returns needs-more-time', async () => {
    const openCommandPane = vi.fn().mockResolvedValue({ ptyId: 'pty-1', paneKey: 'tab-1:1' })
    const runner = new RunCommandRunner({
      openCommandPane,
      getPtyExit: vi.fn().mockReturnValue(undefined),
      now: () => 0
    })
    const next = await runner.tick(baseCtx())
    expect(openCommandPane).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      source: 'review',
      commandId: 'cmd-review-1',
      customCommand: undefined
    })
    expect(next.outcome).toBe('needs-more-time')
    expect(next.status).toBe('running')
  })

  it('forwards a resolved customCommand for source=custom', async () => {
    const openCommandPane = vi.fn().mockResolvedValue({ ptyId: 'pty-2', paneKey: 'tab-2:1' })
    const runner = new RunCommandRunner({
      openCommandPane,
      getPtyExit: vi.fn().mockReturnValue(undefined),
      now: () => 0
    })
    const step: Step = {
      ...baseStep,
      config: {
        worktreeRef: '{{automation.workspaceId}}',
        source: 'custom',
        customCommand: 'gh pr create --title "{{trigger.title}}"',
        captureStdout: false
      }
    }
    await runner.tick(
      baseCtx({
        step,
        context: {
          automation: { workspaceId: 'wt-from-template' },
          trigger: { title: 'Fix X' }
        }
      })
    )
    expect(openCommandPane).toHaveBeenCalledWith({
      worktreeId: 'wt-from-template',
      source: 'custom',
      commandId: undefined,
      customCommand: 'gh pr create --title "Fix X"'
    })
  })

  it('returns needs-more-time while the PTY is still running', async () => {
    const openCommandPane = vi.fn().mockResolvedValue({ ptyId: 'pty-1', paneKey: 'tab-1:1' })
    let now = 0
    const runner = new RunCommandRunner({
      openCommandPane,
      getPtyExit: () => undefined,
      now: () => now
    })
    const ctx = baseCtx()
    await runner.tick(ctx)
    now = 5_000
    const second = await runner.tick(ctx)
    expect(second).toEqual({ outcome: 'needs-more-time', status: 'running' })
    expect(openCommandPane).toHaveBeenCalledTimes(1)
  })

  it('returns done with exitCode 0 when the PTY exits successfully', async () => {
    const openCommandPane = vi.fn().mockResolvedValue({ ptyId: 'pty-1', paneKey: 'tab-1:1' })
    let now = 0
    const exit: PtyExitEntry = { exitCode: 0, finishedAt: 4_500 }
    const runner = new RunCommandRunner({
      openCommandPane,
      getPtyExit: (ptyId: string) => (ptyId === 'pty-1' ? exit : undefined),
      now: () => now
    })
    const ctx = baseCtx()
    await runner.tick(ctx)
    now = 5_000
    const result = await runner.tick(ctx)
    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')
    expect(result.output).toEqual({ exitCode: 0, paneKey: 'tab-1:1', durationMs: 5_000 })
  })

  it('still returns done (not failed) when the PTY exits non-zero — operators decide via onFailure', async () => {
    const openCommandPane = vi.fn().mockResolvedValue({ ptyId: 'pty-1', paneKey: 'tab-1:1' })
    let now = 0
    const exit: PtyExitEntry = { exitCode: 1, finishedAt: 2_000 }
    const runner = new RunCommandRunner({
      openCommandPane,
      getPtyExit: () => exit,
      now: () => now
    })
    const ctx = baseCtx()
    await runner.tick(ctx)
    now = 3_000
    const result = await runner.tick(ctx)
    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')
    expect(result.output).toEqual({ exitCode: 1, paneKey: 'tab-1:1', durationMs: 3_000 })
  })

  it('times out per step.timeoutSeconds', async () => {
    const openCommandPane = vi.fn().mockResolvedValue({ ptyId: 'pty-1', paneKey: 'tab-1:1' })
    let now = 0
    const runner = new RunCommandRunner({
      openCommandPane,
      getPtyExit: () => undefined,
      now: () => now
    })
    const step: Step = { ...baseStep, timeoutSeconds: 30 }
    const ctx = baseCtx({ step })
    await runner.tick(ctx)
    now = 29_000
    const before = await runner.tick(ctx)
    expect(before).toEqual({ outcome: 'needs-more-time', status: 'running' })
    now = 30_000
    const timedOut = await runner.tick(ctx)
    expect(timedOut.outcome).toBe('failed')
    expect(timedOut.status).toBe('timed-out')
    expect(timedOut.error).toMatch(/timeout of 30s/)
  })

  it('fails fast on TemplateResolutionError without calling openCommandPane', async () => {
    const openCommandPane = vi.fn()
    const runner = new RunCommandRunner({
      openCommandPane,
      getPtyExit: () => undefined,
      now: () => 0
    })
    const step: Step = {
      ...baseStep,
      config: {
        worktreeRef: '{{missing.path}}',
        source: 'review',
        commandId: 'cmd-1',
        captureStdout: false
      }
    }
    const result = await runner.tick(baseCtx({ step }))
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/missing\.path/)
    expect(openCommandPane).not.toHaveBeenCalled()
  })

  it('fails fast when openCommandPane throws OpenCommandPaneError', async () => {
    const { OpenCommandPaneError } = await import('../open-command-pane')
    const openCommandPane = vi
      .fn()
      .mockRejectedValue(new OpenCommandPaneError('Review command not configured.'))
    const runner = new RunCommandRunner({
      openCommandPane,
      getPtyExit: () => undefined,
      now: () => 0
    })
    const result = await runner.tick(baseCtx())
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/not configured/)
  })

  it('retries openCommandPane on a transient (plain Error) failure', async () => {
    const openCommandPane = vi
      .fn()
      .mockRejectedValueOnce(new Error('renderer not ready'))
      .mockResolvedValueOnce({ ptyId: 'pty-1', paneKey: 'tab-1:1' })
    const runner = new RunCommandRunner({
      openCommandPane,
      getPtyExit: () => undefined,
      now: () => 0
    })
    const ctx = baseCtx()
    await expect(runner.tick(ctx)).rejects.toThrow(/not ready/)
    const result = await runner.tick(ctx)
    expect(result.outcome).toBe('needs-more-time')
    expect(openCommandPane).toHaveBeenCalledTimes(2)
  })

  it('two different runs of the same step.id get independent trackers', async () => {
    const openCommandPane = vi.fn().mockResolvedValue({ ptyId: 'pty-1', paneKey: 'tab-1:1' })
    const runner = new RunCommandRunner({
      openCommandPane,
      getPtyExit: () => undefined,
      now: () => 0
    })
    await runner.tick(baseCtx({ runId: 'runA' }))
    await runner.tick(baseCtx({ runId: 'runB' }))
    expect(openCommandPane).toHaveBeenCalledTimes(2)
  })
})
