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

// Why: groupId is the `group:<uuid>` handle a downstream run-prompt step
// references to address the WorkspaceGroup; parentPath is the shared folder
// at which agents launched against the group land. memberWorktreeIds is the
// ordered string list, exposed as `string` since OutputSchema's leaf types
// are scalar (template authors typically index by `.0`/`.1` via the engine).
export const CREATE_WORKSPACE_GROUP_OUTPUT_SCHEMA: OutputSchema = {
  groupId: 'string',
  parentPath: 'string',
  memberWorktreeIds: 'string'
}

export const WAIT_FOR_SETUP_OUTPUT_SCHEMA: OutputSchema = {
  exitCode: 'number',
  durationMs: 'number'
}

export const RUN_PROMPT_OUTPUT_SCHEMA: OutputSchema = {
  paneKey: 'string',
  durationMs: 'number',
  // Same completion surface as run-command: prefer hook-provided assistant
  // text at runtime, falling back to the captured PTY tail.
  outputTail: 'string'
}

export const RUN_COMMAND_OUTPUT_SCHEMA: OutputSchema = {
  paneKey: 'string',
  exitCode: 'number',
  durationMs: 'number',
  // PTYs emit a single merged stream — see src/main/ipc/pty.ts. We expose the
  // last ~32 KB of that combined output so templates can pattern-match on it.
  outputTail: 'string'
}

// Why: the step's value is the side-effect on Linear (assignee/state change),
// not template-consumable output. The empty schema keeps SCHEMA_BY_KIND
// exhaustive so a new StepKind without a matching schema is a compile error.
export const UPDATE_LINEAR_ISSUE_OUTPUT_SCHEMA: OutputSchema = {}

export const COLLECT_CI_RESULTS_OUTPUT_SCHEMA: OutputSchema = {
  summary: 'string',
  checksJson: 'string',
  commentsJson: 'string',
  failedChecks: 'string',
  hasFailures: 'boolean',
  prCount: 'number'
}

// Placeholder: the http-request step's real output schema is computed dynamically
// from its mapped fields (see getOutputSchemaForStep in D5), not from this static
// map. The empty entry only keeps SCHEMA_BY_KIND exhaustive.
export const HTTP_REQUEST_OUTPUT_SCHEMA: OutputSchema = {}

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

// Nested overlay merged into the trigger schema when a github-pr auto-trigger
// is configured, so steps can template against the PR that fired the run.
export const GITHUB_PR_TRIGGER_OVERLAY = {
  github: {
    pr: {
      number: 'number',
      title: 'string',
      url: 'string',
      headRef: 'string',
      baseRef: 'string',
      author: 'string',
      isCrossRepository: 'boolean',
      repoId: 'string'
    }
  }
} as const

// Record<StepKind, …> makes this map exhaustive: adding a new StepKind
// without extending the map is a compile error.
const SCHEMA_BY_KIND: Record<StepKind, OutputSchema> = {
  'create-worktree': CREATE_WORKTREE_OUTPUT_SCHEMA,
  'create-workspace-group': CREATE_WORKSPACE_GROUP_OUTPUT_SCHEMA,
  'wait-for-setup': WAIT_FOR_SETUP_OUTPUT_SCHEMA,
  'run-prompt': RUN_PROMPT_OUTPUT_SCHEMA,
  'run-command': RUN_COMMAND_OUTPUT_SCHEMA,
  'update-linear-issue': UPDATE_LINEAR_ISSUE_OUTPUT_SCHEMA,
  'collect-ci-results': COLLECT_CI_RESULTS_OUTPUT_SCHEMA,
  'http-request': HTTP_REQUEST_OUTPUT_SCHEMA
}

export function getOutputSchemaForKind(kind: StepKind): OutputSchema {
  return SCHEMA_BY_KIND[kind]
}
