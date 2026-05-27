# Collect CI Results Step — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `collect-ci-results` automation step kind that waits for CI to complete on one or more PRs and collects check results + PR comments, making them available as template variables for downstream `run-prompt` steps.

**Architecture:** New step kind following the established runner pattern (like `wait-for-setup`). The runner uses `needs-more-time` to poll for PR linkage and CI completion across single worktrees or groups. Output is a markdown summary + structured JSON fields consumable by templates.

**Tech Stack:** TypeScript, Electron main process, React (step card UI), GitHub REST/GraphQL via existing `getPRChecks`/`getPRComments` in `src/main/github/client.ts`.

---

### Task 1: Add type definitions

**Files:**
- Modify: `src/shared/automations-types.ts:256-267` (StepKind union)
- Modify: `src/shared/automations-types.ts:360-367` (StepConfig union)

**Step 1: Add `collect-ci-results` to the `StepKind` union**

In `src/shared/automations-types.ts`, find the `StepKind` type (line 256) and add the new kind:

```typescript
export type StepKind =
  | 'run-prompt'
  | 'create-worktree'
  | 'create-workspace-group'
  | 'wait-for-setup'
  | 'run-command'
  | 'update-linear-issue'
  | 'collect-ci-results'
```

**Step 2: Define `CollectCiResultsConfig` type**

Add this type after `UpdateLinearIssueConfig` (around line 358):

```typescript
export type CollectCiResultsConfig = {
  worktreeRef: string          // template — single worktree ID or group:<uuid>
  pollIntervalSeconds: number  // default 30
  includeComments: boolean     // default true
}
```

**Step 3: Add to the `StepConfig` union**

Update the `StepConfig` union (line 360) to include the new config:

```typescript
export type StepConfig =
  | RunPromptConfig
  | CreateWorktreeConfig
  | CreateWorkspaceGroupConfig
  | WaitForSetupConfig
  | RunCommandConfig
  | UpdateLinearIssueConfig
  | CollectCiResultsConfig
```

**Step 4: Run typecheck**

Run: `pnpm tc:node`
Expected: Compile errors in `automation-step-schemas.ts` (exhaustive `SCHEMA_BY_KIND` missing the new kind) and `chain-editor-modal-state.ts` (exhaustive `STEP_KIND_LABELS` missing the new kind). This confirms the type system is enforcing exhaustiveness.

**Step 5: Commit**

```
git add src/shared/automations-types.ts
git commit -m "feat: add collect-ci-results step kind and config type"
```

---

### Task 2: Add output schema

**Files:**
- Modify: `src/shared/automation-step-schemas.ts:80-87` (SCHEMA_BY_KIND)

**Step 1: Define the output schema constant**

In `src/shared/automation-step-schemas.ts`, add after `UPDATE_LINEAR_ISSUE_OUTPUT_SCHEMA` (around line 53):

```typescript
export const COLLECT_CI_RESULTS_OUTPUT_SCHEMA: OutputSchema = {
  summary: 'string',
  checksJson: 'string',
  commentsJson: 'string',
  failedChecks: 'string',
  hasFailures: 'boolean',
  prCount: 'number'
}
```

**Step 2: Wire into `SCHEMA_BY_KIND`**

Add to the `SCHEMA_BY_KIND` record (line 80):

```typescript
const SCHEMA_BY_KIND: Record<StepKind, OutputSchema> = {
  'create-worktree': CREATE_WORKTREE_OUTPUT_SCHEMA,
  'create-workspace-group': CREATE_WORKSPACE_GROUP_OUTPUT_SCHEMA,
  'wait-for-setup': WAIT_FOR_SETUP_OUTPUT_SCHEMA,
  'run-prompt': RUN_PROMPT_OUTPUT_SCHEMA,
  'run-command': RUN_COMMAND_OUTPUT_SCHEMA,
  'update-linear-issue': UPDATE_LINEAR_ISSUE_OUTPUT_SCHEMA,
  'collect-ci-results': COLLECT_CI_RESULTS_OUTPUT_SCHEMA
}
```

**Step 3: Run typecheck**

Run: `pnpm tc:node`
Expected: The `SCHEMA_BY_KIND` exhaustiveness error is resolved. Still expect errors in `chain-editor-modal-state.ts`.

**Step 4: Commit**

```
git add src/shared/automation-step-schemas.ts
git commit -m "feat: add collect-ci-results output schema"
```

---

### Task 3: Implement the runner

**Files:**
- Create: `src/main/automations/runners/collect-ci-results-runner.ts`

**Step 1: Create the runner file**

Create `src/main/automations/runners/collect-ci-results-runner.ts` with the full implementation:

```typescript
import type { StepRunner, StepRunnerCtx, StepRunnerResult } from '../step-runner'
import type { CollectCiResultsConfig } from '../../../shared/automations-types'
import type { PRCheckDetail, PRComment, WorkspaceGroup } from '../../../shared/types'
import { parseMemberScopedRef } from '../../../shared/automation-member-scoped-ref'
import { findGroupById } from '../../workspace-group-runtime'
import { resolveTemplate, TemplateResolutionError } from '../template'

export type CollectCiResultsDeps = {
  getWorktreeMeta: (worktreeId: string) => { linkedPR: number | null; path: string; repoPath: string } | undefined
  getWorkspaceGroups: () => readonly WorkspaceGroup[]
  hasChangesFromMain: (worktreeId: string, path: string, connectionId: string | null) => Promise<boolean>
  getPRChecks: (repoPath: string, prNumber: number) => Promise<PRCheckDetail[]>
  getPRComments: (repoPath: string, prNumber: number) => Promise<PRComment[]>
  getRepoPath: (repoId: string) => string | undefined
  getConnectionId: (repoId: string) => string | null
  now: () => number
}

type PRTarget = {
  worktreeId: string
  repoPath: string
  prNumber: number
}

type CiTracker = {
  phase: 'resolving-targets' | 'waiting-for-prs' | 'waiting-for-ci' | 'collecting'
  eligibleWorktreeIds: string[]
  resolvedTargets: PRTarget[]
  lastPollAt: number
  startedAt: number
}

export class CollectCiResultsRunner implements StepRunner {
  private readonly trackers = new Map<string, Map<string, CiTracker>>()

  constructor(private readonly deps: CollectCiResultsDeps) {}

  async tick(ctx: StepRunnerCtx): Promise<StepRunnerResult> {
    const config = ctx.step.config as CollectCiResultsConfig

    let resolvedRef: string
    try {
      resolvedRef = resolveTemplate(config.worktreeRef, ctx.context)
    } catch (e) {
      if (e instanceof TemplateResolutionError) {
        return { outcome: 'failed', status: 'failed', error: e.message }
      }
      throw e
    }

    let runTrackers = this.trackers.get(ctx.runId)
    let tracker = runTrackers?.get(ctx.step.id)
    if (!tracker) {
      tracker = {
        phase: 'resolving-targets',
        eligibleWorktreeIds: [],
        resolvedTargets: [],
        lastPollAt: 0,
        startedAt: this.deps.now()
      }
      if (!runTrackers) {
        runTrackers = new Map()
        this.trackers.set(ctx.runId, runTrackers)
      }
      runTrackers.set(ctx.step.id, tracker)
    }

    const now = this.deps.now()

    if (ctx.step.timeoutSeconds != null) {
      const elapsedMs = now - tracker.startedAt
      if (elapsedMs >= ctx.step.timeoutSeconds * 1000) {
        return {
          outcome: 'failed',
          status: 'timed-out',
          error: `Step exceeded timeout of ${ctx.step.timeoutSeconds}s.`
        }
      }
    }

    const pollMs = (config.pollIntervalSeconds ?? 30) * 1000
    if (tracker.phase !== 'resolving-targets' && now - tracker.lastPollAt < pollMs) {
      return { outcome: 'needs-more-time', status: 'waiting' }
    }
    tracker.lastPollAt = now

    if (tracker.phase === 'resolving-targets') {
      return this.tickResolveTargets(tracker, resolvedRef, config)
    }

    if (tracker.phase === 'waiting-for-prs') {
      return this.tickWaitForPRs(tracker)
    }

    if (tracker.phase === 'waiting-for-ci') {
      return this.tickWaitForCi(tracker)
    }

    return this.tickCollect(ctx, tracker, config)
  }

  private async tickResolveTargets(
    tracker: CiTracker,
    resolvedRef: string,
    config: CollectCiResultsConfig
  ): Promise<StepRunnerResult> {
    const memberScoped = parseMemberScopedRef(resolvedRef)
    let worktreeIds: string[]

    if (memberScoped) {
      worktreeIds = [memberScoped.worktreeId]
    } else if (resolvedRef.startsWith('group:')) {
      const groups = this.deps.getWorkspaceGroups()
      const group = findGroupById(resolvedRef, groups)
      if (!group) {
        return {
          outcome: 'failed',
          status: 'failed',
          error: `Group not found for worktreeRef "${resolvedRef}".`
        }
      }
      worktreeIds = [...group.memberWorktreeIds]
    } else {
      worktreeIds = [resolvedRef]
    }

    // Filter to worktrees with changes from main (group members with no
    // changes won't have PRs and should be skipped).
    const eligible: string[] = []
    for (const wtId of worktreeIds) {
      const meta = this.deps.getWorktreeMeta(wtId)
      if (!meta) continue
      const repoId = wtId.split('::')[0]
      const connectionId = this.deps.getConnectionId(repoId)
      const hasChanges = await this.deps.hasChangesFromMain(wtId, meta.path, connectionId)
      if (hasChanges) {
        eligible.push(wtId)
      }
    }

    if (eligible.length === 0) {
      return {
        outcome: 'done',
        status: 'succeeded',
        output: {
          summary: 'No worktrees with changes from main — nothing to collect.',
          checksJson: '[]',
          commentsJson: '[]',
          failedChecks: '',
          hasFailures: false,
          prCount: 0
        },
        contextPatch: {
          steps: {
            // contextPatch key set by executor, not here
          }
        }
      }
    }

    tracker.eligibleWorktreeIds = eligible
    tracker.phase = 'waiting-for-prs'
    return { outcome: 'needs-more-time', status: 'waiting' }
  }

  private tickWaitForPRs(tracker: CiTracker): StepRunnerResult {
    const targets: PRTarget[] = []
    for (const wtId of tracker.eligibleWorktreeIds) {
      const meta = this.deps.getWorktreeMeta(wtId)
      if (!meta) continue
      if (meta.linkedPR == null) {
        return { outcome: 'needs-more-time', status: 'waiting' }
      }
      const repoId = wtId.split('::')[0]
      const repoPath = this.deps.getRepoPath(repoId)
      if (!repoPath) continue
      targets.push({ worktreeId: wtId, repoPath, prNumber: meta.linkedPR })
    }

    if (targets.length === 0) {
      return { outcome: 'needs-more-time', status: 'waiting' }
    }

    tracker.resolvedTargets = targets
    tracker.phase = 'waiting-for-ci'
    return { outcome: 'needs-more-time', status: 'waiting' }
  }

  private async tickWaitForCi(tracker: CiTracker): Promise<StepRunnerResult> {
    for (const target of tracker.resolvedTargets) {
      const checks = await this.deps.getPRChecks(target.repoPath, target.prNumber)
      // If any check is still running or queued, wait
      const pending = checks.some((c) => c.status !== 'completed')
      if (pending) {
        return { outcome: 'needs-more-time', status: 'waiting' }
      }
    }

    tracker.phase = 'collecting'
    return { outcome: 'needs-more-time', status: 'running' }
  }

  private async tickCollect(
    ctx: StepRunnerCtx,
    tracker: CiTracker,
    config: CollectCiResultsConfig
  ): Promise<StepRunnerResult> {
    const allChecks: { prNumber: number; repoPath: string; checks: PRCheckDetail[] }[] = []
    const allComments: { prNumber: number; repoPath: string; comments: PRComment[] }[] = []
    const failedCheckNames: string[] = []
    let hasFailures = false

    for (const target of tracker.resolvedTargets) {
      const checks = await this.deps.getPRChecks(target.repoPath, target.prNumber)
      allChecks.push({ prNumber: target.prNumber, repoPath: target.repoPath, checks })

      for (const check of checks) {
        if (
          check.conclusion === 'failure' ||
          check.conclusion === 'timed_out' ||
          check.conclusion === 'cancelled'
        ) {
          hasFailures = true
          failedCheckNames.push(check.name)
        }
      }

      if (config.includeComments) {
        const comments = await this.deps.getPRComments(target.repoPath, target.prNumber)
        allComments.push({ prNumber: target.prNumber, repoPath: target.repoPath, comments })
      }
    }

    const summary = buildSummary(allChecks, allComments)

    const output = {
      summary,
      checksJson: JSON.stringify(allChecks),
      commentsJson: JSON.stringify(allComments),
      failedChecks: failedCheckNames.join(', '),
      hasFailures,
      prCount: tracker.resolvedTargets.length
    }

    return {
      outcome: 'done',
      status: 'succeeded',
      output,
      contextPatch: { steps: { [ctx.step.id]: output } }
    }
  }

  dropRun(runId: string): void {
    this.trackers.delete(runId)
  }

  dropStep(runId: string, stepId: string): void {
    const runTrackers = this.trackers.get(runId)
    if (!runTrackers) return
    runTrackers.delete(stepId)
    if (runTrackers.size === 0) {
      this.trackers.delete(runId)
    }
  }
}

function buildSummary(
  allChecks: { prNumber: number; repoPath: string; checks: PRCheckDetail[] }[],
  allComments: { prNumber: number; repoPath: string; comments: PRComment[] }[]
): string {
  const sections: string[] = []

  for (const entry of allChecks) {
    const repoName = entry.repoPath.split('/').pop() ?? entry.repoPath
    const failed = entry.checks.filter(
      (c) => c.conclusion === 'failure' || c.conclusion === 'timed_out' || c.conclusion === 'cancelled'
    ).length
    const passed = entry.checks.filter((c) => c.conclusion === 'success').length
    const other = entry.checks.length - failed - passed

    let header = `## PR #${entry.prNumber} (${repoName})`
    if (entry.checks.length > 0) {
      const parts: string[] = []
      if (failed > 0) parts.push(`${failed} failed`)
      if (passed > 0) parts.push(`${passed} passed`)
      if (other > 0) parts.push(`${other} other`)
      header += ` — ${parts.join(', ')}`
    }

    const lines = [header, '', '### Checks', '| Check | Status |', '|-------|--------|']
    for (const check of entry.checks) {
      lines.push(`| ${check.name} | ${check.conclusion ?? check.status} |`)
    }

    const commentEntry = allComments.find(
      (c) => c.prNumber === entry.prNumber && c.repoPath === entry.repoPath
    )
    if (commentEntry && commentEntry.comments.length > 0) {
      lines.push('', `### Comments (${commentEntry.comments.length})`)
      for (const comment of commentEntry.comments) {
        const location = comment.path
          ? ` (inline: ${comment.path}${comment.line ? `:${comment.line}` : ''})`
          : ' (conversation)'
        lines.push(`**@${comment.author}**${location}:`, `> ${comment.body.split('\n')[0]}`, '')
      }
    }

    sections.push(lines.join('\n'))
  }

  return sections.join('\n\n')
}
```

**Step 2: Run typecheck**

Run: `pnpm tc:node`
Expected: Runner compiles. Still expect errors in `chain-editor-modal-state.ts`.

**Step 3: Commit**

```
git add src/main/automations/runners/collect-ci-results-runner.ts
git commit -m "feat: implement CollectCiResultsRunner"
```

---

### Task 4: Wire the runner into AutomationService

**Files:**
- Modify: `src/main/automations/service.ts:29-37` (imports)
- Modify: `src/main/automations/service.ts:166-172` (private fields)
- Modify: `src/main/automations/service.ts:289-298` (constructor wiring)
- Modify: `src/main/automations/service.ts:602-622` (resolveRunner)
- Modify: `src/main/automations/service.ts:838-847` (allRunners)

**Step 1: Add import**

After the `UpdateLinearIssueRunner` import (line 37), add:

```typescript
import { CollectCiResultsRunner } from './runners/collect-ci-results-runner'
```

Also add the GitHub client import if not already present. Check if `getPRChecks` and `getPRComments` are already imported; they likely aren't because no existing runner uses them. Add at the top of the imports section:

```typescript
import { getPRChecks, getPRComments } from '../github/client'
```

**Step 2: Add private field**

After `private readonly updateLinearIssueRunner: UpdateLinearIssueRunner` (line 171), add:

```typescript
private readonly collectCiResultsRunner: CollectCiResultsRunner
```

**Step 3: Instantiate in constructor**

After the `this.updateLinearIssueRunner = new UpdateLinearIssueRunner(...)` block (around line 378), add:

```typescript
this.collectCiResultsRunner = new CollectCiResultsRunner({
  getWorktreeMeta: (worktreeId) => {
    const meta = this.store.getWorktreeMeta(worktreeId)
    if (!meta) return undefined
    const parsed = splitWorktreeId(worktreeId)
    const repo = parsed ? this.store.getRepo(parsed.repoId) : null
    return {
      linkedPR: meta.linkedPR,
      path: parsed?.worktreePath ?? worktreeId,
      repoPath: repo?.path ?? ''
    }
  },
  getWorkspaceGroups: () => this.store.getWorkspaceGroups(),
  hasChangesFromMain: async (worktreeId, path, connectionId) => {
    const result = await hasPromptTargetChangesFromMain([
      { worktreeId, path, connectionId }
    ])
    return result.hasChanges
  },
  getPRChecks: (repoPath, prNumber) => getPRChecks(repoPath, prNumber),
  getPRComments: (repoPath, prNumber) => getPRComments(repoPath, prNumber),
  getRepoPath: (repoId) => this.store.getRepo(repoId)?.path,
  getConnectionId: (repoId) => this.store.getRepo(repoId)?.connectionId ?? null,
  now: () => Date.now()
})
```

**Step 4: Add to `resolveRunner()`**

In the `resolveRunner` method (line 602), add before `return undefined`:

```typescript
if (kind === 'collect-ci-results') {
  return this.collectCiResultsRunner
}
```

**Step 5: Add to `allRunners()`**

In the `allRunners` method (line 838), add to the returned array:

```typescript
private allRunners(): StepRunner[] {
  return [
    this.runPromptRunner,
    this.waitForSetupRunner,
    this.runCommandRunner,
    this.createWorktreeRunner,
    this.createWorkspaceGroupRunner,
    this.updateLinearIssueRunner,
    this.collectCiResultsRunner
  ]
}
```

**Step 6: Run typecheck**

Run: `pnpm tc:node`
Expected: Main process compiles. Renderer-side errors remain in `chain-editor-modal-state.ts`.

**Step 7: Commit**

```
git add src/main/automations/service.ts
git commit -m "feat: wire CollectCiResultsRunner into AutomationService"
```

---

### Task 5: Add the step card UI component

**Files:**
- Create: `src/renderer/src/components/automations/editor/CollectCiResultsStepCard.tsx`

**Step 1: Create the step card**

Create `src/renderer/src/components/automations/editor/CollectCiResultsStepCard.tsx`:

```typescript
import * as React from 'react'
import type { Step, StepConfig, CollectCiResultsConfig } from '../../../../../shared/automations-types'
import type { AvailableVariables } from '../../../lib/template-dry-run'
import { TemplateInput } from './TemplateInput'
import { StepCardChrome } from './StepCardChrome'

export type CollectCiResultsStepCardProps = {
  step: Step
  stepIndex: number
  available: AvailableVariables
  disableDrag?: boolean
  onIdChange: (newId: string) => void
  onConfigChange: (config: CollectCiResultsConfig) => void
  onOnFailureChange: (val: 'halt' | 'continue') => void
  onTimeoutChange: (val: number | null) => void
  onDelete: () => void
}

export function CollectCiResultsStepCard(props: CollectCiResultsStepCardProps): React.JSX.Element {
  const config = props.step.config as CollectCiResultsConfig
  const update = (patch: Partial<CollectCiResultsConfig>): void => {
    props.onConfigChange({ ...config, ...patch })
  }

  return (
    <StepCardChrome
      step={props.step}
      stepIndex={props.stepIndex}
      available={props.available}
      disableDrag={props.disableDrag}
      onIdChange={props.onIdChange}
      onConfigChange={props.onConfigChange as (config: StepConfig) => void}
      onOnFailureChange={props.onOnFailureChange}
      onTimeoutChange={props.onTimeoutChange}
      onDelete={props.onDelete}
    >
      <TemplateInput
        value={config.worktreeRef}
        onChange={(v) => update({ worktreeRef: v })}
        placeholder="{{steps.<id>.worktreeId}}"
        available={props.available}
        ariaLabel="Worktree ref"
      />
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Poll interval (s)
          <input
            type="number"
            min={10}
            max={300}
            value={config.pollIntervalSeconds ?? 30}
            onChange={(e) => update({ pollIntervalSeconds: Number(e.target.value) || 30 })}
            className="w-16 rounded border border-border bg-background px-2 py-1 text-xs"
            aria-label="Poll interval seconds"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            aria-label="Include comments"
            checked={config.includeComments ?? true}
            onChange={(e) => update({ includeComments: e.target.checked })}
          />
          Include comments
        </label>
      </div>
    </StepCardChrome>
  )
}
```

**Step 2: Commit**

```
git add src/renderer/src/components/automations/editor/CollectCiResultsStepCard.tsx
git commit -m "feat: add CollectCiResultsStepCard UI component"
```

---

### Task 6: Wire step card into router and editor state

**Files:**
- Modify: `src/renderer/src/components/automations/editor/ChainEditorStepCardRouter.tsx:1-11` (imports), `50-83` (switch)
- Modify: `src/renderer/src/components/automations/editor/chain-editor-modal-state.ts:1-14` (imports), `39-46` (labels), `52-58` (order), `415-472` (defaultConfig)

**Step 1: Add import and case in `ChainEditorStepCardRouter.tsx`**

Add import after the `UpdateLinearIssueStepCard` import (line 10):

```typescript
import { CollectCiResultsStepCard } from './CollectCiResultsStepCard'
```

Add case in the switch statement before the closing brace (after line 82):

```typescript
case 'collect-ci-results':
  return <CollectCiResultsStepCard {...common} onConfigChange={props.onConfigChange} />
```

**Step 2: Add label, order, and default config in `chain-editor-modal-state.ts`**

Add to imports (line 1-14) — add `CollectCiResultsConfig` to the import from `automations-types`:

```typescript
import type {
  Automation,
  CollectCiResultsConfig,
  CreateWorkspaceGroupConfig,
  CreateWorktreeConfig,
  RunCommandConfig,
  RunPromptConfig,
  Step,
  StepConfig,
  StepKind,
  StepOrGroup,
  TriggerConfig,
  UpdateLinearIssueConfig,
  WaitForSetupConfig
} from '../../../../../shared/automations-types'
```

Add to `STEP_KIND_LABELS` (line 39-46):

```typescript
export const STEP_KIND_LABELS: Record<StepKind, string> = {
  'create-worktree': 'Create worktree',
  'create-workspace-group': 'Create workspace group',
  'wait-for-setup': 'Wait for setup',
  'run-prompt': 'Run prompt',
  'run-command': 'Run command',
  'update-linear-issue': 'Update Linear issue',
  'collect-ci-results': 'Collect CI results'
}
```

Add to `STEP_KIND_ORDER` (line 52-58) — place after `run-prompt` since it's a data-collection step that typically follows prompt execution:

```typescript
export const STEP_KIND_ORDER: StepKind[] = [
  'create-worktree',
  'create-workspace-group',
  'wait-for-setup',
  'run-prompt',
  'collect-ci-results',
  'update-linear-issue'
]
```

Add case in `defaultConfigForKind` (line 415) — add before the closing of the switch:

```typescript
case 'collect-ci-results': {
  const cfg: CollectCiResultsConfig = {
    worktreeRef: '',
    pollIntervalSeconds: 30,
    includeComments: true
  }
  return cfg
}
```

**Step 3: Run typecheck**

Run: `pnpm tc`
Expected: All three projects compile cleanly.

**Step 4: Commit**

```
git add src/renderer/src/components/automations/editor/ChainEditorStepCardRouter.tsx src/renderer/src/components/automations/editor/chain-editor-modal-state.ts
git commit -m "feat: wire collect-ci-results into step card router and editor state"
```

---

### Task 7: Write runner tests

**Files:**
- Create: `src/main/automations/runners/collect-ci-results-runner.test.ts`

**Step 1: Write tests**

Create `src/main/automations/runners/collect-ci-results-runner.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { CollectCiResultsRunner, type CollectCiResultsDeps } from './collect-ci-results-runner'
import type { StepRunnerCtx } from '../step-runner'
import type { CollectCiResultsConfig, Step } from '../../../shared/automations-types'
import type { PRCheckDetail, PRComment } from '../../../shared/types'

function makeDeps(overrides: Partial<CollectCiResultsDeps> = {}): CollectCiResultsDeps {
  return {
    getWorktreeMeta: () => ({ linkedPR: 42, path: '/tmp/wt', repoPath: '/tmp/repo' }),
    getWorkspaceGroups: () => [],
    hasChangesFromMain: async () => true,
    getPRChecks: async () => [],
    getPRComments: async () => [],
    getRepoPath: () => '/tmp/repo',
    getConnectionId: () => null,
    now: () => 1000,
    ...overrides
  }
}

function makeCtx(configOverrides: Partial<CollectCiResultsConfig> = {}, stepId = 'ci-1'): StepRunnerCtx {
  const config: CollectCiResultsConfig = {
    worktreeRef: 'repo-a::/tmp/wt',
    pollIntervalSeconds: 30,
    includeComments: true,
    ...configOverrides
  }
  const step: Step = {
    id: stepId,
    kind: 'collect-ci-results',
    config,
    onFailure: 'halt',
    timeoutSeconds: null
  }
  return {
    runId: 'run-1',
    step,
    state: { stepId, status: 'pending', startedAt: null, finishedAt: null, output: null, error: null },
    context: {}
  }
}

describe('CollectCiResultsRunner', () => {
  it('succeeds with no eligible worktrees when worktree has no changes', async () => {
    const runner = new CollectCiResultsRunner(makeDeps({
      hasChangesFromMain: async () => false
    }))
    const result = await runner.tick(makeCtx())
    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')
    const output = result.output as Record<string, unknown>
    expect(output.prCount).toBe(0)
  })

  it('waits for PR linkage when linkedPR is null', async () => {
    const runner = new CollectCiResultsRunner(makeDeps({
      getWorktreeMeta: () => ({ linkedPR: null, path: '/tmp/wt', repoPath: '/tmp/repo' })
    }))
    // First tick: resolves targets
    const r1 = await runner.tick(makeCtx())
    expect(r1.outcome).toBe('needs-more-time')

    // Second tick: still waiting for PR
    const r2 = await runner.tick(makeCtx())
    expect(r2.outcome).toBe('needs-more-time')
  })

  it('waits for CI when checks are in_progress', async () => {
    const checks: PRCheckDetail[] = [
      { name: 'build', status: 'in_progress', conclusion: null, url: null }
    ]
    const runner = new CollectCiResultsRunner(makeDeps({
      getPRChecks: async () => checks
    }))

    // First tick: resolves targets, transitions to waiting-for-prs
    const r1 = await runner.tick(makeCtx())
    expect(r1.outcome).toBe('needs-more-time')

    // Need to advance past poll interval for subsequent ticks
    let time = 1000
    const depsWithTime = makeDeps({
      getPRChecks: async () => checks,
      now: () => time
    })
    const runner2 = new CollectCiResultsRunner(depsWithTime)

    await runner2.tick(makeCtx()) // resolving-targets → waiting-for-prs
    time += 31000
    await runner2.tick(makeCtx()) // waiting-for-prs → waiting-for-ci
    time += 31000
    const r3 = await runner2.tick(makeCtx()) // waiting-for-ci: still pending
    expect(r3.outcome).toBe('needs-more-time')
  })

  it('collects results when all checks complete', async () => {
    const checks: PRCheckDetail[] = [
      { name: 'build', status: 'completed', conclusion: 'success', url: null },
      { name: 'test', status: 'completed', conclusion: 'failure', url: null }
    ]
    const comments: PRComment[] = [
      {
        id: 1,
        author: 'reviewer',
        authorAvatarUrl: '',
        body: 'Looks good',
        createdAt: '2026-01-01',
        url: 'https://github.com/test/1'
      }
    ]

    let time = 1000
    const runner = new CollectCiResultsRunner(makeDeps({
      getPRChecks: async () => checks,
      getPRComments: async () => comments,
      now: () => time
    }))

    await runner.tick(makeCtx()) // resolving → waiting-for-prs
    time += 31000
    await runner.tick(makeCtx()) // waiting-for-prs → waiting-for-ci
    time += 31000
    await runner.tick(makeCtx()) // waiting-for-ci → collecting
    time += 31000
    const result = await runner.tick(makeCtx()) // collecting → done

    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')

    const output = result.output as Record<string, unknown>
    expect(output.hasFailures).toBe(true)
    expect(output.failedChecks).toBe('test')
    expect(output.prCount).toBe(1)
    expect(output.summary).toContain('PR #42')
    expect(output.summary).toContain('failure')
  })

  it('respects timeout', async () => {
    const runner = new CollectCiResultsRunner(makeDeps({
      now: () => 120_000
    }))
    const ctx = makeCtx()
    ctx.step.timeoutSeconds = 60

    // First tick creates tracker at t=120000
    await runner.tick(ctx)

    // Simulate second tick past timeout
    const runner2 = new CollectCiResultsRunner(makeDeps({
      now: () => 181_000
    }))
    // Need to create tracker at startedAt time then tick past timeout
    // Actually test differently: single runner, different now()
    let time = 1000
    const runner3 = new CollectCiResultsRunner(makeDeps({
      getWorktreeMeta: () => ({ linkedPR: null, path: '/tmp/wt', repoPath: '/tmp/repo' }),
      now: () => time
    }))
    const ctx2 = makeCtx()
    ctx2.step.timeoutSeconds = 60

    await runner3.tick(ctx2) // starts tracker at t=1000
    time = 62_000 // 61s later
    const result = await runner3.tick(ctx2)
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('timed-out')
  })

  it('cleans up on dropRun', async () => {
    const runner = new CollectCiResultsRunner(makeDeps())
    await runner.tick(makeCtx())
    runner.dropRun('run-1')
    // Verify no crash on second tick with same runId (creates fresh tracker)
    const result = await runner.tick(makeCtx())
    expect(result.outcome).toBe('needs-more-time')
  })
})
```

**Step 2: Run tests**

Run: `pnpm vitest run src/main/automations/runners/collect-ci-results-runner.test.ts`
Expected: All tests pass.

**Step 3: Commit**

```
git add src/main/automations/runners/collect-ci-results-runner.test.ts
git commit -m "test: add CollectCiResultsRunner tests"
```

---

### Task 8: Run full typecheck and test suite

**Step 1: Run full typecheck**

Run: `pnpm tc`
Expected: All three projects compile cleanly.

**Step 2: Run related tests**

Run: `pnpm vitest run --reporter=verbose src/main/automations/`
Expected: All existing automation tests still pass, new tests pass.

**Step 3: Commit (if any fixes needed)**

Only if previous steps required corrections.
