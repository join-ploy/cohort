# Watch PR / Review Loop — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a long-lived `watch-pr` automation node that watches a PR and runs an attached branch of nodes (a child run per cycle) each time changes are requested, reusing the existing pane, until the PR is merged or closed.

**Architecture:** A new `StepRunner` (`WatchPrRunner`) that returns `needs-more-time`/`waiting` indefinitely until a terminal PR state. Each response cycle is a child `AutomationRun` (new `parentRunId`/`parentStepId`/`cycleIndex` fields) whose steps come from the watch node's `branchSteps`, driven by the *same* `ChainExecutor`. A small `endChain` result field lets the node finish the parent run cleanly on PR close (merged → continue, closed → stop). Child-run teardown is query-based (Store lookup by `parentStepId`), so Stop and retry-from-earlier-step both stop the loop, restart-safe.

**Tech Stack:** TypeScript (Electron main + React renderer), Vitest, `gh` CLI for GitHub reads, existing `ChainExecutor` / `AutomationService` machinery.

**Design doc:** `docs/plans/2026-06-08-watch-pr-review-loop-design.md` — read it first.

**Verification (per repo norms):** `pnpm tc:node`, `pnpm tc:web`, and targeted `pnpm vitest run <file>`. Do **not** run the full suite or `tc:cli` (known unrelated failures). Use `tsgo` via the `tc:*` scripts, never `tsc`.

**v1 constraints:** single worktree/PR/pane per node; `branchSteps` may **not** contain another `watch-pr` node (no nested loops) — the editor enforces this and `spawnChildRun` recursion is therefore depth-1.

---

## Task 1: Types — step kind, config, child-run fields

**Files:**
- Modify: `src/shared/automations-types.ts:364` (StepKind), `:491` (after CollectCiResultsConfig), `:509` (StepConfig union), `:72` (AutomationRun)

**Step 1: Add `'watch-pr'` to `StepKind`**

`src/shared/automations-types.ts` — extend the union at line 364:

```typescript
export type StepKind =
  | 'run-prompt'
  | 'create-worktree'
  | 'create-workspace-group'
  | 'wait-for-setup'
  | 'run-command'
  | 'update-linear-issue'
  | 'collect-ci-results'
  | 'http-request'
  | 'watch-pr'
```

**Step 2: Add `WatchPrConfig`** (after `CollectCiResultsConfig`, ~line 495):

```typescript
// Long-lived PR review-loop node. Watches a PR and runs `branchSteps` as a
// child run each time changes are requested, until the PR is merged/closed.
export type WatchPrConfig = {
  worktreeRef: string // template — resolves the single worktree → PR
  paneRef: string // template — supervised pane (idle gate + inherited by branch)
  events: {
    changesRequested: boolean // default true
    newReviewComments: boolean // default false
    anyReview: boolean // default false
  }
  pollIntervalSeconds: number // PR-state poll cadence (default 30)
  agentIdleDebounceSeconds: number // idle window before firing a cycle
  // When false (default) a failed branch cycle keeps the loop watching; the
  // failure is recorded on that cycle's child run. True halts the whole watch.
  failedCycleHaltsLoop?: boolean
  branchSteps: StepOrGroup[] // sub-graph run each cycle
}
```

**Step 3: Add it to the `StepConfig` union** (line 509):

```typescript
export type StepConfig =
  | RunPromptConfig
  | CreateWorktreeConfig
  | CreateWorkspaceGroupConfig
  | WaitForSetupConfig
  | RunCommandConfig
  | UpdateLinearIssueConfig
  | CollectCiResultsConfig
  | HttpRequestStepConfig
  | WatchPrConfig
```

**Step 4: Add child-run fields to `AutomationRun`** (after `restartedFromRunId?` at line 100):

```typescript
  // Set when this run is a watch-pr response cycle. Its steps come from the
  // parent automation's watch step `branchSteps`, not `automation.steps`.
  parentRunId?: string
  parentStepId?: string
  cycleIndex?: number // 1-based review round
```

**Step 5: Typecheck**

Run: `pnpm tc:node`
Expected: PASS (no call sites broken yet; the new union member is additive). The renderer may now flag a non-exhaustive `switch` over `StepKind` — note any errors; they're addressed in Task 2 (schema) and Task 13 (editor).

**Step 6: Commit**

```bash
git add src/shared/automations-types.ts
git commit -m "feat(automations): types for watch-pr step + child-run fields"
```

---

## Task 2: Output schema registration

**Files:**
- Modify: `src/shared/automation-step-schemas.ts` (add schema + `SCHEMA_BY_KIND` entry; ~lines 55-120)
- Test: `src/shared/automation-step-schemas.test.ts` (create if absent, else extend)

**Step 1: Write the failing test**

Add to `automation-step-schemas.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { SCHEMA_BY_KIND } from './automation-step-schemas'

describe('watch-pr schema', () => {
  it('registers a final-output schema for watch-pr', () => {
    const schema = SCHEMA_BY_KIND['watch-pr']
    expect(schema).toBeDefined()
    expect(schema.finalState).toBe('string')
    expect(schema.cyclesRun).toBe('number')
    expect(schema.prNumber).toBe('number')
  })
})
```

**Step 2: Run it to confirm it fails**

Run: `pnpm vitest run src/shared/automation-step-schemas.test.ts`
Expected: FAIL — `SCHEMA_BY_KIND['watch-pr']` is undefined.

**Step 3: Implement**

Add near the other schemas (~line 62):

```typescript
// Final output (parent-chain scope), available to steps AFTER the watch node.
export const WATCH_PR_OUTPUT_SCHEMA: OutputSchema = {
  finalState: 'string', // 'merged' | 'closed' | 'archived'
  cyclesRun: 'number',
  prNumber: 'number',
  prUrl: 'string',
  finishedAt: 'number'
}

// Per-cycle payload (branch scope) — seeded into each child run's context
// under steps.<watch-id>.*. Surfaced only inside the branch editor.
export const WATCH_PR_CYCLE_SCHEMA: OutputSchema = {
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
}
```

Add to `SCHEMA_BY_KIND` (line 111):

```typescript
  'watch-pr': WATCH_PR_OUTPUT_SCHEMA,
```

**Step 4: Run the test**

Run: `pnpm vitest run src/shared/automation-step-schemas.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/shared/automation-step-schemas.ts src/shared/automation-step-schemas.test.ts
git commit -m "feat(automations): watch-pr output schemas"
```

---

## Task 3: `endChain` executor signal (merged → continue, closed → stop)

**Files:**
- Modify: `src/main/automations/step-runner.ts:12-25` (add field)
- Modify: `src/main/automations/chain-executor.ts:195-237` (solo) and `:297-361` (group)
- Test: `src/main/automations/chain-executor.test.ts`

**Step 1: Add the field to `StepRunnerResult`** (`step-runner.ts`, after `openedPane?`):

```typescript
  /** When true with outcome 'done', the executor finalizes the run as
   *  'completed' immediately and does NOT advance to downstream steps. Used
   *  for a clean early exit (e.g. watch-pr when the PR is closed). */
  endChain?: boolean
```

**Step 2: Write the failing test** (`chain-executor.test.ts`)

Model on existing tests in that file (fake `getRunner`/`persistRun`/`now`). One step whose runner returns `{ outcome: 'done', status: 'succeeded', endChain: true }`, followed by a second step. Assert the run finalizes `completed` and the second step never gets a `stepState`:

```typescript
it('endChain finalizes the run completed without advancing downstream', async () => {
  const steps = [
    { id: 'a', kind: 'fake-end', config: {}, onFailure: 'halt', timeoutSeconds: null },
    { id: 'b', kind: 'fake-next', config: {}, onFailure: 'halt', timeoutSeconds: null }
  ]
  const automation = { id: 'x', trigger: 'manual', steps } as any
  const run = { id: 'r', context: {}, stepStates: [] } as any
  const runners: Record<string, any> = {
    'fake-end': { tick: async () => ({ outcome: 'done', status: 'succeeded', endChain: true }) },
    'fake-next': { tick: async () => ({ outcome: 'done', status: 'succeeded' }) }
  }
  const exec = new ChainExecutor({
    getRunner: (k) => runners[k],
    persistRun: () => {},
    now: () => 1000
  })
  await exec.tick(automation, run)
  expect(run.status).toBe('completed')
  expect(run.stepStates.map((s: any) => s.stepId)).toEqual(['a']) // 'b' never ran
})
```

**Step 3: Run it to confirm it fails**

Run: `pnpm vitest run src/main/automations/chain-executor.test.ts -t endChain`
Expected: FAIL — without handling, step `b` materializes and the run keeps going.

**Step 4: Implement — solo path** (`chain-executor.ts`, in `tickSoloStep`, right after the halt-on-failure block at ~line 220, before the chain-complete check at ~223):

```typescript
    // Clean early exit: a runner can finish the run without advancing to
    // downstream steps (e.g. watch-pr on PR close). Mirrors the lazy-stepStates
    // model — downstream steps are simply never materialized.
    if (result.outcome === 'done' && result.endChain) {
      this.finalizeRun(automation, run)
      this.deps.persistRun(run)
      return false
    }
```

**Step 5: Implement — parallel path** (`tickParallelGroup`, after the `haltFailure` block at ~line 350, before the chain-complete check). A group sibling returning `endChain` ends the run once the group settles:

```typescript
    if (groupStates.some((s, i) => endChainFlags[i])) {
      this.finalizeRun(automation, run)
      this.deps.persistRun(run)
      return false
    }
```

Track `endChainFlags` alongside `anyAdvanced` in the `Promise.all` map: when a sibling result has `result.endChain`, record `endChainFlags[i] = true`. (Declare `const endChainFlags: boolean[] = []` before the map.) Watch-pr is a solo node in practice, but handling the group case keeps the field general and the executor consistent.

**Step 6: Run the test**

Run: `pnpm vitest run src/main/automations/chain-executor.test.ts -t endChain`
Expected: PASS. Then `pnpm vitest run src/main/automations/chain-executor.test.ts` (no regressions).

**Step 7: Commit**

```bash
git add src/main/automations/step-runner.ts src/main/automations/chain-executor.ts src/main/automations/chain-executor.test.ts
git commit -m "feat(automations): endChain result signal for clean early exit"
```

---

## Task 4: GitHub client — `getPRState`

**Files:**
- Modify: `src/main/github/client.ts` (add near `getPRChecks`, ~line 1024)
- Test: `src/main/github/client.test.ts` (extend; mock the `gh` exec the same way existing tests do)

**Step 1: Write the failing test**

Mirror existing `getPRChecks` tests: stub the `gh` runner to return a JSON blob, assert the parsed shape.

```typescript
it('getPRState parses state + reviewDecision', async () => {
  // arrange: stub gh to return:
  // { state: 'OPEN', mergedAt: null, closedAt: null, reviewDecision: 'CHANGES_REQUESTED' }
  const res = await client.getPRState('/repo/path', 42)
  expect(res).toEqual({
    state: 'OPEN',
    mergedAt: null,
    closedAt: null,
    reviewDecision: 'CHANGES_REQUESTED'
  })
})
```

**Step 2: Run to confirm it fails** — `pnpm vitest run src/main/github/client.test.ts -t getPRState` → FAIL (method missing).

**Step 3: Implement** (model the `gh` invocation + cwd handling on `getPRChecks`):

```typescript
export type PRState = {
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  mergedAt: string | null
  closedAt: string | null
  reviewDecision: 'CHANGES_REQUESTED' | 'APPROVED' | 'REVIEW_REQUIRED' | null
}

async getPRState(
  repoPath: string,
  prNumber: number,
  options?: { noCache?: boolean }
): Promise<PRState> {
  // gh normalizes state to UPPERCASE OPEN/MERGED/CLOSED.
  const args = [
    'pr', 'view', String(prNumber),
    '--json', 'state,mergedAt,closedAt,reviewDecision'
  ]
  const raw = await this.runGh(args, { cwd: repoPath, cache: options?.noCache ? undefined : '30s' })
  const json = JSON.parse(raw) as {
    state: string
    mergedAt: string | null
    closedAt: string | null
    reviewDecision: string | null
  }
  return {
    state: json.state as PRState['state'],
    mergedAt: json.mergedAt ?? null,
    closedAt: json.closedAt ?? null,
    reviewDecision: (json.reviewDecision || null) as PRState['reviewDecision']
  }
}
```

> Match the actual gh-runner helper name/signature used by `getPRChecks` (e.g. `this.runGh` / `execFileGh` / whatever the file uses) and its caching convention. Read `client.ts:1024-1091` first and copy the pattern exactly.

**Step 4: Run the test** — PASS.

**Step 5: Commit**

```bash
git add src/main/github/client.ts src/main/github/client.test.ts
git commit -m "feat(github): getPRState for watch-pr terminal detection"
```

---

## Task 5: GitHub client — `getPRReviews`

**Files:** same as Task 4.

**Step 1: Write the failing test** — stub `gh api .../pulls/42/reviews` returning two reviews; assert mapped shape `[{ id, author, state, submittedAt, body }]`, sorted by `submittedAt`.

**Step 2: Run to confirm it fails.**

**Step 3: Implement**

```typescript
export type PRReview = {
  id: string
  author: string
  state: string // 'CHANGES_REQUESTED' | 'APPROVED' | 'COMMENTED' | 'DISMISSED' | ...
  submittedAt: string // ISO; '' when a pending review has no submission time
  body: string
}

async getPRReviews(repoPath: string, prNumber: number): Promise<PRReview[]> {
  // owner/repo derived the same way getPRChecks does it.
  const { owner, repo } = await this.resolveOwnerRepo(repoPath)
  const raw = await this.runGh(
    ['api', `repos/${owner}/${repo}/pulls/${prNumber}/reviews`, '--paginate'],
    { cwd: repoPath }
  )
  const arr = JSON.parse(raw) as Array<{
    id: number
    user: { login: string } | null
    state: string
    submitted_at: string | null
    body: string
  }>
  return arr
    .map((r) => ({
      id: String(r.id),
      author: r.user?.login ?? 'unknown',
      state: r.state,
      submittedAt: r.submitted_at ?? '',
      body: r.body ?? ''
    }))
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
}
```

> Reuse however `getPRChecks` resolves owner/repo (it builds the `repos/{owner}/{repo}/...` path at `client.ts:~1030`). Don't invent `resolveOwnerRepo` if a helper already exists — match it.

**Step 4: Run the test** — PASS.

**Step 5: Commit**

```bash
git add src/main/github/client.ts src/main/github/client.test.ts
git commit -m "feat(github): getPRReviews arming feed for watch-pr"
```

---

## Task 6: WatchPrRunner — scaffolding + `resolving` phase

> Tasks 6-10 build the runner incrementally, each with its own test. Model structure on `collect-ci-results-runner.ts` (tracker map, phase machine, `dropRun`/`dropStep`). All deps are injected so the runner is pure and unit-testable.

**Files:**
- Create: `src/main/automations/runners/watch-pr-runner.ts`
- Create: `src/main/automations/runners/watch-pr-runner.test.ts`

**Step 1: Define deps + tracker + skeleton**

```typescript
import type { StepRunner, StepRunnerCtx, StepRunnerResult } from '../step-runner'
import type { WatchPrConfig } from '../../../shared/automations-types'
import type { PRState, PRReview, PRComment } from '../../github/client'
import { resolveTemplate, TemplateResolutionError } from '../template'
import { WATCH_PR_CYCLE_SCHEMA } from '../../../shared/automation-step-schemas'

export type AgentLiveStatus = 'working' | 'idle' | 'done' | 'unknown'

export type WatchPrDeps = {
  getWorktreeMeta: (worktreeId: string) => { linkedPR: number | null; path: string; repoPath: string } | undefined
  getRepoPath: (repoId: string) => string | undefined
  resolveLinkedPR: (worktreePath: string, repoPath: string) => Promise<number | null>
  isWorktreeArchived: (worktreeId: string) => boolean
  getPRState: (repoPath: string, prNumber: number, opts?: { noCache?: boolean }) => Promise<PRState>
  getPRReviews: (repoPath: string, prNumber: number) => Promise<PRReview[]>
  getPRComments: (repoPath: string, prNumber: number) => Promise<PRComment[]>
  /** Agent liveness for the supervised pane (reuses run-prompt's status source). */
  getAgentLiveStatus: (paneKey: string) => AgentLiveStatus
  /** Create + persist a child run; returns its id. Steps come from branchSteps. */
  spawnChildRun: (args: {
    parentRunId: string
    parentStepId: string
    cycleIndex: number
    cycleOutput: Record<string, unknown>
  }) => string
  /** Terminal status of a child run, or 'missing' if it no longer exists. */
  getChildRunStatus: (childRunId: string) => 'active' | 'completed' | 'failed' | 'missing'
  /** Cancel every non-terminal child run for (runId, stepId). Restart-safe. */
  cancelChildRunsForStep: (parentRunId: string, parentStepId: string) => void
  now: () => number
}

type Phase = 'resolving' | 'watching' | 'responding'

type WatchTracker = {
  phase: Phase
  prNumber: number | null
  repoPath: string | null
  paneKey: string | null
  handledCursor: string // ISO; '' = nothing handled yet
  pendingWatermark: string // latest arming activity seen but not yet consumed
  dirty: boolean
  activeChildRunId: string | null
  cycleIndex: number
  idleSince: number | null // wall-clock the agent first looked idle this gate
  lastPollAt: number
  startedAt: number
}

export class WatchPrRunner implements StepRunner {
  private readonly trackers = new Map<string, Map<string, WatchTracker>>()
  constructor(private readonly deps: WatchPrDeps) {}

  async tick(ctx: StepRunnerCtx): Promise<StepRunnerResult> {
    const config = ctx.step.config as WatchPrConfig
    const tracker = this.getOrCreateTracker(ctx)
    // ... phases dispatched below (Tasks 6-9)
  }

  dropRun(runId: string): void {
    /* Task 10 */
  }
  dropStep(runId: string, stepId: string): void {
    /* Task 10 */
  }
}
```

**Step 2: Rehydrate durable progress from `ctx.state.output`**

The tracker is in-memory; the durable fields live on `ctx.state.output` (persisted by the executor on every tick via the result's `output`). `getOrCreateTracker` seeds a new tracker from `ctx.state.output` when present (so a restart resumes), else from defaults:

```typescript
private getOrCreateTracker(ctx: StepRunnerCtx): WatchTracker {
  let runMap = this.trackers.get(ctx.runId)
  let t = runMap?.get(ctx.step.id)
  if (t) return t
  const persisted = (ctx.state.output ?? {}) as Partial<WatchTracker>
  t = {
    phase: persisted.phase ?? 'resolving',
    prNumber: persisted.prNumber ?? null,
    repoPath: persisted.repoPath ?? null,
    paneKey: persisted.paneKey ?? null,
    handledCursor: persisted.handledCursor ?? '',
    pendingWatermark: persisted.pendingWatermark ?? '',
    dirty: persisted.dirty ?? false,
    activeChildRunId: persisted.activeChildRunId ?? null,
    cycleIndex: persisted.cycleIndex ?? 0,
    idleSince: null,
    lastPollAt: 0,
    startedAt: this.deps.now()
  }
  if (!runMap) {
    runMap = new Map()
    this.trackers.set(ctx.runId, runMap)
  }
  runMap.set(ctx.step.id, t)
  return t
}
```

A small helper `progressOutput(t)` returns the durable subset for every `StepRunnerResult.output` so the executor persists it.

**Step 3: Implement `resolving`**

```typescript
if (tracker.phase === 'resolving') {
  let resolvedRef: string
  try {
    resolvedRef = resolveTemplate(config.worktreeRef, ctx.context)
  } catch (e) {
    if (e instanceof TemplateResolutionError) return { outcome: 'failed', status: 'failed', error: e.message }
    throw e
  }
  const worktreeId = resolvedRef // single worktree only in v1
  const meta = this.deps.getWorktreeMeta(worktreeId)
  if (!meta) return { outcome: 'failed', status: 'failed', error: `Unknown worktree "${worktreeId}".` }
  const repoId = worktreeId.split('::')[0]
  const repoPath = this.deps.getRepoPath(repoId) ?? meta.repoPath
  let prNumber = meta.linkedPR ?? (await this.deps.resolveLinkedPR(meta.path, repoPath))
  if (prNumber == null) {
    return { outcome: 'needs-more-time', status: 'waiting', statusMessage: 'Waiting for PR to be linked', output: this.progressOutput(tracker) }
  }
  let paneKey: string
  try {
    paneKey = resolveTemplate(config.paneRef, ctx.context)
  } catch (e) {
    if (e instanceof TemplateResolutionError) return { outcome: 'failed', status: 'failed', error: e.message }
    throw e
  }
  tracker.prNumber = prNumber
  tracker.repoPath = repoPath
  tracker.paneKey = paneKey
  tracker.phase = 'watching'
}
```

**Step 4: Write the test** (`watch-pr-runner.test.ts`)

```typescript
it('resolving waits for a linked PR, then resolves pane + advances to watching', async () => {
  // deps.getWorktreeMeta returns linkedPR=null first, then 42 (or resolveLinkedPR returns 42)
  // context has steps.rp.paneKey='tab1:2'
  // First tick → waiting ('Waiting for PR to be linked'); second tick → no longer resolving
})
```

**Step 5: Run** — `pnpm vitest run src/main/automations/runners/watch-pr-runner.test.ts` → PASS.

**Step 6: Commit**

```bash
git add src/main/automations/runners/watch-pr-runner.ts src/main/automations/runners/watch-pr-runner.test.ts
git commit -m "feat(automations): watch-pr runner scaffolding + resolving phase"
```

---

## Task 7: WatchPrRunner — `watching`: terminal detection + arming

**Step 1: Implement terminal check (runs at the top of `watching` and `responding`)**

```typescript
private async checkTerminal(t: WatchTracker, ctx: StepRunnerCtx): Promise<StepRunnerResult | null> {
  // Forced teardown: workspace archived.
  const worktreeId = resolveTemplate((ctx.step.config as WatchPrConfig).worktreeRef, ctx.context)
  if (this.deps.isWorktreeArchived(worktreeId)) {
    this.deps.cancelChildRunsForStep(ctx.runId, ctx.step.id)
    return this.finish(t, 'archived', true, 'Stopped — workspace archived')
  }
  const state = await this.deps.getPRState(t.repoPath!, t.prNumber!, { noCache: true })
  if (state.state === 'MERGED') {
    this.deps.cancelChildRunsForStep(ctx.runId, ctx.step.id) // Q4: cancel in-flight
    return this.finish(t, 'merged', false, 'PR merged') // endChain=false → chain continues
  }
  if (state.state === 'CLOSED') {
    this.deps.cancelChildRunsForStep(ctx.runId, ctx.step.id)
    return this.finish(t, 'closed', true, 'PR closed') // endChain=true → chain stops
  }
  return null
}

private finish(t: WatchTracker, finalState: 'merged' | 'closed' | 'archived', endChain: boolean, msg: string): StepRunnerResult {
  const output = {
    finalState,
    cyclesRun: t.cycleIndex,
    prNumber: t.prNumber,
    prUrl: '', // fill from a cached PR url if available; otherwise compose
    finishedAt: this.deps.now()
  }
  return {
    outcome: 'done',
    status: 'succeeded',
    endChain,
    statusMessage: msg,
    output,
    contextPatch: { steps: { [/* step id passed in */ '']: output } }
  }
}
```

> Pass the step id into `finish` so `contextPatch.steps[stepId]` is correct. (Adjust signature accordingly — the snippet elides it for brevity.)

**Step 2: Implement arming** (the poll cadence + matching configured events)

```typescript
private armingMatches(review: PRReview, events: WatchPrConfig['events']): boolean {
  if (events.anyReview) return true
  if (events.changesRequested && review.state === 'CHANGES_REQUESTED') return true
  if (events.newReviewComments && review.state === 'COMMENTED') return true
  return false
}

// inside watching:
const pollIntervalMs = (config.pollIntervalSeconds ?? 30) * 1000
const nextPollAt = tracker.lastPollAt + pollIntervalMs
if (now >= nextPollAt) {
  tracker.lastPollAt = now
  const reviews = await this.deps.getPRReviews(tracker.repoPath!, tracker.prNumber!)
  const armed = reviews.filter(
    (r) => r.submittedAt && r.submittedAt > tracker.handledCursor && this.armingMatches(r, config.events)
  )
  if (armed.length > 0) {
    tracker.dirty = true
    tracker.pendingWatermark = armed[armed.length - 1].submittedAt
  }
}
```

**Step 3: Tests**
- merged → `done`/`succeeded`, `endChain` falsy, output.finalState='merged'.
- closed → `done`/`succeeded`, `endChain: true`, output.finalState='closed'.
- archived → `endChain: true`, finalState='archived', and `cancelChildRunsForStep` called.
- a `CHANGES_REQUESTED` review newer than cursor sets `dirty`; a `COMMENTED` review does **not** when only `changesRequested` is enabled; it **does** when `newReviewComments` is enabled.

**Step 4: Run** → PASS.

**Step 5: Commit**

```bash
git commit -am "feat(automations): watch-pr terminal detection + event arming"
```

---

## Task 8: WatchPrRunner — gate + spawn cycle + coalesce

**Step 1: Implement the four-part gate (end of `watching`)**

```typescript
if (tracker.dirty && tracker.activeChildRunId == null) {
  const status = this.deps.getAgentLiveStatus(tracker.paneKey!)
  const idle = status === 'idle' || status === 'done'
  if (!idle) {
    tracker.idleSince = null
    return { outcome: 'needs-more-time', status: 'waiting', statusMessage: 'Changes requested — waiting for agent to finish', nextPollAt: now + pollIntervalMs, output: this.progressOutput(tracker) }
  }
  if (tracker.idleSince == null) tracker.idleSince = now
  const debounceMs = (config.agentIdleDebounceSeconds ?? 5) * 1000
  if (now - tracker.idleSince < debounceMs) {
    return { outcome: 'needs-more-time', status: 'waiting', statusMessage: 'Agent idle — confirming before responding', output: this.progressOutput(tracker) }
  }
  // Fire a cycle.
  const cycleOutput = await this.buildCycleOutput(tracker, config) // per-cycle payload (Task 4/5 reads + summary)
  tracker.cycleIndex += 1
  ;(cycleOutput as Record<string, unknown>).cycleIndex = tracker.cycleIndex
  const childId = this.deps.spawnChildRun({
    parentRunId: ctx.runId,
    parentStepId: ctx.step.id,
    cycleIndex: tracker.cycleIndex,
    cycleOutput
  })
  tracker.activeChildRunId = childId
  tracker.handledCursor = tracker.pendingWatermark // consume up to the watermark
  tracker.dirty = false
  tracker.idleSince = null
  tracker.phase = 'responding'
}

// Stay alive watching.
return { outcome: 'needs-more-time', status: 'waiting', statusMessage: this.watchingLabel(tracker), nextPollAt: now + pollIntervalMs, output: this.progressOutput(tracker) }
```

`buildCycleOutput` fetches `getPRReviews` (latest arming review → author/state/body), `getPRComments` (filter `!isResolved` → `commentsJson` + `commentsSummary` via a `buildSummary`-style helper copied from `collect-ci-results-runner.ts:288`), and PR title/url, matching `WATCH_PR_CYCLE_SCHEMA`.

**Step 2: Tests**
- agent `working` → no spawn, status "waiting for agent to finish".
- agent `idle` but within debounce → no spawn yet.
- agent idle past debounce + dirty → `spawnChildRun` called once; `handledCursor` advanced to watermark; `dirty` cleared; phase `responding`.
- **Coalesce**: with phase `responding` and an active child (Task 9 wiring), a second arming review sets `dirty` again and advances `pendingWatermark`, so exactly one follow-up cycle fires after the child finishes (assert spawn called twice total, never concurrently).

**Step 3: Run** → PASS.

**Step 4: Commit**

```bash
git commit -am "feat(automations): watch-pr gate, cycle spawn, coalesce watermark"
```

---

## Task 9: WatchPrRunner — `responding`: observe child + re-evaluate

**Step 1: Implement**

```typescript
if (tracker.phase === 'responding') {
  const terminal = await this.checkTerminal(tracker, ctx) // merged/closed/archived cancels child + finishes
  if (terminal) return terminal

  // Keep arming-polling during the cycle so feedback that arrives mid-cycle
  // coalesces into the next round.
  await this.pollArming(tracker, config, now) // the Task 7 arming block, extracted

  const childStatus = this.deps.getChildRunStatus(tracker.activeChildRunId!)
  if (childStatus === 'active') {
    return { outcome: 'needs-more-time', status: 'waiting', statusMessage: `Responding (round ${tracker.cycleIndex})`, nextPollAt: now + pollIntervalMs, output: this.progressOutput(tracker) }
  }
  // Cycle finished (completed | failed | missing).
  if (childStatus === 'failed' && config.failedCycleHaltsLoop) {
    return { outcome: 'failed', status: 'failed', error: `Review cycle ${tracker.cycleIndex} failed.` }
  }
  tracker.activeChildRunId = null
  tracker.phase = 'watching'
  // Loop straight back: if feedback arrived during the cycle, the watching
  // block's gate fires the next cycle immediately.
  return { outcome: 'needs-more-time', status: 'waiting', statusMessage: this.watchingLabel(tracker), output: this.progressOutput(tracker) }
}
```

**Step 2: Tests**
- child `active` → stays `responding`, status "Responding (round N)".
- child `completed` → back to `watching`; if a mid-cycle arming review was recorded, the next tick spawns one more cycle (coalesced).
- merged mid-cycle → `cancelChildRunsForStep` called, `done`/`succeeded`, finalState='merged'.
- child `failed` + `failedCycleHaltsLoop: true` → `outcome: 'failed'`; default false → loop continues.

**Step 3: Run** → PASS.

**Step 4: Commit**

```bash
git commit -am "feat(automations): watch-pr responding phase + child observation"
```

---

## Task 10: WatchPrRunner — `dropRun` / `dropStep`

**Step 1: Implement** (cancel active child via the restart-safe service dep, then clear tracker)

```typescript
dropRun(runId: string): void {
  const runMap = this.trackers.get(runId)
  if (runMap) {
    for (const stepId of runMap.keys()) this.deps.cancelChildRunsForStep(runId, stepId)
  }
  this.trackers.delete(runId)
}

dropStep(runId: string, stepId: string): void {
  this.deps.cancelChildRunsForStep(runId, stepId)
  const runMap = this.trackers.get(runId)
  runMap?.delete(stepId)
  if (runMap && runMap.size === 0) this.trackers.delete(runId)
}
```

> Note: `cancelRun`/`retryRunFromStep` in the service *also* do query-based teardown (Task 12), so this is belt-and-suspenders for the in-memory case. Both are idempotent — `cancelRun` no-ops on an already-terminal child.

**Step 2: Tests** — `dropRun` and `dropStep` each call `cancelChildRunsForStep` for the tracked step and remove the tracker.

**Step 3: Run** → PASS.

**Step 4: Commit**

```bash
git commit -am "feat(automations): watch-pr dropRun/dropStep cancel active children"
```

---

## Task 11: Service wiring — register runner, deps, child-run tick

**Files:**
- Modify: `src/main/automations/service.ts` — construct runner (~after line 417), register in `resolveRunner` (line 720), `allRunners()` list, add `spawnChildRun`/`getChildRunStatus`/`cancelChildRunsForStep`, and intercept child runs in `tickRunningChains` (line 797).

**Step 1: Construct + register the runner**

After the `collectCiResultsRunner` construction (~line 417), add a `watchPrRunner = new WatchPrRunner({...})` wiring the deps to existing service capabilities:
- `getWorktreeMeta` / `getRepoPath` / `resolveLinkedPR` — reuse the exact closures passed to `CollectCiResultsRunner` (lift them to private methods if needed to avoid duplication — DRY).
- `isWorktreeArchived` — look up the worktree's group/worktree archived flag (the `isArchived` field on `WorkspaceGroup`/worktree meta).
- `getPRState` / `getPRReviews` / `getPRComments` — delegate to the github client.
- `getAgentLiveStatus(paneKey)` — reuse whatever the `RunPromptRunner` uses for `getAgentStatus` (`run-prompt-runner.ts:38`); map its richer status to `'working' | 'idle' | 'done' | 'unknown'`.
- `spawnChildRun` / `getChildRunStatus` / `cancelChildRunsForStep` — new service methods (below).
- `now: () => Date.now()`.

Add to `resolveRunner` (line 744):

```typescript
    if (kind === 'watch-pr') {
      return this.watchPrRunner
    }
```

And include `this.watchPrRunner` in `allRunners()`.

**Step 2: Implement `spawnChildRun`**

```typescript
spawnChildRun(args: {
  parentRunId: string
  parentStepId: string
  cycleIndex: number
  cycleOutput: Record<string, unknown>
}): string {
  const parent = this.store.listAutomationRuns().find((r) => r.id === args.parentRunId)
  if (!parent) throw new Error(`spawnChildRun: parent run ${args.parentRunId} not found`)
  const automation = this.store.listAutomations().find((a) => a.id === parent.automationId)
  if (!automation) throw new Error(`spawnChildRun: automation ${parent.automationId} not found`)
  const child = this.store.createAutomationRun(automation, Date.now(), 'manual')
  child.parentRunId = parent.id
  child.parentStepId = args.parentStepId
  child.cycleIndex = args.cycleIndex
  child.status = 'running'
  child.stepStates = []
  // Child context = deep clone of parent context + per-cycle payload under the
  // watch step id, so the branch templates {{steps.<run-prompt>.paneKey}} and
  // {{steps.<watch-id>.commentsSummary}}.
  const ctx = structuredClone(parent.context ?? {})
  const steps = (ctx.steps as Record<string, unknown>) ?? {}
  steps[args.parentStepId] = args.cycleOutput
  ctx.steps = steps
  child.context = ctx
  this.store.replaceAutomationRun(child)
  this.broadcastAutomationsChanged()
  this.wakeChains() // let the tick loop pick it up promptly
  return child.id
}
```

**Step 3: Implement `getChildRunStatus` + `cancelChildRunsForStep`**

```typescript
getChildRunStatus(childRunId: string): 'active' | 'completed' | 'failed' | 'missing' {
  const r = this.store.listAutomationRuns().find((x) => x.id === childRunId)
  if (!r) return 'missing'
  if (isActiveChainRunStatus(r.status)) return 'active'
  return r.status === 'completed' ? 'completed' : 'failed'
}

private cancelChildRunsForStep(parentRunId: string, parentStepId: string): void {
  for (const r of this.store.listAutomationRuns()) {
    if (r.parentRunId === parentRunId && r.parentStepId === parentStepId && isActiveChainRunStatus(r.status)) {
      this.cancelRun(r.id)
    }
  }
}

private cancelChildRunsForRun(parentRunId: string): void {
  for (const r of this.store.listAutomationRuns()) {
    if (r.parentRunId === parentRunId && isActiveChainRunStatus(r.status)) {
      this.cancelRun(r.id)
    }
  }
}
```

**Step 4: Intercept child runs in `tickRunningChains`** (line 812-818). For a child run, tick a synthesized automation whose `steps` are the parent watch step's `branchSteps`:

```typescript
      const automation = automations.get(run.automationId)
      if (!automation) {
        continue
      }
      const tickAutomation = run.parentRunId
        ? this.resolveChildRunAutomation(run, automation)
        : automation
      if (!tickAutomation) {
        continue
      }
      this.inFlightRunIds.add(run.id)
      try {
        await this.chainExecutor.tick(tickAutomation, run)
      } ...
```

```typescript
/** Build the transient automation a child (branch) run executes against: same
 *  trigger as the parent, steps = the watch step's branchSteps. Returns null if
 *  the parent automation/step is gone (the child will be cleaned up via cancel). */
private resolveChildRunAutomation(child: AutomationRun, parentAutomation: Automation): Automation | undefined {
  const step = flattenSteps(parentAutomation.steps ?? []).find((s) => s.id === child.parentStepId)
  if (!step || step.kind !== 'watch-pr') return undefined
  const branchSteps = (step.config as WatchPrConfig).branchSteps ?? []
  return { ...parentAutomation, steps: branchSteps }
}
```

**Step 5: Hook child teardown into existing cancel/retry** — see Task 12.

**Step 6: Typecheck**

Run: `pnpm tc:node`
Expected: PASS.

**Step 7: Commit**

```bash
git commit -am "feat(automations): wire watch-pr runner + child-run spawn/tick"
```

---

## Task 12: Service — child teardown on cancel + retry (restart-safe)

**Files:**
- Modify: `src/main/automations/service.ts` — `cancelRun` (line 868), `retryRunFromStep` (line 901-905), and the single-step retry path (`retryParallelStep` fallback / line 1027-1031).
- Test: extend the automations service test suite.

**Step 1: Write the failing test**

```typescript
it('cancelRun stops the watch loop by cancelling its child runs', () => {
  // arrange: a parent run with a watch-pr step + a non-terminal child run
  //          (parentRunId=parent.id, parentStepId='watch')
  service.cancelRun(parent.id)
  expect(service.getChildRunStatus(child.id)).toBe('failed') // cancelled → non-completed
})

it('retryRunFromStep before the watch step cancels the live child', () => {
  // arrange: parent run with [create-worktree, run-prompt, watch-pr] and a live child
  service.retryRunFromStep(parent.id, 0) // retry from step 0 → drops the watch step
  expect(service.getChildRunStatus(child.id)).toBe('failed')
})
```

**Step 2: Run to confirm failure** — children stay `active`.

**Step 3: Implement**

In `cancelRun`, after the `for (const runner of this.allRunners()) runner.dropRun?.(run.id)` loop (line 868-870), add:

```typescript
    // Stop any watch-pr loop owned by this run by cancelling its child runs.
    this.cancelChildRunsForRun(run.id)
```

> `dropRun` on the watch runner also calls `cancelChildRunsForStep` (Task 10); both are idempotent. The service-level call is the restart-safe source of truth (it queries the Store, not the in-memory tracker).

In `retryRunFromStep`, inside the `for (const state of droppedStates)` loop (line 901-905), after the `runner.dropStep?.()` calls, add:

```typescript
      this.cancelChildRunsForStep(run.id, state.stepId)
```

Apply the same line in the single-step retry path at line 1027-1031 (for the dropped target + downstream states).

**Step 4: Run the tests** → PASS. Then `pnpm vitest run` on the service suite for no regressions.

**Step 5: Commit**

```bash
git commit -am "feat(automations): cancel watch-pr child runs on stop + retry"
```

---

## Task 13: Editor — node, config panel, nested branch editor

**Files:**
- Modify: `src/renderer/src/components/automations/editor/` — the node-kind registry/palette, a new `WatchPrEditor.tsx`, and `chain-editor-modal-state.ts:161` (`getAvailableVariablesAtStep`) for branch scope.
- Reference: `HttpRequestEditor.tsx` (variable-picker usage), `CollectCiResultsEditor` (worktreeRef picker), `STYLEGUIDE.md` (tokens/components — required).

> UI is hard to TDD; lean on `pnpm tc:web` + manual verification. Keep each sub-step small and commit often.

**Step 1: Register the kind** in the palette/registry so "Watch PR / review loop" is addable, grouped near `collect-ci-results`. Wire default config: `events: { changesRequested: true, newReviewComments: false, anyReview: false }`, `pollIntervalSeconds: 30`, `agentIdleDebounceSeconds: 5`, `failedCycleHaltsLoop: false`, `branchSteps: []`. Add a label + icon + the variable-description entries (`src/renderer/src/lib/variable-descriptions.ts`) for the final + per-cycle fields.

**Step 2: `WatchPrEditor.tsx`** — config panel: `worktreeRef` picker (copy `collect-ci`); `paneRef` variable picker offering upstream `run-prompt` `paneKey`s; three `events` checkboxes (Changes requested default-on); `pollIntervalSeconds` + `agentIdleDebounceSeconds` number inputs; `failedCycleHaltsLoop` toggle. Use shadcn primitives + tokens per `STYLEGUIDE.md`; no invented colors/sizes.

**Step 3: Embedded branch editor** — render the existing chain-editor component scoped to `config.branchSteps` (read/write that array). Enforce the v1 constraint: the branch's add-node palette **omits** `watch-pr` (no nested loops).

**Step 4: Branch variable scope** — extend `getAvailableVariablesAtStep` (`chain-editor-modal-state.ts:161`) so, when editing a step *inside* a `branchSteps` array, the available namespace = the parent chain's variables up to the watch node **plus** `steps.<watch-id>.*` mapped to `WATCH_PR_CYCLE_SCHEMA` (the per-cycle payload). Outside the branch, `steps.<watch-id>.*` continues to map to `WATCH_PR_OUTPUT_SCHEMA`.

**Step 5: Run history** — surface child runs as nested/linked "Review round N" under the parent run; ensure the watch node renders its live `statusMessage` and a prominent **Stop**. (May be a follow-up commit if the history component is large — keep the node's status label working first.)

**Step 6: Typecheck + manual verify**

Run: `pnpm tc:web`
Expected: PASS (the `StepKind` switch in the editor is now exhaustive).
Then manually: add the node, build a 1-step branch (`run-prompt` with `paneRef: {{steps.<rp>.paneKey}}`), save, reload — config persists.

**Step 7: Commit** (one per sub-step is fine):

```bash
git commit -am "feat(automations): watch-pr editor + nested branch + branch variable scope"
```

---

## Task 14: Full verification + PR

**Step 1: Typecheck both projects**

Run: `pnpm tc:node && pnpm tc:web`
Expected: PASS.

**Step 2: Targeted tests**

Run:
```bash
pnpm vitest run \
  src/main/automations/runners/watch-pr-runner.test.ts \
  src/main/automations/chain-executor.test.ts \
  src/shared/automation-step-schemas.test.ts \
  src/main/github/client.test.ts
```
Plus the automations service test file touched in Task 12.
Expected: PASS.

**Step 3: Self-review** — REQUIRED SUB-SKILL: `superpowers:requesting-code-review` against the design doc. Confirm: terminal mapping (merged→continue, closed→stop via `endChain`), coalesce semantics, restart-safe child teardown on Stop + retry, pane safety (`selfOpenedPane: false` never closes the supervised pane).

**Step 4: Commit any review fixes, then open the PR**

```bash
git push -u origin "$(git branch --show-current)"
gh pr create --title "Watch PR / review-loop automation node" --body "<summary + design-doc link>"
```

---

## Notes / risk register

- **Single-tick reentrancy:** `tickRunningChains` already guards with `inFlightRunIds` and runs runs in series — child + parent are distinct run ids, so they tick independently and safely.
- **`structuredClone` of context:** context holds JSON-ish data (strings/numbers/booleans/nested objects). Confirm no functions/handles leak into `run.context` before cloning; if they do, swap for a JSON round-trip.
- **`prUrl` in final output:** if a PR url isn't already cached on the worktree meta, compose it or fetch once during `resolving` and stash on the tracker.
- **Poll-cost:** one `getPRState` (noCache) + occasional `getPRReviews` per node per `pollIntervalSeconds`. With many concurrent watch nodes, consider a shared PR-state cache later (out of scope for v1).
- **DRY the PR-resolution closures** shared with `CollectCiResultsRunner` rather than copy-pasting.
