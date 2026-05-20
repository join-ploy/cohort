import type { StepKind } from './automations-types'

export type SchemaLeafType = 'string' | 'number' | 'boolean'
export type OutputSchema = Record<string, SchemaLeafType>

export const CREATE_WORKTREE_OUTPUT_SCHEMA: OutputSchema = {
  worktreeId: 'string',
  path: 'string',
  branch: 'string'
}

export const WAIT_FOR_SETUP_OUTPUT_SCHEMA: OutputSchema = {
  exitCode: 'number',
  durationMs: 'number'
}

export const RUN_PROMPT_OUTPUT_SCHEMA: OutputSchema = {
  paneKey: 'string',
  durationMs: 'number'
}

export const RUN_COMMAND_OUTPUT_SCHEMA: OutputSchema = {
  paneKey: 'string',
  exitCode: 'number',
  durationMs: 'number'
}

export const MANUAL_TRIGGER_SCHEMA: OutputSchema = {
  firedAt: 'number',
  actorEmail: 'string'
}

// Record<StepKind, …> makes this map exhaustive: adding a new StepKind
// without extending the map is a compile error.
const SCHEMA_BY_KIND: Record<StepKind, OutputSchema> = {
  'create-worktree': CREATE_WORKTREE_OUTPUT_SCHEMA,
  'wait-for-setup': WAIT_FOR_SETUP_OUTPUT_SCHEMA,
  'run-prompt': RUN_PROMPT_OUTPUT_SCHEMA,
  'run-command': RUN_COMMAND_OUTPUT_SCHEMA
}

export function getOutputSchemaForKind(kind: StepKind): OutputSchema {
  return SCHEMA_BY_KIND[kind]
}
