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

/** A no-op PTY data subscription that never fires. The default for tests that
 *  don't care about output capture — they should still construct the runner
 *  with this dep so the contract stays exercised. */
const noopSubscribePtyData = (): (() => void) => () => {}

describe('RunCommandRunner', () => {
  it('opens a command pane on the first tick and returns needs-more-time', async () => {
    const openCommandPane = vi.fn().mockResolvedValue({ ptyId: 'pty-1', paneKey: 'tab-1:1' })
    const runner = new RunCommandRunner({
      openCommandPane,
      getPtyExit: vi.fn().mockReturnValue(undefined),
      subscribePtyData: noopSubscribePtyData,
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
      subscribePtyData: noopSubscribePtyData,
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
      subscribePtyData: noopSubscribePtyData,
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
      subscribePtyData: noopSubscribePtyData,
      now: () => now
    })
    const ctx = baseCtx()
    await runner.tick(ctx)
    now = 5_000
    const result = await runner.tick(ctx)
    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')
    expect(result.output).toEqual({
      exitCode: 0,
      paneKey: 'tab-1:1',
      durationMs: 5_000,
      outputTail: ''
    })
  })

  it('still returns done (not failed) when the PTY exits non-zero — operators decide via onFailure', async () => {
    const openCommandPane = vi.fn().mockResolvedValue({ ptyId: 'pty-1', paneKey: 'tab-1:1' })
    let now = 0
    const exit: PtyExitEntry = { exitCode: 1, finishedAt: 2_000 }
    const runner = new RunCommandRunner({
      openCommandPane,
      getPtyExit: () => exit,
      subscribePtyData: noopSubscribePtyData,
      now: () => now
    })
    const ctx = baseCtx()
    await runner.tick(ctx)
    now = 3_000
    const result = await runner.tick(ctx)
    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')
    expect(result.output).toEqual({
      exitCode: 1,
      paneKey: 'tab-1:1',
      durationMs: 3_000,
      outputTail: ''
    })
  })

  it('times out per step.timeoutSeconds', async () => {
    const openCommandPane = vi.fn().mockResolvedValue({ ptyId: 'pty-1', paneKey: 'tab-1:1' })
    let now = 0
    const runner = new RunCommandRunner({
      openCommandPane,
      getPtyExit: () => undefined,
      subscribePtyData: noopSubscribePtyData,
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
      subscribePtyData: noopSubscribePtyData,
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
      subscribePtyData: noopSubscribePtyData,
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
      subscribePtyData: noopSubscribePtyData,
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
      subscribePtyData: noopSubscribePtyData,
      now: () => 0
    })
    await runner.tick(baseCtx({ runId: 'runA' }))
    await runner.tick(baseCtx({ runId: 'runB' }))
    expect(openCommandPane).toHaveBeenCalledTimes(2)
  })

  it('captures PTY output in outputTail and exposes it in step output', async () => {
    const openCommandPane = vi.fn().mockResolvedValue({ ptyId: 'pty-1', paneKey: 'tab-1:1' })
    let now = 0
    const exit: PtyExitEntry = { exitCode: 0, finishedAt: 100 }
    // Capture the listener so the test can drive data into the tail
    // between ticks (mirrors the real flush-window cadence — data lands
    // between ticks, not synchronously inside one).
    let captured: ((ptyId: string, data: string) => void) | null = null
    const subscribePtyData = vi.fn().mockImplementation((listener) => {
      captured = listener
      return () => {}
    })
    const runner = new RunCommandRunner({
      openCommandPane,
      // First tick: still running. Second tick: exited.
      getPtyExit: () => (now > 0 ? exit : undefined),
      subscribePtyData,
      now: () => now
    })
    const ctx = baseCtx()
    await runner.tick(ctx)
    // Simulate PTY data arriving between ticks, including data for a
    // different ptyId that must NOT appear in this step's tail.
    captured!('pty-1', 'hello\n')
    captured!('pty-other', 'should-not-appear')
    captured!('pty-1', 'world\n')
    now = 100
    const result = await runner.tick(ctx)
    expect(result.outcome).toBe('done')
    const output = result.output as {
      exitCode: number
      paneKey: string
      durationMs: number
      outputTail: string
    }
    expect(output.outputTail).toBe('hello\nworld\n')
    expect(result.contextPatch).toEqual({
      steps: {
        'run-review': {
          exitCode: 0,
          paneKey: 'tab-1:1',
          durationMs: 100,
          outputTail: 'hello\nworld\n'
        }
      }
    })
  })

  it('truncates outputTail to 32KiB when output exceeds the cap', async () => {
    const openCommandPane = vi.fn().mockResolvedValue({ ptyId: 'pty-1', paneKey: 'tab-1:1' })
    let now = 0
    const exit: PtyExitEntry = { exitCode: 0, finishedAt: 200 }
    let captured: ((ptyId: string, data: string) => void) | null = null
    const runner = new RunCommandRunner({
      openCommandPane,
      getPtyExit: () => (now > 0 ? exit : undefined),
      subscribePtyData: (listener) => {
        captured = listener
        return () => {}
      },
      now: () => now
    })
    const ctx = baseCtx()
    await runner.tick(ctx)
    // Fire 100 KiB as a single chunk that overshoots the 32 KiB cap. This
    // exercises the OutputTail "single-chunk left-truncate" branch and is a
    // representative case for high-throughput PTY bursts where node-pty
    // flushes a large buffer in one event.
    captured!('pty-1', 'x'.repeat(100 * 1024))
    now = 200
    const result = await runner.tick(ctx)
    const output = result.output as { outputTail: string }
    expect(output.outputTail.length).toBe(32 * 1024)
  })

  it('caps multi-chunk output to at most 32KiB and keeps the latest bytes', async () => {
    const openCommandPane = vi.fn().mockResolvedValue({ ptyId: 'pty-1', paneKey: 'tab-1:1' })
    let now = 0
    const exit: PtyExitEntry = { exitCode: 0, finishedAt: 200 }
    let captured: ((ptyId: string, data: string) => void) | null = null
    const runner = new RunCommandRunner({
      openCommandPane,
      getPtyExit: () => (now > 0 ? exit : undefined),
      subscribePtyData: (listener) => {
        captured = listener
        return () => {}
      },
      now: () => now
    })
    const ctx = baseCtx()
    await runner.tick(ctx)
    // Many small chunks past the cap; verify size invariant + that the
    // very-latest sentinel byte survives at the tail.
    for (let i = 0; i < 40; i++) {
      captured!('pty-1', 'a'.repeat(1024))
    }
    captured!('pty-1', 'TAIL_SENTINEL')
    now = 200
    const result = await runner.tick(ctx)
    const output = result.output as { outputTail: string }
    expect(output.outputTail.length).toBeLessThanOrEqual(32 * 1024)
    expect(output.outputTail.endsWith('TAIL_SENTINEL')).toBe(true)
  })

  it('tears down the subscription on every terminal outcome', async () => {
    // Three terminal paths: done (PTY exit), timed-out, openCommandPaneError.
    // The first two go through cleanup(); the third never opens a tracker
    // (and so never subscribes), so we only assert unsubscribe for the
    // ones that DID subscribe.

    // Path 1: PTY exits → done.
    {
      const openCommandPane = vi.fn().mockResolvedValue({ ptyId: 'pty-1', paneKey: 'tab-1:1' })
      const unsubscribe = vi.fn()
      let now = 0
      const exit: PtyExitEntry = { exitCode: 0, finishedAt: 100 }
      const runner = new RunCommandRunner({
        openCommandPane,
        getPtyExit: () => (now > 0 ? exit : undefined),
        subscribePtyData: () => unsubscribe,
        now: () => now
      })
      const ctx = baseCtx()
      await runner.tick(ctx)
      expect(unsubscribe).not.toHaveBeenCalled() // still running between ticks
      now = 100
      await runner.tick(ctx)
      expect(unsubscribe).toHaveBeenCalledTimes(1)
    }

    // Path 2: step times out → failed.
    {
      const openCommandPane = vi.fn().mockResolvedValue({ ptyId: 'pty-1', paneKey: 'tab-1:1' })
      const unsubscribe = vi.fn()
      let now = 0
      const runner = new RunCommandRunner({
        openCommandPane,
        getPtyExit: () => undefined,
        subscribePtyData: () => unsubscribe,
        now: () => now
      })
      const step: Step = { ...baseStep, timeoutSeconds: 30 }
      const ctx = baseCtx({ step })
      await runner.tick(ctx)
      expect(unsubscribe).not.toHaveBeenCalled()
      now = 30_000
      const result = await runner.tick(ctx)
      expect(result.status).toBe('timed-out')
      expect(unsubscribe).toHaveBeenCalledTimes(1)
    }
  })

  it('keeps the subscription alive across needs-more-time ticks', async () => {
    const openCommandPane = vi.fn().mockResolvedValue({ ptyId: 'pty-1', paneKey: 'tab-1:1' })
    const unsubscribe = vi.fn()
    const runner = new RunCommandRunner({
      openCommandPane,
      getPtyExit: () => undefined,
      subscribePtyData: () => unsubscribe,
      now: () => 0
    })
    const ctx = baseCtx()
    await runner.tick(ctx)
    await runner.tick(ctx)
    await runner.tick(ctx)
    expect(unsubscribe).not.toHaveBeenCalled()
  })

  // Why: regression — a `group:<uuid>` worktreeRef must be unwrapped to a real
  // member worktreeId before openCommandPane sees it; otherwise the renderer
  // returns "Worktree is no longer available" because no worktree carries the
  // group id. Mirrors the same resolution run-prompt-runner already does.
  it("resolves a group: worktreeRef to the group's first member worktreeId", async () => {
    const openCommandPane = vi.fn().mockResolvedValue({ ptyId: 'pty-g', paneKey: 'tab-g:1' })
    const getGroupSummary = vi
      .fn()
      .mockReturnValue({ firstMemberWorktreeId: 'repo-a::/workspaces/g/repo-a' })
    const runner = new RunCommandRunner({
      openCommandPane,
      getPtyExit: () => undefined,
      subscribePtyData: noopSubscribePtyData,
      getGroupSummary,
      now: () => 0
    })
    const step: Step = {
      ...baseStep,
      config: {
        worktreeRef: 'group:abc-1234',
        source: 'review',
        commandId: 'cmd-review-1',
        captureStdout: false
      }
    }
    await runner.tick(baseCtx({ step }))
    expect(getGroupSummary).toHaveBeenCalledWith('group:abc-1234')
    expect(openCommandPane).toHaveBeenCalledWith({
      worktreeId: 'repo-a::/workspaces/g/repo-a',
      source: 'review',
      commandId: 'cmd-review-1',
      customCommand: undefined
    })
  })

  it('fails when a group: worktreeRef does not resolve to a known group', async () => {
    const openCommandPane = vi.fn()
    const runner = new RunCommandRunner({
      openCommandPane,
      getPtyExit: () => undefined,
      subscribePtyData: noopSubscribePtyData,
      getGroupSummary: () => undefined,
      now: () => 0
    })
    const step: Step = {
      ...baseStep,
      config: {
        worktreeRef: 'group:missing',
        source: 'review',
        commandId: 'cmd-review-1',
        captureStdout: false
      }
    }
    const next = await runner.tick(baseCtx({ step }))
    expect(next.outcome).toBe('failed')
    expect(openCommandPane).not.toHaveBeenCalled()
    if (next.outcome === 'failed') {
      expect(next.error).toMatch(/Group not found/)
    }
  })

  it('unwraps a member-scoped ref to the inner worktreeId before opening the pane', async () => {
    const openCommandPane = vi.fn().mockResolvedValue({ ptyId: 'pty-m', paneKey: 'tab-m:1' })
    const runner = new RunCommandRunner({
      openCommandPane,
      getPtyExit: () => undefined,
      subscribePtyData: noopSubscribePtyData,
      now: () => 0
    })
    const step: Step = {
      ...baseStep,
      config: {
        worktreeRef: 'member:group:abc:repo-a::/workspaces/g/repo-a',
        source: 'review',
        commandId: 'cmd-review-1',
        captureStdout: false
      }
    }
    await runner.tick(baseCtx({ step }))
    expect(openCommandPane).toHaveBeenCalledWith({
      worktreeId: 'repo-a::/workspaces/g/repo-a',
      source: 'review',
      commandId: 'cmd-review-1',
      customCommand: undefined,
      // Why: forwards member-scoped intent so the renderer hook threads
      // keepCwd:true to pty.spawn and the agent lands at the member's
      // worktreePath, not the group parent.
      memberScoped: true
    })
  })
})
