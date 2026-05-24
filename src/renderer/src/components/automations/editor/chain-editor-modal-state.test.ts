import { describe, it, expect } from 'vitest'
import type { CreateWorkspaceGroupConfig, Step } from '../../../../../shared/automations-types'
import type { Repo } from '../../../../../shared/types'
import type { ChainDraft } from '../../../lib/chain-editor-state'
import { computeAllErrors, getAvailableVariablesAtStep } from './chain-editor-modal-state'

function makeRepo(id: string, path: string): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: '#000',
    addedAt: 0
  }
}

function makeDraft(steps: Step[]): ChainDraft {
  return {
    id: 'auto-1',
    name: 'auto',
    projectId: 'proj-1',
    trigger: { kind: 'manual' },
    enabled: true,
    steps,
    autoTriggers: []
  }
}

function makeGroupStep(id: string, repoIds: string[]): Step {
  const cfg: CreateWorkspaceGroupConfig = {
    members: repoIds.map((repoId) => ({ repoId, baseBranch: 'main' })),
    branchName: 'feat',
    displayName: ''
  }
  return {
    id,
    kind: 'create-workspace-group',
    config: cfg,
    onFailure: 'halt',
    timeoutSeconds: null
  }
}

describe('getAvailableVariablesAtStep — group namespace', () => {
  it('omits group when no create-workspace-group step exists earlier', () => {
    const draft = makeDraft([
      {
        id: 'cw',
        kind: 'create-worktree',
        config: { baseBranch: 'main', branchName: 'x', displayName: '', linkLinearIssue: false },
        onFailure: 'halt',
        timeoutSeconds: null
      }
    ])
    const out = getAvailableVariablesAtStep(draft, draft.steps.length, [])
    expect(out.group).toBeUndefined()
  })

  it('injects the group namespace when a create-workspace-group step is earlier', () => {
    const repos = [makeRepo('r1', '/repos/orca'), makeRepo('r2', '/repos/forka.git')]
    const draft = makeDraft([makeGroupStep('cg1', ['r1', 'r2'])])
    const out = getAvailableVariablesAtStep(draft, draft.steps.length, repos)
    expect(out.group).toBeDefined()
    expect(out.group?.id).toBe('string')
    expect(out.group?.parentPath).toBe('string')
    const members = out.group?.members as Record<string, unknown>
    // Why: keys mirror buildGroupTemplateContext — basename minus `.git`.
    expect(Object.keys(members).sort()).toEqual(['forka', 'orca'])
  })

  it('still omits group from the create-workspace-group step itself (self-ref guard)', () => {
    const repos = [makeRepo('r1', '/repos/orca'), makeRepo('r2', '/repos/forka')]
    const draft = makeDraft([
      makeGroupStep('cg1', ['r1', 'r2']),
      {
        id: 'rp',
        kind: 'run-prompt',
        config: { worktreeRef: '', agentId: 'claude', prompt: '', doneDebounceSeconds: 5 },
        onFailure: 'halt',
        timeoutSeconds: null
      }
    ])
    // Stepindex 0 (the group step itself) has no prior steps → group undefined.
    const atSelf = getAvailableVariablesAtStep(draft, 0, repos)
    expect(atSelf.group).toBeUndefined()
    // Stepindex 1 (run-prompt after) sees the group namespace.
    const atNext = getAvailableVariablesAtStep(draft, 1, repos)
    expect(atNext.group).toBeDefined()
  })

  it('skips members whose repoId is not in the repos list', () => {
    const repos = [makeRepo('r1', '/repos/orca')]
    const draft = makeDraft([makeGroupStep('cg1', ['r1', 'missing'])])
    const out = getAvailableVariablesAtStep(draft, draft.steps.length, repos)
    const members = out.group?.members as Record<string, unknown>
    expect(Object.keys(members)).toEqual(['orca'])
  })

  it('produces a members-less namespace when the create step has no resolvable members', () => {
    const draft = makeDraft([makeGroupStep('cg1', [])])
    const out = getAvailableVariablesAtStep(draft, draft.steps.length, [])
    expect(out.group).toBeDefined()
    expect(out.group?.id).toBe('string')
    expect(out.group?.parentPath).toBe('string')
    const members = out.group?.members as Record<string, unknown>
    expect(members).toEqual({})
  })

  it('lets computeAllErrors clear errors when group templates resolve against an earlier group step', () => {
    const repos = [makeRepo('r1', '/repos/orca'), makeRepo('r2', '/repos/forka')]
    const draft = makeDraft([
      makeGroupStep('cg1', ['r1', 'r2']),
      {
        id: 'rp',
        kind: 'run-prompt',
        config: {
          worktreeRef: '{{group.members.orca.scoped}}',
          agentId: 'claude',
          prompt: 'in {{group.parentPath}}',
          doneDebounceSeconds: 5
        },
        onFailure: 'halt',
        timeoutSeconds: null
      }
    ])
    const errs = computeAllErrors(draft, repos)
    // Why: with the group namespace plumbed through, both group.* refs should
    // validate — only the missing projectId (if any) would surface elsewhere.
    const groupErrs = errs.filter((e) => e.path.startsWith('group.'))
    expect(groupErrs).toEqual([])
  })

  it('flags group templates when no earlier create-workspace-group step exists', () => {
    const draft = makeDraft([
      {
        id: 'rp',
        kind: 'run-prompt',
        config: {
          worktreeRef: '{{group.members.orca.scoped}}',
          agentId: 'claude',
          prompt: '',
          doneDebounceSeconds: 5
        },
        onFailure: 'halt',
        timeoutSeconds: null
      }
    ])
    const errs = computeAllErrors(draft, [])
    const groupErrs = errs.filter((e) => e.path.startsWith('group.'))
    expect(groupErrs.length).toBeGreaterThan(0)
    expect(groupErrs[0]).toMatchObject({ code: 'unknown-path' })
  })
})
