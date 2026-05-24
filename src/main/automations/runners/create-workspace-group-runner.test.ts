import { describe, it, expect, vi } from 'vitest'
import type {
  Step,
  StepRunState,
  CreateWorkspaceGroupConfig
} from '../../../shared/automations-types'
import { CreateWorkspaceGroupRunner } from './create-workspace-group-runner'
import type { StepRunnerCtx } from '../step-runner'

const baseConfig: CreateWorkspaceGroupConfig = {
  branchName: 'feature/group-x',
  displayName: 'Group X',
  linkLinearIssue: false,
  members: [
    { repoId: 'repo-a', baseBranch: 'main' },
    { repoId: 'repo-b', baseBranch: 'main' }
  ]
}

const baseStep: Step = {
  id: 'cwg1',
  kind: 'create-workspace-group',
  config: baseConfig,
  onFailure: 'halt',
  timeoutSeconds: null
}

const baseState: StepRunState = {
  stepId: 'cwg1',
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
  context: { automation: { workspaceId: null } },
  ...overrides
})

describe('CreateWorkspaceGroupRunner', () => {
  it('resolves templates and stamps the group result into context.steps', async () => {
    const createWorkspaceGroup = vi.fn().mockResolvedValue({
      groupId: 'group:gid-1',
      memberWorktreeIds: ['repo-a::/p/a', 'repo-b::/p/b'],
      parentPath: '/p/workspaces/feature-group-x'
    })
    const runner = new CreateWorkspaceGroupRunner({ createWorkspaceGroup, now: () => 100 })
    const result = await runner.tick(baseCtx())
    expect(createWorkspaceGroup).toHaveBeenCalledWith({
      branchName: 'feature/group-x',
      displayName: 'Group X',
      members: [
        { repoId: 'repo-a', baseBranch: 'main', setupDecision: 'run' },
        { repoId: 'repo-b', baseBranch: 'main', setupDecision: 'run' }
      ],
      linkedIssue: null,
      createdByAutomationRunId: 'r1'
    })
    expect(result).toMatchObject({
      outcome: 'done',
      status: 'succeeded',
      output: {
        groupId: 'group:gid-1',
        memberWorktreeIds: ['repo-a::/p/a', 'repo-b::/p/b'],
        parentPath: '/p/workspaces/feature-group-x'
      }
    })
    expect(result.contextPatch).toEqual({
      steps: {
        cwg1: {
          groupId: 'group:gid-1',
          memberWorktreeIds: ['repo-a::/p/a', 'repo-b::/p/b'],
          parentPath: '/p/workspaces/feature-group-x'
        }
      },
      // Why: top-level `group.*` shape is published alongside `steps.<id>` so
      // downstream steps can template `{{group.members.<repoFolderName>.*}}`
      // without knowing which step created the group. Each member entry
      // exposes a pre-built `scoped` ref the run-prompt runner recognizes for
      // member-scoped runs (Ask C).
      group: {
        id: 'group:gid-1',
        parentPath: '/p/workspaces/feature-group-x',
        members: {
          a: {
            worktreeId: 'repo-a::/p/a',
            path: '/p/a',
            repoId: 'repo-a',
            scoped: 'member:group:gid-1:repo-a::/p/a',
            // Why: empty string when no getRepoDescription dep is wired —
            // keeps the leaf uniform across members and lets templates
            // referencing `.description` resolve without erroring.
            description: ''
          },
          b: {
            worktreeId: 'repo-b::/p/b',
            path: '/p/b',
            repoId: 'repo-b',
            scoped: 'member:group:gid-1:repo-b::/p/b',
            description: ''
          }
        }
      }
    })
  })

  it('threads Repo.description into the group context when the dep is wired', async () => {
    const createWorkspaceGroup = vi.fn().mockResolvedValue({
      groupId: 'group:gid-desc',
      memberWorktreeIds: ['repo-a::/p/a', 'repo-b::/p/b'],
      parentPath: '/p'
    })
    const runner = new CreateWorkspaceGroupRunner({
      createWorkspaceGroup,
      now: () => 0,
      getRepoDescription: (repoId) => (repoId === 'repo-a' ? 'API server (Go)' : undefined)
    })
    const result = await runner.tick(baseCtx())
    const group = (
      result.contextPatch as { group: { members: Record<string, { description: string }> } }
    ).group
    expect(group.members.a.description).toBe('API server (Go)')
    expect(group.members.b.description).toBe('')
  })

  it('resolves template references from trigger context', async () => {
    const createWorkspaceGroup = vi.fn().mockResolvedValue({
      groupId: 'group:gid-2',
      memberWorktreeIds: ['repo-a::/p/a'],
      parentPath: '/p'
    })
    const runner = new CreateWorkspaceGroupRunner({ createWorkspaceGroup, now: () => 0 })
    const step: Step = {
      ...baseStep,
      config: {
        branchName: 'feature/{{trigger.id}}',
        displayName: '{{trigger.title}}',
        linkLinearIssue: false,
        members: [
          { repoId: 'repo-a', baseBranch: '{{trigger.baseBranch}}' },
          { repoId: 'repo-b', baseBranch: '{{trigger.baseBranch}}' }
        ]
      } satisfies CreateWorkspaceGroupConfig
    }
    await runner.tick(
      baseCtx({
        step,
        context: {
          trigger: { id: 'abc', title: 'Fix X', baseBranch: 'develop' }
        }
      })
    )
    expect(createWorkspaceGroup).toHaveBeenCalledWith({
      branchName: 'feature/abc',
      displayName: 'Fix X',
      members: [
        { repoId: 'repo-a', baseBranch: 'develop', setupDecision: 'run' },
        { repoId: 'repo-b', baseBranch: 'develop', setupDecision: 'run' }
      ],
      linkedIssue: null,
      createdByAutomationRunId: 'r1'
    })
  })

  it('attaches Linear issue when linkLinearIssue=true and trigger has linear data', async () => {
    const createWorkspaceGroup = vi.fn().mockResolvedValue({
      groupId: 'group:gid-3',
      memberWorktreeIds: [],
      parentPath: '/p'
    })
    const runner = new CreateWorkspaceGroupRunner({ createWorkspaceGroup, now: () => 0 })
    const step: Step = { ...baseStep, config: { ...baseConfig, linkLinearIssue: true } }
    await runner.tick(
      baseCtx({
        step,
        context: {
          automation: { workspaceId: null },
          trigger: { linear: { issue: { id: 'LIN-99', title: 'X' } } }
        }
      })
    )
    expect(createWorkspaceGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        linkedIssue: { provider: 'linear', id: 'LIN-99' }
      })
    )
  })

  it('falls back to branchName when displayName is omitted', async () => {
    const createWorkspaceGroup = vi.fn().mockResolvedValue({
      groupId: 'group:gid-4',
      memberWorktreeIds: [],
      parentPath: '/p'
    })
    const runner = new CreateWorkspaceGroupRunner({ createWorkspaceGroup, now: () => 0 })
    const step: Step = {
      ...baseStep,
      config: {
        branchName: 'no-display',
        linkLinearIssue: false,
        members: baseConfig.members
      } satisfies CreateWorkspaceGroupConfig
    }
    await runner.tick(baseCtx({ step }))
    expect(createWorkspaceGroup).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: 'no-display', displayName: 'no-display' })
    )
  })

  it('fails fast when config.members has fewer than 2 entries', async () => {
    const createWorkspaceGroup = vi.fn()
    const runner = new CreateWorkspaceGroupRunner({ createWorkspaceGroup, now: () => 0 })
    const step: Step = {
      ...baseStep,
      config: {
        ...baseConfig,
        members: [{ repoId: 'repo-a', baseBranch: 'main' }]
      }
    }
    const result = await runner.tick(baseCtx({ step }))
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/at least 2 members/)
    expect(createWorkspaceGroup).not.toHaveBeenCalled()
  })

  it('fails fast on TemplateResolutionError', async () => {
    const createWorkspaceGroup = vi.fn()
    const runner = new CreateWorkspaceGroupRunner({ createWorkspaceGroup, now: () => 0 })
    const step: Step = {
      ...baseStep,
      config: { ...baseConfig, branchName: '{{missing.path}}' }
    }
    const result = await runner.tick(baseCtx({ step }))
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/missing\.path/)
    expect(createWorkspaceGroup).not.toHaveBeenCalled()
  })

  it('surfaces createWorkspaceGroup rejection as a failed step (IPC rollback already ran)', async () => {
    const createWorkspaceGroup = vi
      .fn()
      .mockRejectedValue(new Error('member "repo-b" failed — branch already exists'))
    const runner = new CreateWorkspaceGroupRunner({ createWorkspaceGroup, now: () => 0 })
    const result = await runner.tick(baseCtx())
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/repo-b.*branch already exists/)
  })

  it('does not call createWorkspaceGroup again if ticked after the first success', async () => {
    const createWorkspaceGroup = vi.fn().mockResolvedValue({
      groupId: 'group:gid-5',
      memberWorktreeIds: [],
      parentPath: '/p'
    })
    const runner = new CreateWorkspaceGroupRunner({ createWorkspaceGroup, now: () => 0 })
    const r1 = await runner.tick(baseCtx())
    expect(r1.outcome).toBe('done')
    const r2 = await runner.tick(baseCtx())
    expect(r2.outcome).toBe('done')
    expect(createWorkspaceGroup).toHaveBeenCalledTimes(1)
  })
})
