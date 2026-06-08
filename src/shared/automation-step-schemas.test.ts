import { describe, it, expect, expectTypeOf } from 'vitest'
import type { HttpRequestStepConfig, MappedField, Step } from './automations-types'
import {
  getOutputSchemaForKind,
  getOutputSchemaForStep,
  GITHUB_PR_TRIGGER_OVERLAY,
  LINEAR_TICKET_TRIGGER_OVERLAY,
  MANUAL_TRIGGER_SCHEMA,
  CREATE_WORKTREE_OUTPUT_SCHEMA,
  WAIT_FOR_SETUP_OUTPUT_SCHEMA,
  RUN_PROMPT_OUTPUT_SCHEMA,
  RUN_COMMAND_OUTPUT_SCHEMA,
  UPDATE_LINEAR_ISSUE_OUTPUT_SCHEMA,
  WATCH_PR_OUTPUT_SCHEMA,
  WATCH_PR_CYCLE_SCHEMA,
  SCHEMA_BY_KIND,
  type SchemaLeafType
} from './automation-step-schemas'

function makeHttpRequestStep(fields: MappedField[]): Step {
  const config: HttpRequestStepConfig = {
    request: { method: 'GET', url: '', headers: [], query: [] },
    itemsPath: null,
    fields
  }
  return { id: 's1', kind: 'http-request', config, onFailure: 'halt', timeoutSeconds: null }
}

describe('automation step schemas', () => {
  it('SchemaLeafType is the union of supported primitives', () => {
    expectTypeOf<SchemaLeafType>().toEqualTypeOf<'string' | 'number' | 'boolean'>()
  })

  it('create-worktree produces worktreeId/path/branch as strings', () => {
    expect(CREATE_WORKTREE_OUTPUT_SCHEMA).toEqual({
      worktreeId: 'string',
      path: 'string',
      branch: 'string'
    })
  })

  it('wait-for-setup produces exitCode + durationMs as numbers', () => {
    expect(WAIT_FOR_SETUP_OUTPUT_SCHEMA).toEqual({
      exitCode: 'number',
      durationMs: 'number'
    })
  })

  it('run-prompt produces paneKey + durationMs + outputTail', () => {
    expect(RUN_PROMPT_OUTPUT_SCHEMA).toEqual({
      paneKey: 'string',
      durationMs: 'number',
      outputTail: 'string'
    })
  })

  it('run-command schema now includes outputTail', () => {
    expect(RUN_COMMAND_OUTPUT_SCHEMA).toEqual({
      paneKey: 'string',
      exitCode: 'number',
      durationMs: 'number',
      outputTail: 'string'
    })
  })

  it('LINEAR_TICKET_TRIGGER_OVERLAY is nested under linear.issue', () => {
    expect(LINEAR_TICKET_TRIGGER_OVERLAY.linear.issue).toMatchObject({
      id: 'string',
      identifier: 'string',
      title: 'string',
      description: 'string',
      url: 'string',
      assigneeEmail: 'string',
      stateName: 'string',
      priority: 'number'
    })
  })

  it('MANUAL_TRIGGER_SCHEMA has firedAt (number) + actorEmail (string)', () => {
    expect(MANUAL_TRIGGER_SCHEMA).toEqual({
      firedAt: 'number',
      actorEmail: 'string'
    })
  })

  it('update-linear-issue schema is empty (no template-consumable output)', () => {
    expect(UPDATE_LINEAR_ISSUE_OUTPUT_SCHEMA).toEqual({})
  })

  it('getOutputSchemaForKind returns the schema for each kind', () => {
    expect(getOutputSchemaForKind('create-worktree')).toBe(CREATE_WORKTREE_OUTPUT_SCHEMA)
    expect(getOutputSchemaForKind('wait-for-setup')).toBe(WAIT_FOR_SETUP_OUTPUT_SCHEMA)
    expect(getOutputSchemaForKind('run-prompt')).toBe(RUN_PROMPT_OUTPUT_SCHEMA)
    expect(getOutputSchemaForKind('run-command')).toBe(RUN_COMMAND_OUTPUT_SCHEMA)
    expect(getOutputSchemaForKind('update-linear-issue')).toBe(UPDATE_LINEAR_ISSUE_OUTPUT_SCHEMA)
  })
})

describe('getOutputSchemaForStep', () => {
  it('computes an http-request step schema from its enabled mapped fields', () => {
    const step = makeHttpRequestStep([
      { variableName: 'id', type: 'number', enabled: true, path: 'id', sampleValue: 0 },
      { variableName: 'name', type: 'string', enabled: true, path: 'name', sampleValue: '' },
      { variableName: 'skip', type: 'string', enabled: false, path: 'skip', sampleValue: '' }
    ])
    // Disabled `skip` is excluded; number maps to 'number', everything else 'string'.
    expect(getOutputSchemaForStep(step)).toEqual({ id: 'number', name: 'string' })
  })

  it('maps non-number, non-string field types to string (mirrors the trigger)', () => {
    const step = makeHttpRequestStep([
      { variableName: 'open', type: 'boolean', enabled: true, path: 'open', sampleValue: true },
      { variableName: 'meta', type: 'json', enabled: true, path: 'meta', sampleValue: {} }
    ])
    expect(getOutputSchemaForStep(step)).toEqual({ open: 'string', meta: 'string' })
  })

  it('delegates to getOutputSchemaForKind for a non-http-request step', () => {
    const step: Step = {
      id: 'cw',
      kind: 'create-worktree',
      config: { baseBranch: 'main', branchName: 'x', displayName: '', linkLinearIssue: false },
      onFailure: 'halt',
      timeoutSeconds: null
    }
    expect(getOutputSchemaForStep(step)).toEqual(getOutputSchemaForKind('create-worktree'))
  })
})

describe('watch-pr schema', () => {
  it('registers the full final-output schema for watch-pr', () => {
    // Lock the whole contract so a field-name/type typo is caught before the
    // runner (Task 9) and editor (Task 13) build against it.
    expect(SCHEMA_BY_KIND['watch-pr']).toBe(WATCH_PR_OUTPUT_SCHEMA)
    expect(WATCH_PR_OUTPUT_SCHEMA).toEqual({
      finalState: 'string',
      cyclesRun: 'number',
      prNumber: 'number',
      prUrl: 'string',
      finishedAt: 'number'
    })
  })

  it('exposes the full per-cycle (branch-scope) schema, not registered in SCHEMA_BY_KIND', () => {
    expect(WATCH_PR_CYCLE_SCHEMA).toEqual({
      prNumber: 'number',
      prUrl: 'string',
      prTitle: 'string',
      reviewState: 'string',
      reviewAuthor: 'string',
      reviewBody: 'string',
      commentsJson: 'string',
      commentsSummary: 'string',
      cycleIndex: 'number',
      changeRequestCount: 'number'
    })
  })
})

describe('GITHUB_PR_TRIGGER_OVERLAY', () => {
  it('exposes pr leaves as scalar schema types', () => {
    expect(GITHUB_PR_TRIGGER_OVERLAY.github.pr.number).toBe('number')
    expect(GITHUB_PR_TRIGGER_OVERLAY.github.pr.headRef).toBe('string')
    expect(GITHUB_PR_TRIGGER_OVERLAY.github.pr.isCrossRepository).toBe('boolean')
  })
})
