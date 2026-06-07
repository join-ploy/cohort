import { describe, it, expect } from 'vitest'
import type {
  AutoTrigger,
  CreateWorkspaceGroupConfig,
  MappedField,
  Step,
  StepOrGroup
} from '../../../../../shared/automations-types'
import type { Repo } from '../../../../../shared/types'
import type { ChainDraft } from '../../../lib/chain-editor-state'
import {
  STEP_KIND_ORDER,
  buildTriggerSchema,
  chainHasStep,
  chainReferencesAutomationProjectId,
  computeAllErrors,
  getAvailableVariablesAtStep,
  isProjectRequired
} from './chain-editor-modal-state'

function makeRepo(id: string, path: string): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: '#000',
    addedAt: 0
  }
}

function makeDraft(steps: StepOrGroup[]): ChainDraft {
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

describe('STEP_KIND_ORDER', () => {
  it('keeps run-command out of the add-step palette', () => {
    // Why: run-command is still renderable for legacy chains, but new chains
    // should use run-prompt with stored prompt/agent presets instead.
    expect(STEP_KIND_ORDER).not.toContain('run-command')
  })
})

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
    const members = out.group?.members as Record<string, Record<string, unknown>>
    // Why: keys mirror buildGroupTemplateContext — basename minus `.git`.
    expect(Object.keys(members).sort()).toEqual(['forka', 'orca'])
    // Why: per-member schema exposes `description` as a discoverable string
    // leaf so AvailableVariables surfaces it and the dry-run validator
    // accepts `group.members.<repo>.description`.
    expect(Object.keys(members.orca).sort()).toEqual([
      'description',
      'path',
      'repoId',
      'scoped',
      'worktreeId'
    ])
    expect(members.orca.description).toBe('string')
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

describe('getAvailableVariablesAtStep — github.pr overlay', () => {
  it('overlays github.pr.* when an enabled github-pr auto-trigger exists', () => {
    const draft = {
      ...makeDraft([]),
      autoTriggers: [
        { id: 't', source: 'github-pr', enabled: true, enabledAt: 0, rules: [], repoIds: ['r1'] }
      ]
    } as ChainDraft
    const out = getAvailableVariablesAtStep(draft, 0, [])
    expect(
      (out.trigger as Record<string, Record<string, Record<string, string>>>).github.pr.headRef
    ).toBe('string')
  })

  it('does NOT overlay github.pr.* when the github-pr auto-trigger is disabled', () => {
    const draft = {
      ...makeDraft([]),
      autoTriggers: [
        { id: 't', source: 'github-pr', enabled: false, enabledAt: 0, rules: [], repoIds: [] }
      ]
    } as ChainDraft
    const out = getAvailableVariablesAtStep(draft, 0, [])
    expect((out.trigger as Record<string, unknown>).github).toBeUndefined()
  })
})

describe('buildTriggerSchema — trigger.http.* overlay from saved fields', () => {
  function httpTrigger(fields: MappedField[]): AutoTrigger {
    return {
      id: 'h1',
      source: 'http-endpoint',
      enabled: true,
      enabledAt: 0,
      rules: [],
      http: {
        request: { method: 'GET', url: 'https://api.test/items', headers: [], query: [] },
        itemsPath: 'data',
        fields,
        dedupeFields: [],
        dateGateField: null
      }
    }
  }

  // Enabled id:number + title:string surface; the disabled field must not.
  const fields: MappedField[] = [
    { path: 'id', variableName: 'id', enabled: true, type: 'number', sampleValue: 1 },
    { path: 'title', variableName: 'title', enabled: true, type: 'string', sampleValue: 'x' },
    { path: 'ignored', variableName: 'ignored', enabled: false, type: 'string', sampleValue: 'y' }
  ]

  it('folds enabled mapped fields into a flat http schema with mapped leaf types', () => {
    const schema = buildTriggerSchema({ kind: 'manual' }, [httpTrigger(fields)])
    expect(schema.http).toEqual({ id: 'number', title: 'string' })
  })

  it('maps non-number field types to string leaves', () => {
    const schema = buildTriggerSchema({ kind: 'manual' }, [
      httpTrigger([
        { path: 'open', variableName: 'open', enabled: true, type: 'boolean', sampleValue: true },
        { path: 'at', variableName: 'at', enabled: true, type: 'date', sampleValue: '2026-06-06' }
      ])
    ])
    expect(schema.http).toEqual({ open: 'string', at: 'string' })
  })

  it('surfaces trigger.http.* via getAvailableVariablesAtStep and omits disabled fields', () => {
    const draft = { ...makeDraft([]), autoTriggers: [httpTrigger(fields)] } as ChainDraft
    const out = getAvailableVariablesAtStep(draft, 0, [])
    const http = (out.trigger as Record<string, Record<string, string>>).http
    expect(http.id).toBe('number')
    expect(http.title).toBe('string')
    expect(http.ignored).toBeUndefined()
  })

  it('lets computeAllErrors resolve a {{trigger.http.id}} reference', () => {
    const draft = {
      ...makeDraft([
        {
          id: 'rp',
          kind: 'run-prompt',
          config: {
            worktreeRef: 'wt',
            agentId: 'claude',
            prompt: 'id={{trigger.http.id}}',
            doneDebounceSeconds: 5
          },
          onFailure: 'halt',
          timeoutSeconds: null
        }
      ]),
      autoTriggers: [httpTrigger(fields)]
    } as ChainDraft
    const triggerErrs = computeAllErrors(draft, []).filter((e) => e.path.startsWith('trigger.'))
    expect(triggerErrs).toEqual([])
  })
})

describe('getAvailableVariablesAtStep — stepKinds', () => {
  it('maps each in-scope step id to its kind', () => {
    const draft = makeDraft([
      {
        id: 'cw',
        kind: 'create-worktree',
        config: { baseBranch: 'main', branchName: 'x', displayName: '', linkLinearIssue: false },
        onFailure: 'halt',
        timeoutSeconds: null
      },
      {
        id: 'rp',
        kind: 'run-prompt',
        config: { worktreeRef: '', agentId: 'claude', prompt: '', doneDebounceSeconds: 5 },
        onFailure: 'halt',
        timeoutSeconds: null
      }
    ])
    const out = getAvailableVariablesAtStep(draft, draft.steps.length, [])
    expect(out.stepKinds).toEqual({ cw: 'create-worktree', rp: 'run-prompt' })
  })

  it('only includes kinds for steps in scope (excludes the current and later steps)', () => {
    const draft = makeDraft([
      {
        id: 'cw',
        kind: 'create-worktree',
        config: { baseBranch: 'main', branchName: 'x', displayName: '', linkLinearIssue: false },
        onFailure: 'halt',
        timeoutSeconds: null
      },
      {
        id: 'rp',
        kind: 'run-prompt',
        config: { worktreeRef: '', agentId: 'claude', prompt: '', doneDebounceSeconds: 5 },
        onFailure: 'halt',
        timeoutSeconds: null
      }
    ])
    // At step index 1 (the run-prompt), only the earlier create-worktree is in scope.
    const out = getAvailableVariablesAtStep(draft, 1, [])
    expect(out.stepKinds).toEqual({ cw: 'create-worktree' })
  })
})

describe('computeAllErrors — step ids', () => {
  it('rejects duplicate ids inside a parallel group', () => {
    const step: Step = {
      id: 'review',
      kind: 'run-prompt',
      config: {
        worktreeRef: 'wt-1',
        agentId: 'claude',
        prompt: 'Review',
        doneDebounceSeconds: 5
      },
      onFailure: 'halt',
      timeoutSeconds: null
    }
    const draft = makeDraft([
      [
        step,
        {
          ...step,
          kind: 'run-command',
          config: {
            worktreeRef: 'wt-1',
            source: 'custom',
            customCommand: 'echo hi',
            captureStdout: false
          }
        }
      ]
    ])

    const errors = computeAllErrors(draft).filter((error) => error.field === 'id')
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toMatch(/used more than once/)
  })
})

describe('isProjectRequired + projectId gating', () => {
  function emptyProjectDraft(steps: Step[]): ChainDraft {
    return { ...makeDraft(steps), projectId: '' }
  }

  it('is not required for an empty chain (no consumer of automation.projectId)', () => {
    expect(isProjectRequired(emptyProjectDraft([]))).toBe(false)
    expect(
      computeAllErrors(emptyProjectDraft([]), []).filter((e) => e.field === 'projectId')
    ).toEqual([])
  })

  it('is required when the chain contains a create-worktree step', () => {
    const draft = emptyProjectDraft([
      {
        id: 'cw',
        kind: 'create-worktree',
        config: { baseBranch: 'main', branchName: 'x', displayName: '', linkLinearIssue: false },
        onFailure: 'halt',
        timeoutSeconds: null
      }
    ])
    expect(isProjectRequired(draft)).toBe(true)
    const errs = computeAllErrors(draft, []).filter((e) => e.field === 'projectId')
    expect(errs).toHaveLength(1)
    expect(errs[0].message).toMatch(/create-worktree/i)
  })

  it('is not required when the only creator is a create-workspace-group step', () => {
    const repos = [makeRepo('r1', '/repos/orca'), makeRepo('r2', '/repos/forka')]
    const draft = emptyProjectDraft([makeGroupStep('cg1', ['r1', 'r2'])])
    expect(isProjectRequired(draft)).toBe(false)
    expect(computeAllErrors(draft, repos).filter((e) => e.field === 'projectId')).toEqual([])
  })

  it('is required when a run-prompt template references {{automation.projectId}}', () => {
    const draft = emptyProjectDraft([
      {
        id: 'rp',
        kind: 'run-prompt',
        config: {
          // Why: the runner resolves this against context.automation.projectId,
          // which is empty when the upfront field is unset. Surface a specific
          // error so the operator knows the template is the reason.
          worktreeRef: 'wt-1',
          agentId: 'claude',
          prompt: 'in {{automation.projectId}}',
          doneDebounceSeconds: 5
        },
        onFailure: 'halt',
        timeoutSeconds: null
      }
    ])
    expect(chainReferencesAutomationProjectId(draft)).toBe(true)
    expect(isProjectRequired(draft)).toBe(true)
    const errs = computeAllErrors(draft, []).filter((e) => e.field === 'projectId')
    expect(errs).toHaveLength(1)
    expect(errs[0].message).toMatch(/automation\.projectId/)
  })

  it('is NOT required when acceptsProjectSelection is true (picked at run time)', () => {
    const draft = emptyProjectDraft([
      {
        id: 'cw',
        kind: 'create-worktree',
        config: { baseBranch: 'main', branchName: 'x', displayName: '', linkLinearIssue: false },
        onFailure: 'halt',
        timeoutSeconds: null
      }
    ])
    draft.trigger = { kind: 'manual', acceptsProjectSelection: true }
    expect(isProjectRequired(draft)).toBe(false)
    expect(computeAllErrors(draft, []).filter((e) => e.field === 'projectId')).toEqual([])
  })

  it('chainHasStep is true only when the kind is present', () => {
    const repos = [makeRepo('r1', '/repos/orca'), makeRepo('r2', '/repos/forka')]
    const draft = makeDraft([makeGroupStep('cg1', ['r1', 'r2'])])
    expect(chainHasStep(draft, 'create-workspace-group')).toBe(true)
    expect(chainHasStep(draft, 'create-worktree')).toBe(false)
    void repos
  })
})
