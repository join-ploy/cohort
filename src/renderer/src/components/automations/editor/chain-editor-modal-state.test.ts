import { describe, it, expect } from 'vitest'
import type {
  AutoTrigger,
  CreateWorkspaceGroupConfig,
  HttpConnection,
  HttpRequestStepConfig,
  MappedField,
  Step,
  StepOrGroup,
  WatchPrConfig
} from '../../../../../shared/automations-types'
import type { Repo } from '../../../../../shared/types'
import type { ChainDraft } from '../../../lib/chain-editor-state'
import type { AvailableVariables } from '../../../lib/template-dry-run'
import {
  STEP_KIND_ORDER,
  buildTriggerSchema,
  chainHasStep,
  chainReferencesAutomationProjectId,
  computeAllErrors,
  defaultConfigForKind,
  getAvailableVariablesAtStep,
  getBranchAvailableVariablesAtStep,
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

  it('offers watch-pr in the add-step palette, grouped after collect-ci-results', () => {
    expect(STEP_KIND_ORDER).toContain('watch-pr')
    expect(STEP_KIND_ORDER.indexOf('watch-pr')).toBe(
      STEP_KIND_ORDER.indexOf('collect-ci-results') + 1
    )
  })
})

describe('defaultConfigForKind — watch-pr', () => {
  it('seeds the watch-pr default config (changes-requested on, empty branch)', () => {
    const cfg = defaultConfigForKind('watch-pr') as WatchPrConfig
    expect(cfg).toEqual({
      worktreeRef: '',
      paneRef: '',
      events: { changesRequested: true, newReviewComments: false, anyReview: false },
      pollIntervalSeconds: 30,
      agentIdleDebounceSeconds: 5,
      failedCycleHaltsLoop: false,
      branchSteps: []
    })
  })

  it('resolves a watch-pr step to the final output schema in the parent chain', () => {
    const draft = makeDraft([
      {
        id: 'watch',
        kind: 'watch-pr',
        config: defaultConfigForKind('watch-pr'),
        onFailure: 'halt',
        timeoutSeconds: null
      },
      {
        id: 'after',
        kind: 'run-prompt',
        config: { worktreeRef: '', agentId: 'claude', prompt: '', doneDebounceSeconds: 5 },
        onFailure: 'halt',
        timeoutSeconds: null
      }
    ])
    // At the downstream step, the watch node exposes its FINAL payload.
    const out = getAvailableVariablesAtStep(draft, 1, [])
    expect(out.steps.watch.finalState).toBe('string')
    expect(out.steps.watch.cyclesRun).toBe('number')
    // The per-cycle-only field must NOT leak into the parent chain.
    expect(out.steps.watch.commentsSummary).toBeUndefined()
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

describe('getAvailableVariablesAtStep — http-request step output schema', () => {
  function httpRequestStep(id: string, fields: MappedField[]): Step {
    return {
      id,
      kind: 'http-request',
      config: {
        request: { method: 'GET', url: 'https://api.test/items', headers: [], query: [] },
        itemsPath: null,
        fields
      },
      onFailure: 'halt',
      timeoutSeconds: null
    }
  }

  it('surfaces an earlier http-request step’s enabled fields as downstream steps.<id>.* vars', () => {
    const draft = makeDraft([
      httpRequestStep('s1', [
        { path: 'id', variableName: 'id', enabled: true, type: 'number', sampleValue: 1 },
        { path: 'name', variableName: 'name', enabled: true, type: 'string', sampleValue: 'x' },
        { path: 'skip', variableName: 'skip', enabled: false, type: 'string', sampleValue: 'y' }
      ]),
      {
        id: 'rp',
        kind: 'run-prompt',
        config: { worktreeRef: '', agentId: 'claude', prompt: '', doneDebounceSeconds: 5 },
        onFailure: 'halt',
        timeoutSeconds: null
      }
    ])
    // At the later run-prompt step, the http-request step's mapped fields are in scope.
    const out = getAvailableVariablesAtStep(draft, 1, [])
    expect(out.steps.s1).toEqual({ id: 'number', name: 'string' })
    expect(out.steps.s1.skip).toBeUndefined()
  })

  it('lets computeAllErrors resolve a downstream {{steps.s1.id}} reference', () => {
    const draft = makeDraft([
      httpRequestStep('s1', [
        { path: 'id', variableName: 'id', enabled: true, type: 'number', sampleValue: 1 }
      ]),
      {
        id: 'rp',
        kind: 'run-prompt',
        config: {
          worktreeRef: 'wt',
          agentId: 'claude',
          prompt: 'id={{steps.s1.id}}',
          doneDebounceSeconds: 5
        },
        onFailure: 'halt',
        timeoutSeconds: null
      }
    ])
    const stepErrs = computeAllErrors(draft, []).filter((e) => e.path.startsWith('steps.'))
    expect(stepErrs).toEqual([])
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

describe('computeAllErrors — http-request test mapping + dangling connections', () => {
  const enabledField: MappedField = {
    path: 'id',
    variableName: 'id',
    enabled: true,
    type: 'string',
    sampleValue: 'a'
  }

  function httpStep(id: string, config: Partial<HttpRequestStepConfig>): Step {
    const cfg: HttpRequestStepConfig = {
      request: { method: 'GET', url: 'https://x', headers: [], query: [] },
      itemsPath: null,
      fields: [enabledField],
      sampleResponse: { id: 'a' },
      ...config
    }
    return { id, kind: 'http-request', config: cfg, onFailure: 'halt', timeoutSeconds: null }
  }

  function httpEndpointTrigger(connectionId?: string): AutoTrigger {
    return {
      id: 'h1',
      source: 'http-endpoint',
      enabled: true,
      enabledAt: 0,
      rules: [],
      http: {
        request: { method: 'GET', url: 'https://x', headers: [], query: [] },
        connectionId,
        itemsPath: null,
        fields: [],
        dedupeFields: [],
        dateGateField: null
      }
    }
  }

  it('requires a Test mapping: flags an http-request step with no sampleResponse', () => {
    const draft = makeDraft([httpStep('s1', { sampleResponse: undefined })])
    const errs = computeAllErrors(draft, [], []).filter(
      (e) => e.stepId === 's1' && e.field === 'fields'
    )
    expect(errs).toHaveLength(1)
    expect(errs[0].message).toMatch(/tested/i)
  })

  it('requires a Test mapping: flags an http-request step with no enabled field', () => {
    const draft = makeDraft([
      httpStep('s1', {
        fields: [{ ...enabledField, enabled: false }]
      })
    ])
    const errs = computeAllErrors(draft, [], []).filter(
      (e) => e.stepId === 's1' && e.field === 'fields'
    )
    expect(errs).toHaveLength(1)
  })

  it('does not flag an http-request step that has a sampleResponse and ≥1 enabled field', () => {
    const draft = makeDraft([httpStep('s1', {})])
    const errs = computeAllErrors(draft, [], []).filter(
      (e) => e.stepId === 's1' && e.field === 'fields'
    )
    expect(errs).toEqual([])
  })

  it('flags an http-request step whose connectionId is not in the library', () => {
    const draft = makeDraft([httpStep('s1', { connectionId: 'gone' })])
    const errs = computeAllErrors(draft, [], []).filter(
      (e) => e.stepId === 's1' && e.field === 'connectionId'
    )
    expect(errs).toHaveLength(1)
    expect(errs[0].message).toMatch(/no longer exists/i)
  })

  it('does not flag an http-request step whose connectionId is present in the library', () => {
    const connections: HttpConnection[] = [
      { id: 'gone', displayName: 'API', baseUrl: 'https://x', headers: [] }
    ]
    const draft = makeDraft([httpStep('s1', { connectionId: 'gone' })])
    const errs = computeAllErrors(draft, [], connections).filter(
      (e) => e.stepId === 's1' && e.field === 'connectionId'
    )
    expect(errs).toEqual([])
  })

  it('flags an http-endpoint trigger whose connectionId is not in the library', () => {
    const draft = { ...makeDraft([]), autoTriggers: [httpEndpointTrigger('gone')] } as ChainDraft
    const errs = computeAllErrors(draft, [], []).filter(
      (e) => e.path === 'autoTriggers.h1.connectionId' && e.field === 'connectionId'
    )
    expect(errs).toHaveLength(1)
    expect(errs[0].message).toMatch(/no longer exists/i)
  })

  it('does not flag an http-endpoint trigger whose connectionId is present in the library', () => {
    const connections: HttpConnection[] = [
      { id: 'gone', displayName: 'API', baseUrl: 'https://x', headers: [] }
    ]
    const draft = { ...makeDraft([]), autoTriggers: [httpEndpointTrigger('gone')] } as ChainDraft
    const errs = computeAllErrors(draft, [], connections).filter((e) => e.field === 'connectionId')
    expect(errs).toEqual([])
  })
})

describe('computeAllErrors — schedule trigger cron validity', () => {
  function scheduleTrigger(cron: string): AutoTrigger {
    return {
      id: 'sched-1',
      source: 'schedule',
      enabled: true,
      enabledAt: 0,
      rules: [],
      schedule: { cron, timezone: 'UTC' }
    }
  }

  it('flags a schedule trigger whose cron is invalid (editor not saveable)', () => {
    const draft = { ...makeDraft([]), autoTriggers: [scheduleTrigger('garbage')] } as ChainDraft
    const errors = computeAllErrors(draft)
    // Editor state is invalid: at least one error blocks save.
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.filter((e) => e.field === 'cron')).toHaveLength(1)
  })

  it('does not flag a schedule trigger whose cron is valid (editor saveable)', () => {
    const draft = { ...makeDraft([]), autoTriggers: [scheduleTrigger('0 9 * * *')] } as ChainDraft
    // Everything else is well-formed, so a valid cron leaves zero errors.
    expect(computeAllErrors(draft)).toEqual([])
  })
})

describe('getBranchAvailableVariablesAtStep — watch-pr branch scope', () => {
  // Parent scope as seen at the watch node: an upstream run-prompt's paneKey is
  // available, mirroring the motivating flow (run-prompt opens a pane → watch).
  const parentAvailable: AvailableVariables = {
    automation: { projectId: 'string', workspaceId: 'string' },
    trigger: {},
    steps: { rp: { paneKey: 'string', durationMs: 'number', outputTail: 'string' } },
    stepKinds: { rp: 'run-prompt' }
  }

  function branchRunPrompt(id: string): Step {
    return {
      id,
      kind: 'run-prompt',
      config: { worktreeRef: '', agentId: 'claude', prompt: '', doneDebounceSeconds: 5 },
      onFailure: 'halt',
      timeoutSeconds: null
    }
  }

  it('maps steps.<watch-id>.* to the PER-CYCLE payload inside the branch', () => {
    const out = getBranchAvailableVariablesAtStep(parentAvailable, 'watch', [], 0)
    // Inside the branch, the watch node resolves to review feedback…
    expect(out.steps.watch.commentsSummary).toBe('string')
    expect(out.steps.watch.reviewBody).toBe('string')
    expect(out.steps.watch.prNumber).toBe('number')
    // …NOT the final output (finalState is parent-scope only).
    expect(out.steps.watch.finalState).toBeUndefined()
    expect(out.stepKinds?.watch).toBe('watch-pr')
  })

  it('keeps the upstream parent variables visible in the branch', () => {
    const out = getBranchAvailableVariablesAtStep(parentAvailable, 'watch', [], 0)
    // The supervised pane the branch targets comes from an upstream run-prompt.
    expect(out.steps.rp.paneKey).toBe('string')
    expect(out.stepKinds?.rp).toBe('run-prompt')
  })

  it('exposes earlier branch steps but not the current or later ones', () => {
    const branchSteps = [branchRunPrompt('b1'), branchRunPrompt('b2'), branchRunPrompt('b3')]
    // At branch flat index 2 (b3), only b1 and b2 are in scope.
    const out = getBranchAvailableVariablesAtStep(parentAvailable, 'watch', branchSteps, 2)
    expect(out.steps.b1).toBeDefined()
    expect(out.steps.b2).toBeDefined()
    expect(out.steps.b3).toBeUndefined()
  })
})

describe('computeAllErrors — no nested watch-pr in branchSteps', () => {
  function watchStep(id: string, branchSteps: StepOrGroup[]): Step {
    return {
      id,
      kind: 'watch-pr',
      config: { ...(defaultConfigForKind('watch-pr') as WatchPrConfig), branchSteps },
      onFailure: 'halt',
      timeoutSeconds: null
    }
  }

  function runCommandStep(id: string): Step {
    return {
      id,
      kind: 'run-command',
      config: defaultConfigForKind('run-command'),
      onFailure: 'halt',
      timeoutSeconds: null
    }
  }

  it('flags a watch-pr whose branchSteps contains another watch-pr', () => {
    const draft = makeDraft([watchStep('outer', [watchStep('inner', [])])])
    const errs = computeAllErrors(draft).filter((e) => e.field === 'branchSteps')
    expect(errs).toHaveLength(1)
    expect(errs[0].stepId).toBe('outer')
    expect(errs[0].message).toMatch(/cannot contain another Watch PR/i)
  })

  it('flags a nested watch-pr even inside a parallel group in branchSteps', () => {
    const draft = makeDraft([watchStep('outer', [[runCommandStep('a'), watchStep('inner', [])]])])
    const errs = computeAllErrors(draft).filter((e) => e.field === 'branchSteps')
    expect(errs).toHaveLength(1)
    expect(errs[0].stepId).toBe('outer')
  })

  it('does not flag a branch with only allowed kinds', () => {
    const draft = makeDraft([watchStep('outer', [runCommandStep('a'), runCommandStep('b')])])
    expect(computeAllErrors(draft).filter((e) => e.field === 'branchSteps')).toEqual([])
  })
})
