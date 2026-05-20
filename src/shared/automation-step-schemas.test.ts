import { describe, it, expect, expectTypeOf } from 'vitest'
import {
  getOutputSchemaForKind,
  MANUAL_TRIGGER_SCHEMA,
  CREATE_WORKTREE_OUTPUT_SCHEMA,
  WAIT_FOR_SETUP_OUTPUT_SCHEMA,
  RUN_PROMPT_OUTPUT_SCHEMA,
  RUN_COMMAND_OUTPUT_SCHEMA,
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

  it('run-prompt produces paneKey (string) + durationMs (number)', () => {
    expect(RUN_PROMPT_OUTPUT_SCHEMA).toEqual({
      paneKey: 'string',
      durationMs: 'number'
    })
  })

  it('run-command produces paneKey + exitCode + durationMs', () => {
    expect(RUN_COMMAND_OUTPUT_SCHEMA).toEqual({
      paneKey: 'string',
      exitCode: 'number',
      durationMs: 'number'
    })
  })

  it('MANUAL_TRIGGER_SCHEMA has firedAt (number) + actorEmail (string)', () => {
    expect(MANUAL_TRIGGER_SCHEMA).toEqual({
      firedAt: 'number',
      actorEmail: 'string'
    })
  })

  it('getOutputSchemaForKind returns the schema for each kind', () => {
    expect(getOutputSchemaForKind('create-worktree')).toBe(CREATE_WORKTREE_OUTPUT_SCHEMA)
    expect(getOutputSchemaForKind('wait-for-setup')).toBe(WAIT_FOR_SETUP_OUTPUT_SCHEMA)
    expect(getOutputSchemaForKind('run-prompt')).toBe(RUN_PROMPT_OUTPUT_SCHEMA)
    expect(getOutputSchemaForKind('run-command')).toBe(RUN_COMMAND_OUTPUT_SCHEMA)
  })
})
