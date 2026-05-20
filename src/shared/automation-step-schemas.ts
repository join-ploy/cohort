import type { StepKind } from './automations-types'

export type SchemaLeafType = 'string' | 'number' | 'boolean'
export type OutputSchema = Record<string, SchemaLeafType>
// Superset of OutputSchema used only by the trigger namespace: trigger paths
// can nest (`trigger.linear.issue.title`) whereas step outputs are flat.
export type NestedSchema = {
  [key: string]: SchemaLeafType | NestedSchema
}

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
  durationMs: 'number',
  // PTYs emit a single merged stream — see src/main/ipc/pty.ts. We expose the
  // last ~32 KB of that combined output so templates can pattern-match on it.
  outputTail: 'string'
}

export const MANUAL_TRIGGER_SCHEMA: OutputSchema = {
  firedAt: 'number',
  actorEmail: 'string'
}

// Nested overlay merged into the trigger schema when the automation accepts a
// Linear ticket at manual-trigger time. Keeps the canonical Linear shape under
// `linear.issue.*` so additional Linear namespaces (e.g. project) stay open.
export const LINEAR_TICKET_TRIGGER_OVERLAY = {
  linear: {
    issue: {
      id: 'string',
      identifier: 'string',
      title: 'string',
      description: 'string',
      url: 'string',
      assigneeEmail: 'string',
      stateName: 'string',
      priority: 'number'
    }
  }
} as const

// Flat overlay merged into the trigger schema when the automation accepts a
// worktree selection at manual-trigger time.
export const WORKTREE_TRIGGER_OVERLAY: OutputSchema = {
  worktreeId: 'string',
  worktreeBranch: 'string',
  worktreePath: 'string'
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
