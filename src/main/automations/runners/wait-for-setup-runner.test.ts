import { describe, it, expect, vi } from 'vitest'
import type { Step, StepRunState, WaitForSetupConfig } from '../../../shared/automations-types'
import { WaitForSetupRunner } from './wait-for-setup-runner'
import type { StepRunnerCtx } from '../step-runner'
import type { SetupScriptEntry } from '../../setup-script/registry'
import type { WorkspaceGroup } from '../../../shared/types'
import { buildMemberScopedRef } from '../../../shared/automation-member-scoped-ref'

const baseConfig: WaitForSetupConfig = {
  worktreeRef: 'wt-1',
  requireSuccess: true
}

const baseStep: Step = {
  id: 'wfs1',
  kind: 'wait-for-setup',
  config: baseConfig,
  onFailure: 'halt',
  timeoutSeconds: null
}

const baseState: StepRunState = {
  stepId: 'wfs1',
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

const makeGroup = (overrides: Partial<WorkspaceGroup> = {}): WorkspaceGroup => ({
  id: 'group:abc',
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
})

describe('WaitForSetupRunner', () => {
  it('returns needs-more-time when the setup script is running', async () => {
    const entry: SetupScriptEntry = {
      state: 'running',
      exitCode: null,
      startedAt: 100,
      finishedAt: null
    }
    const getSetupScript = vi.fn().mockReturnValue(entry)
    const runner = new WaitForSetupRunner({ getSetupScript, now: () => 200 })
    const result = await runner.tick(baseCtx())
    expect(result.outcome).toBe('needs-more-time')
    expect(result.status).toBe('running')
  })

  it('returns done when the setup script exited successfully', async () => {
    const entry: SetupScriptEntry = {
      state: 'exited-success',
      exitCode: 0,
      startedAt: 100,
      finishedAt: 300
    }
    const getSetupScript = vi.fn().mockReturnValue(entry)
    const runner = new WaitForSetupRunner({ getSetupScript, now: () => 400 })
    const result = await runner.tick(baseCtx())
    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')
    expect(result.output).toEqual({ exitCode: 0, durationMs: 200 })
  })

  it('fails when setup exited with failure and requireSuccess=true', async () => {
    const entry: SetupScriptEntry = {
      state: 'exited-failure',
      exitCode: 1,
      startedAt: 100,
      finishedAt: 300
    }
    const getSetupScript = vi.fn().mockReturnValue(entry)
    const runner = new WaitForSetupRunner({ getSetupScript, now: () => 400 })
    const result = await runner.tick(baseCtx())
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/exit code 1/)
  })

  it('succeeds even on failure when requireSuccess=false', async () => {
    const entry: SetupScriptEntry = {
      state: 'exited-failure',
      exitCode: 2,
      startedAt: 100,
      finishedAt: 300
    }
    const getSetupScript = vi.fn().mockReturnValue(entry)
    const runner = new WaitForSetupRunner({ getSetupScript, now: () => 400 })
    const step: Step = { ...baseStep, config: { worktreeRef: 'wt-1', requireSuccess: false } }
    const result = await runner.tick(baseCtx({ step }))
    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')
    expect(result.output).toEqual({ exitCode: 2, durationMs: 200 })
  })

  it('treats missing registry entry as "no setup script configured" and resolves immediately', async () => {
    const getSetupScript = vi.fn().mockReturnValue(undefined)
    const runner = new WaitForSetupRunner({ getSetupScript, now: () => 100 })
    const result = await runner.tick(baseCtx())
    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')
    expect(result.output).toEqual({ exitCode: 0, durationMs: 0 })
  })

  it('times out per step.timeoutSeconds', async () => {
    const entry: SetupScriptEntry = {
      state: 'running',
      exitCode: null,
      startedAt: 100,
      finishedAt: null
    }
    const getSetupScript = vi.fn().mockReturnValue(entry)
    const step: Step = { ...baseStep, timeoutSeconds: 10 }
    // Use a single runner with a mutable mock clock so openedAt is recorded
    // on the first tick (now=0) and the second tick (now=11_000) trips the
    // 10s timeout. Two ticks against the same (runId, stepId) is required
    // because the runner records openedAt the first time it sees a step.
    let mockNow = 0
    const runner = new WaitForSetupRunner({ getSetupScript, now: () => mockNow })
    mockNow = 0
    await runner.tick(baseCtx({ step }))
    mockNow = 11_000
    const result = await runner.tick(baseCtx({ step }))
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('timed-out')
  })

  it('fails fast on TemplateResolutionError', async () => {
    const getSetupScript = vi.fn()
    const runner = new WaitForSetupRunner({ getSetupScript, now: () => 0 })
    const step: Step = {
      ...baseStep,
      config: { worktreeRef: '{{missing.path}}', requireSuccess: true }
    }
    const result = await runner.tick(baseCtx({ step }))
    expect(result.outcome).toBe('failed')
    expect(result.error).toMatch(/missing\.path/)
    expect(getSetupScript).not.toHaveBeenCalled()
  })

  // ─── group:<id> branch (grouped-workspaces) ──────────────────────────────
  describe('with a group:<id> worktreeRef', () => {
    const groupStep = (overrides: Partial<WaitForSetupConfig> = {}): Step => ({
      ...baseStep,
      config: { worktreeRef: 'group:abc', requireSuccess: true, ...overrides }
    })

    it('returns done when every group member exited-success (max durationMs, worst exitCode)', async () => {
      const group = makeGroup()
      const entries: Record<string, SetupScriptEntry> = {
        'repo-a::/ws/feat-x/repo-a': {
          state: 'exited-success',
          exitCode: 0,
          startedAt: 100,
          finishedAt: 200 // 100ms
        },
        'repo-b::/ws/feat-x/repo-b': {
          state: 'exited-success',
          exitCode: 0,
          startedAt: 100,
          finishedAt: 400 // 300ms
        }
      }
      const runner = new WaitForSetupRunner({
        getSetupScript: (id) => entries[id],
        getWorkspaceGroups: () => [group],
        now: () => 500
      })
      const result = await runner.tick(baseCtx({ step: groupStep() }))
      expect(result.outcome).toBe('done')
      expect(result.status).toBe('succeeded')
      expect(result.output).toEqual({ exitCode: 0, durationMs: 300 })
    })

    it('returns needs-more-time when any group member is still running', async () => {
      const group = makeGroup()
      const entries: Record<string, SetupScriptEntry> = {
        'repo-a::/ws/feat-x/repo-a': {
          state: 'exited-success',
          exitCode: 0,
          startedAt: 100,
          finishedAt: 200
        },
        'repo-b::/ws/feat-x/repo-b': {
          state: 'running',
          exitCode: null,
          startedAt: 100,
          finishedAt: null
        }
      }
      const runner = new WaitForSetupRunner({
        getSetupScript: (id) => entries[id],
        getWorkspaceGroups: () => [group],
        now: () => 500
      })
      const result = await runner.tick(baseCtx({ step: groupStep() }))
      expect(result.outcome).toBe('needs-more-time')
      expect(result.status).toBe('running')
    })

    it('returns needs-more-time when any group member is still pending', async () => {
      const group = makeGroup()
      const entries: Record<string, SetupScriptEntry> = {
        'repo-a::/ws/feat-x/repo-a': {
          state: 'pending',
          exitCode: null,
          startedAt: null,
          finishedAt: null
        },
        'repo-b::/ws/feat-x/repo-b': {
          state: 'exited-success',
          exitCode: 0,
          startedAt: 100,
          finishedAt: 200
        }
      }
      const runner = new WaitForSetupRunner({
        getSetupScript: (id) => entries[id],
        getWorkspaceGroups: () => [group],
        now: () => 500
      })
      const result = await runner.tick(baseCtx({ step: groupStep() }))
      expect(result.outcome).toBe('needs-more-time')
      expect(result.status).toBe('running')
    })

    it('fails with a descriptive error when any member exited-failure and requireSuccess=true', async () => {
      const group = makeGroup()
      const entries: Record<string, SetupScriptEntry> = {
        'repo-a::/ws/feat-x/repo-a': {
          state: 'exited-success',
          exitCode: 0,
          startedAt: 100,
          finishedAt: 200
        },
        'repo-b::/ws/feat-x/repo-b': {
          state: 'exited-failure',
          exitCode: 7,
          startedAt: 100,
          finishedAt: 300
        }
      }
      const runner = new WaitForSetupRunner({
        getSetupScript: (id) => entries[id],
        getWorkspaceGroups: () => [group],
        now: () => 500
      })
      const result = await runner.tick(baseCtx({ step: groupStep() }))
      expect(result.outcome).toBe('failed')
      expect(result.status).toBe('failed')
      expect(result.error).toMatch(/repo-b::\/ws\/feat-x\/repo-b/)
      expect(result.error).toMatch(/exit code 7/)
    })

    it('succeeds (worst exitCode) when a member exited-failure but requireSuccess=false', async () => {
      const group = makeGroup()
      const entries: Record<string, SetupScriptEntry> = {
        'repo-a::/ws/feat-x/repo-a': {
          state: 'exited-success',
          exitCode: 0,
          startedAt: 100,
          finishedAt: 200
        },
        'repo-b::/ws/feat-x/repo-b': {
          state: 'exited-failure',
          exitCode: 3,
          startedAt: 100,
          finishedAt: 250
        }
      }
      const runner = new WaitForSetupRunner({
        getSetupScript: (id) => entries[id],
        getWorkspaceGroups: () => [group],
        now: () => 500
      })
      const result = await runner.tick(baseCtx({ step: groupStep({ requireSuccess: false }) }))
      expect(result.outcome).toBe('done')
      expect(result.status).toBe('succeeded')
      // durationMs = max(member durations); exitCode = worst non-zero
      expect(result.output).toEqual({ exitCode: 3, durationMs: 150 })
    })

    it('treats a member with no registry entry as "no script configured" — does not block the wait', async () => {
      const group = makeGroup()
      const entries: Record<string, SetupScriptEntry | undefined> = {
        'repo-a::/ws/feat-x/repo-a': {
          state: 'exited-success',
          exitCode: 0,
          startedAt: 100,
          finishedAt: 200
        },
        // repo-b never queued: returns undefined
        'repo-b::/ws/feat-x/repo-b': undefined
      }
      const runner = new WaitForSetupRunner({
        getSetupScript: (id) => entries[id],
        getWorkspaceGroups: () => [group],
        now: () => 500
      })
      const result = await runner.tick(baseCtx({ step: groupStep() }))
      expect(result.outcome).toBe('done')
      expect(result.status).toBe('succeeded')
      expect(result.output).toEqual({ exitCode: 0, durationMs: 100 })
    })

    it('fails with a clear error when the group id does not exist in the store', async () => {
      const runner = new WaitForSetupRunner({
        getSetupScript: () => undefined,
        getWorkspaceGroups: () => [],
        now: () => 0
      })
      const step: Step = {
        ...baseStep,
        config: { worktreeRef: 'group:missing', requireSuccess: true }
      }
      const result = await runner.tick(baseCtx({ step }))
      expect(result.outcome).toBe('failed')
      expect(result.status).toBe('failed')
      expect(result.error).toMatch(/Group not found.*group:missing/)
    })
  })

  // ─── member-scoped branch (Ask C) ─────────────────────────────────────────
  it('waits for just one member when given a member-scoped ref', async () => {
    const memberWorktreeId = 'repo-a::/ws/feat-x/repo-a'
    const memberRef = buildMemberScopedRef('group:abc', memberWorktreeId)
    // Only that one member's entry is returned — other group members' entries
    // are irrelevant because the scope is narrowed to this member.
    const entry: SetupScriptEntry = {
      state: 'exited-success',
      exitCode: 0,
      startedAt: 100,
      finishedAt: 350
    }
    const getSetupScript = vi.fn((id: string) => (id === memberWorktreeId ? entry : undefined))
    const getWorkspaceGroups = vi.fn() // must NOT be called for member-scoped refs
    const runner = new WaitForSetupRunner({
      getSetupScript,
      getWorkspaceGroups,
      now: () => 500
    })
    const step: Step = {
      ...baseStep,
      config: { worktreeRef: memberRef, requireSuccess: true }
    }
    const result = await runner.tick(baseCtx({ step }))
    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')
    expect(result.output).toEqual({ exitCode: 0, durationMs: 250 })
    expect(getSetupScript).toHaveBeenCalledWith(memberWorktreeId)
    expect(getWorkspaceGroups).not.toHaveBeenCalled()
  })
})
