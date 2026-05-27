# Collect CI Results — Automation Step Design

## Goal

Add a `collect-ci-results` step kind that waits for CI to complete on one or more PRs and collects check results + PR comments/reviews, making the data available as template variables for downstream `run-prompt` steps.

## Step Config

```typescript
type CollectCiResultsConfig = {
  worktreeRef: string          // template — single worktree ID or group:<uuid>
  pollIntervalSeconds: number  // default 30
  includeComments: boolean     // default true
}
```

- **worktreeRef**: Resolved via the standard template system. Supports single worktree IDs and `group:<uuid>` refs. For groups, the runner filters to members with changes from main (members with no diff won't have PRs and are skipped).
- **pollIntervalSeconds**: How often `tick()` re-checks for PR linkage and CI completion.
- **includeComments**: When true, fetches PR conversation comments + inline review threads alongside checks.

## Behavior

The runner uses the `needs-more-time` pattern (like `wait-for-setup`). Internal phases:

1. **resolving-targets** — Expand worktreeRef to worktree(s). For groups, get all member worktrees and filter out those with no changes from main. Transition to `waiting-for-prs`.
2. **waiting-for-prs** — Poll each eligible worktree for a linked GitHub PR. Once all expected PRs are found, transition to `waiting-for-ci`. Returns `needs-more-time` while any expected PR is missing.
3. **waiting-for-ci** — Call `getPRChecks()` for each PR. Once every check run has `status: 'completed'`, transition to `collecting`. Returns `needs-more-time` while any check is `queued` or `in_progress`.
4. **collecting** — Fetch final check details + comments (if enabled). Build output fields. Return `done`.

The step always succeeds once it collects data — CI check failures do not fail the step. Downstream steps use `{{steps.<id>.hasFailures}}` to branch on CI outcome.

## Output Schema

```typescript
export const COLLECT_CI_RESULTS_OUTPUT_SCHEMA: OutputSchema = {
  summary: 'string',
  checksJson: 'string',
  commentsJson: 'string',
  failedChecks: 'string',
  hasFailures: 'boolean',
  prCount: 'number',
}
```

| Field | Description |
|-------|-------------|
| `summary` | Markdown report: per-PR sections with a check pass/fail table + comments. Ready to inject into a prompt. |
| `checksJson` | JSON string — `Array<{ prNumber, repoName, checks: PRCheckDetail[] }>` |
| `commentsJson` | JSON string — `Array<{ prNumber, repoName, comments: PRComment[] }>` (empty array when `includeComments` is false) |
| `failedChecks` | Comma-separated names of checks that concluded with `failure`, `timed_out`, or `cancelled` |
| `hasFailures` | `true` if any check across all PRs has a failing conclusion |
| `prCount` | Number of PRs the step collected results for |

### Summary format example

```markdown
## PR #42 (my-repo) — 2 failed, 8 passed

### Checks
| Check | Status |
|-------|--------|
| lint | success |
| unit-tests | failure |
| build | success |

### Comments (3)
**@reviewer** (inline: src/foo.ts:42):
> This function doesn't handle the null case

**@bot** (conversation):
> Coverage decreased by 2.1%
```

## Runner Implementation

**File**: `src/main/automations/runners/collect-ci-results-runner.ts`

### Internal state

```typescript
type CiTracker = {
  phase: 'resolving-targets' | 'waiting-for-prs' | 'waiting-for-ci' | 'collecting'
  eligibleWorktreeIds: string[]
  prsByWorktreeId: Map<string, { repoPath: string; prNumber: number }>
  lastPollAt: number
  startedAt: number
}
```

Uses `Map<runId, Map<stepId, CiTracker>>` following the established tracker pattern.

### Dependencies

```typescript
type Deps = {
  getWorktree: (id: string) => Worktree | undefined
  getWorkspaceGroups: () => WorkspaceGroup[]
  hasChangesFromMain: (worktreeId: string) => Promise<boolean>
  getLinkedPR: (worktreeId: string) => { repoPath: string; prNumber: number } | null
  getPRChecks: (repoPath: string, prNumber: number) => Promise<PRCheckDetail[]>
  getPRComments: (repoPath: string, prNumber: number) => Promise<PRComment[]>
  now: () => number
}
```

### Tick flow

Each `tick()` call:
1. If no tracker exists, create one in `resolving-targets` phase
2. Check if enough time has elapsed since `lastPollAt` (respect `pollIntervalSeconds`)
3. If not, return `needs-more-time` immediately
4. Execute current phase logic, potentially advancing to next phase
5. If reached `collecting`, build output and return `done`
6. Otherwise return `needs-more-time`

## UI: Step Card

**File**: `src/renderer/src/components/automations/editor/CollectCiResultsStepCard.tsx`

Fields:
- **Worktree** — `TemplateInput` for `worktreeRef` (same picker pattern as run-prompt/run-command)
- **Poll interval** — Number input, default 30s
- **Include comments** — Checkbox, default checked

## Files to Modify

| # | File | Change |
|---|------|--------|
| 1 | `src/shared/automations-types.ts` | Add `'collect-ci-results'` to `StepKind` union; define `CollectCiResultsConfig`; add to `StepConfig` union |
| 2 | `src/shared/automation-step-schemas.ts` | Add `COLLECT_CI_RESULTS_OUTPUT_SCHEMA`; wire into `SCHEMA_BY_KIND` |
| 3 | `src/main/automations/runners/collect-ci-results-runner.ts` | New file: `CollectCiResultsRunner` implementing `StepRunner` |
| 4 | `src/main/automations/service.ts` | Instantiate runner in constructor; add case to `resolveRunner()` |
| 5 | `src/renderer/.../editor/CollectCiResultsStepCard.tsx` | New file: step card component |
| 6 | `src/renderer/.../editor/ChainEditorStepCardRouter.tsx` | Add `case 'collect-ci-results'` |
| 7 | `src/renderer/.../editor/chain-editor-modal-state.ts` | Add to `STEP_KIND_LABELS`, `STEP_KIND_ORDER`, `defaultConfigForKind()` |
