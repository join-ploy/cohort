import { describe, it, expect, expectTypeOf } from 'vitest'
import {
  getOutputSchemaForKind,
  GITHUB_PR_TRIGGER_OVERLAY,
  LINEAR_TICKET_TRIGGER_OVERLAY,
  MANUAL_TRIGGER_SCHEMA,
  CREATE_WORKTREE_OUTPUT_SCHEMA,
  WAIT_FOR_SETUP_OUTPUT_SCHEMA,
  RUN_PROMPT_OUTPUT_SCHEMA,
  RUN_COMMAND_OUTPUT_SCHEMA,
  UPDATE_LINEAR_ISSUE_OUTPUT_SCHEMA,
  type SchemaLeafType
} from './automation-step-schemas'

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

describe('GITHUB_PR_TRIGGER_OVERLAY', () => {
  it('exposes pr leaves as scalar schema types', () => {
    expect(GITHUB_PR_TRIGGER_OVERLAY.github.pr.number).toBe('number')
    expect(GITHUB_PR_TRIGGER_OVERLAY.github.pr.headRef).toBe('string')
    expect(GITHUB_PR_TRIGGER_OVERLAY.github.pr.isCrossRepository).toBe('boolean')
  })
})
