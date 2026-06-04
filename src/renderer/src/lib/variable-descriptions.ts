import type { StepKind } from '../../../shared/automations-types'
import type { PathEntry } from './available-variables-tree'

// UI-only documentation for the automation variable picker. Descriptions are
// not part of the runtime schema (they never vary per instance), so they live
// here rather than in src/shared. The completeness guard in
// variable-descriptions.test.ts fails if a variable gains a leaf without a
// matching description here.

// Static, single-instance paths: automation, trigger (incl. the Linear
// overlay), and the two top-level group fields. Keyed by full dotted path.
const BY_PATH: Record<string, string> = {
  'automation.projectId': 'ID of the project this automation runs in',
  'automation.workspaceId': 'ID of the workspace that owns the project',

  'trigger.firedAt': 'Unix epoch time (ms) the trigger fired',
  'trigger.actorEmail': 'Email of the person who triggered the run',
  'trigger.linear.issue.id': "Linear issue's internal ID",
  'trigger.linear.issue.identifier': 'Human-readable Linear key, e.g. ENG-123',
  'trigger.linear.issue.title': 'Title of the Linear issue',
  'trigger.linear.issue.description': 'Linear issue description (Markdown body)',
  'trigger.linear.issue.url': 'Link to the issue in Linear',
  'trigger.linear.issue.assigneeEmail': "Email of the issue's assignee",
  'trigger.linear.issue.stateName': 'Current workflow state, e.g. In Progress',
  'trigger.linear.issue.priority': 'Priority level (0 none … 4 low)',

  'group.id': 'Handle of the created workspace group',
  'group.parentPath': 'Shared folder all group members live under'
}

// Per-member leaves under `group.members.<repoFolder>.*`. The folder segment is
// dynamic, so these are keyed by leaf name rather than full path.
const GROUP_MEMBER_BY_LEAF: Record<string, string> = {
  worktreeId: "This member's worktree ID",
  path: "Filesystem path of this member's worktree",
  repoId: "ID of this member's repo",
  scoped: 'Group handle scoped to this member',
  description: "This repo's description (empty if none set)"
}

// Step outputs, keyed by step kind then leaf. Keyed by kind (not just leaf)
// because a leaf like `outputTail` means different things for run-prompt vs
// run-command. update-linear-issue has no outputs, so it has no entry.
const STEP_BY_KIND: Partial<Record<StepKind, Record<string, string>>> = {
  'create-worktree': {
    worktreeId: 'ID of the newly created worktree',
    path: 'Filesystem path of the new worktree',
    branch: 'Name of the branch checked out'
  },
  'create-workspace-group': {
    groupId: 'Handle of the created workspace group',
    parentPath: 'Shared folder the group members live under',
    memberWorktreeIds: 'Member worktree IDs (index with .0, .1, …)'
  },
  'wait-for-setup': {
    exitCode: 'Exit code of the setup script (0 = success)',
    durationMs: 'How long setup took, in milliseconds'
  },
  'run-prompt': {
    paneKey: 'Key of the pane the prompt ran in',
    durationMs: 'How long the prompt took, in milliseconds',
    outputTail: "The agent's final response (or captured output tail)"
  },
  'run-command': {
    paneKey: 'Key of the pane the command ran in',
    exitCode: 'Exit code of the command (0 = success)',
    durationMs: 'How long the command took, in milliseconds',
    outputTail: "Last ~32 KB of the command's combined output"
  },
  'collect-ci-results': {
    summary: 'Human-readable summary of the CI results',
    checksJson: 'All CI checks as a JSON string',
    commentsJson: 'PR review comments as a JSON string',
    failedChecks: 'Names of failing checks (comma-separated)',
    hasFailures: 'Whether any CI check failed',
    prCount: 'Number of pull requests inspected'
  }
}

// Returns a one-line description for a variable, or undefined when none exists
// (callers omit the description line in that case).
export function describeVariable(entry: PathEntry): string | undefined {
  if (entry.namespace === 'steps') {
    return entry.kind ? STEP_BY_KIND[entry.kind]?.[entry.leaf] : undefined
  }
  if (entry.namespace === 'group' && entry.path.startsWith('group.members.')) {
    return GROUP_MEMBER_BY_LEAF[entry.leaf]
  }
  return BY_PATH[entry.path]
}
