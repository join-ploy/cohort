# Watch PR / Review Loop — Automation Node Design

## Goal

Add a `watch-pr` step kind: a **long-lived** automation node that, instead of completing, watches a PR for its entire lifetime and runs an attached **sub-graph of nodes** ("the branch") each time changes are requested. It reuses the existing pane (the agent that did the work) to address feedback, loops as many times as needed, and only terminates when the PR is **merged** or **closed** (or it is torn down). It is structurally a sibling of `collect-ci-results` but never finishes on its own schedule.

The motivating flow: a chain creates a worktree, runs a `run-prompt` that does the work and opens a PR (and a pane), then a `watch-pr` node parks on that PR. When a reviewer requests changes, the node waits for the agent to be idle, then drives a branch that re-prompts the **same pane** with the review feedback and pushes. It does this every review round until merge/close.

## Scope (v1)

- **Single** worktree / PR / pane per node. Group-scoped multi-PR watching is deferred — it muddies "the existing paneKey."
- The branch is a normal chain (`StepOrGroup[]`), executed per cycle as a child run (see below).

## Step Config

```typescript
type WatchPrConfig = {
  worktreeRef: string          // template — resolves the PR (like collect-ci-results)
  paneRef: string              // template — the supervised pane (e.g. {{steps.<run-prompt>.paneKey}})
  events: {                    // which review activity arms a response cycle
    changesRequested: boolean  //   default: true
    newReviewComments: boolean //   default: false
    anyReview: boolean         //   default: false
  }
  pollIntervalSeconds: number      // PR-state poll cadence (default 30)
  agentIdleDebounceSeconds: number // "right moment" gate — idle window before firing
  failedCycleHaltsLoop?: boolean   // default false: a failed cycle keeps the loop alive
  branchSteps: StepOrGroup[]       // the sub-graph run each cycle
}
```

- **worktreeRef** — resolved via the standard template system to a single worktree, then to its linked PR number + repo path. Mirrors `collect-ci-results-runner` phase 2.
- **paneRef** — the pane the loop supervises. It is both the **idle-gate signal** (we poll the agent's status here to find the "right moment") and the pane the branch inherits and targets.
- **events** — which review activity arms a cycle. Configurable per node; default is formal **"Changes requested"** only (crispest signal, least noise).
- **agentIdleDebounceSeconds** — reuses the `run-prompt` done-debounce idea: the agent must be idle this long before a cycle fires, so we never interrupt an in-flight turn.
- **failedCycleHaltsLoop** — if a branch cycle fails, by default the loop keeps watching (the failure is recorded on that cycle's child run). Set true to halt the whole watch on a failed cycle.

## Terminal Semantics — the key difference

Every other runner returns a terminal outcome promptly. `watch-pr` returns `needs-more-time` / `waiting` **indefinitely**, parking the parent run in `waiting` (potentially for days), until one of these:

| End condition | Detection | Result |
|---|---|---|
| **Merged** | `getPRState` → `MERGED` | `done` / `succeeded`. Chain **advances** — downstream steps run. |
| **Closed** | `getPRState` → `CLOSED` | `done` / `succeeded` + `endChain: true`. Chain **stops cleanly** — downstream steps do not run. |
| **Workspace archived** | `isWorktreeArchived(worktreeId)` per tick | `done` / `succeeded` + `endChain: true`. Status: "stopped — workspace archived". |
| **Run cancelled / Stop button / automation deleted** | existing `cancelRun` (`service.ts:836`) → `runner.dropRun` | Active child cancelled; run ends `cancelled`; downstream do not run. |
| **Retry from this or an earlier step** | existing `retryRunFromStep` (`service.ts:882`) → `runner.dropStep` | Active child cancelled; loop torn down; the chain re-reaches the node and starts a **fresh** loop. |

The service already re-ticks `waiting` runs on its 60s cadence (`evaluateDueRuns` → `tickRunningChains`), so no scheduler change is needed.

### `merged → continue, closed → stop`: the `endChain` executor extension

Today the executor (`chain-executor.ts`) only ends a position two ways: advance to the next step, or **halt via `outcome: 'failed'` + `onFailure: 'halt'`** (which marks the run `failed`). There is no "finish cleanly but stop here." Representing an intentional PR close as a `failed` run would pollute failure counts and alerting.

So we add a **small, general** result field:

```typescript
// step-runner.ts — StepRunnerResult
endChain?: boolean  // when true with outcome 'done', finalize the run as 'completed'
                    // immediately and do NOT advance to downstream steps.
```

In `tickSoloStep` / `tickParallelGroup`, when a runner returns `outcome: 'done'` with `endChain: true`, call `finalizeRun` (status `completed`) and return `false`. This rides on the existing **lazy-stepStates** model — downstream steps simply never get materialized, exactly like a halted run but with a clean `completed` status. The field is reusable for any future "early clean exit," which is why we add it rather than overload the failure path.

A **closed** PR therefore yields a `completed` run (same bucket as a normal success); the "closed" detail lives on the watch node's own status/output. No new run-level status value is introduced.

## Behavior — the watch loop state machine

The runner keeps an in-memory tracker per `(runId, stepId)` (same pattern as `collect-ci-results-runner.ts:34`), but the **durable** fields below are persisted onto the step state so a restart resumes correctly.

**Durable progress (persisted on step state):** `handledCursor`, `activeChildRunId`, `cycleIndex`, `phase`.

Phases:

1. **`resolving`** — resolve `worktreeRef` → PR number + repo path, and `paneRef` → paneKey. No PR linked yet → `waiting` ("Waiting for PR to be linked"), retry on interval (mirrors collect-ci `waiting-for-prs`).

2. **`watching`** — every `pollIntervalSeconds` (gated by `nextPollAt`):
   - **Terminal check first** — merged/closed/archived per the table above.
   - **Arming check** — find review activity newer than `handledCursor` matching the configured `events`. If found, set `dirty = true` and capture the **coalesce watermark** = the latest matching activity timestamp seen this poll.

3. **Gate ("the right moment")** — fire a cycle only when **all** hold:
   - `dirty`, and
   - PR is open, and
   - no active child run, and
   - the supervised pane's agent has been **idle** for `agentIdleDebounceSeconds` (via `getAgentStatus(paneKey)`).

   Until then, stay `waiting` with a live status ("Changes requested — waiting for agent to finish").

4. **`responding`** — spawn a child run (below), store `activeChildRunId`, advance `handledCursor` to the watermark, clear `dirty`, bump `cycleIndex`. Keep polling:
   - merged/closed/archived mid-cycle → **cancel the child immediately** and go terminal (in-flight response is moot once the PR is settled).
   - child finalizes → if new `dirty` arrived **during** the cycle (coalesced), re-evaluate the gate immediately; else return to `watching`.

Status messages drive the node's live label: *"Watching #123 · 2 cycles · next poll 18s"* / *"Responding (round 3)"*.

### Coalescing

Never interrupt a running cycle. While `responding`, additional arming events set `dirty` and advance the watermark. When the active cycle finishes, **one** follow-up cycle runs with the combined feedback (all review activity since the cycle started). Two near-simultaneous reviews collapse into a single response.

### Fresh loop on re-reach

When `retryRunFromStep` drops the watch step's state, its durable progress is wiped. The re-reached loop starts with an **empty `handledCursor`**, so a *still-standing* "changes requested" arms a cycle on the first poll — the right post-retry behavior: upstream work was redone, the PR still wants changes, so the loop responds again. (Same property covers the rare case of attaching to an already-reviewed PR.)

## Sub-graph execution — child run per cycle

Goal: **total reuse of `ChainExecutor`** so the branch gets parallel groups, retry, halt/continue, and pane cleanup for free.

**Spawning a cycle.** The watch runner calls a new dep `spawnChildRun`, creating an `AutomationRun` with new optional fields:

```typescript
// AutomationRun (additions)
parentRunId?: string   // the watch run's id
parentStepId?: string  // the watch step's id
cycleIndex?: number    // 1-based review round
```

- The child run carries **no `steps` of its own**. Its step source is resolved at tick time (below).
- `context` = a deep clone of the **parent run's context** (so `{{steps.<upstream>.paneKey}}`, `{{trigger.*}}`, `{{group.*}}` resolve) **merged with the watch node's per-cycle payload** under `steps.<watch-id>.*`.

**Ticking a child run.** The service's `tickRunningChains` already iterates running/waiting runs. For a child run it looks up the parent automation → the watch step → `config.branchSteps`, synthesizes a transient `Automation`-shaped `{ trigger: parent.trigger, steps: branchSteps }`, and calls `chainExecutor.tick(synthetic, childRun)`. The executor's guard at `chain-executor.ts:91` passes; everything downstream is unchanged.

**Closing the loop.** The parent watch runner observes `getChildRunStatus(activeChildRunId)`. When terminal (`completed`/`failed`), the cycle is done; the watcher re-evaluates its gate. A failed cycle does **not** fail the parent (default `failedCycleHaltsLoop: false`).

**Pane safety.** The branch's `run-prompt` targets the supervised pane via `paneRef` → `selfOpenedPane: false`, so cancelling or finishing a child **never** closes the supervised pane. Only panes a child self-opened are cleaned up.

## Variables / Output Schemas

Two consumers, two payloads.

### (a) Per-cycle payload → seeded into each child run's context

Lives under `steps.<watch-id>.*` **inside the branch**, so the branch's `run-prompt` templates against the review feedback:

```typescript
{
  prNumber: number
  prUrl: string
  prTitle: string
  reviewState: string          // e.g. 'CHANGES_REQUESTED'
  reviewAuthor: string         // who armed this cycle (latest arming review)
  reviewBody: string           // that review's top-level body
  commentsJson: string         // unresolved threads: [{path,line,author,body,...}]
  commentsSummary: string      // markdown digest (reuse collect-ci buildSummary shape)
  cycleIndex: number           // 1-based
  changeRequestCount: number   // arming events folded into this cycle (coalesced)
}
```

A natural branch prompt: *"A reviewer requested changes on PR #{{steps.watch.prNumber}}. Feedback:\n{{steps.watch.commentsSummary}}\n\nAddress it, then push."* — running on the existing pane via `paneRef: {{steps.<run-prompt>.paneKey}}`.

### (b) Final payload → the watch step's own output in the parent run

Available to downstream steps after merge:

```typescript
export const WATCH_PR_OUTPUT_SCHEMA: OutputSchema = {
  finalState: 'string',   // 'merged' | 'closed' | 'archived'
  cyclesRun: 'number',
  prNumber: 'number',
  prUrl: 'string',
  finishedAt: 'number',
}
```

**Scope-dependent meaning of `steps.<watch-id>.*`:** inside the branch it resolves to the **per-cycle** payload (a); after the watch node in the parent chain it resolves to the **final** payload (b). Same step id, scope-dependent.

`WATCH_PR_OUTPUT_SCHEMA` (the final shape) is registered in `SCHEMA_BY_KIND` (`automation-step-schemas.ts`) so the editor's variable picker offers `{{steps.watch.finalState}}` to downstream steps. The per-cycle schema is surfaced only inside the branch editor.

## GitHub Integration

New read functions in `src/main/github/client.ts`, alongside `getPRChecks` (`client.ts:1024`) and `getPRComments` (`client.ts:1150`):

- **`getPRState(repoPath, prNumber)`** → `{ state: 'OPEN' | 'MERGED' | 'CLOSED', mergedAt, closedAt, reviewDecision }` via `gh pr view <n> --json state,mergedAt,closedAt,reviewDecision`. Drives the terminal check + a cheap "is anything requesting changes" pre-filter.
- **`getPRReviews(repoPath, prNumber)`** → `[{ id, author, state, submittedAt, body }]` via `gh api repos/{owner}/{repo}/pulls/{n}/reviews`. The **arming feed**: filter to `submittedAt > handledCursor`, match against configured `events`. Newest match's `submittedAt` becomes the coalesce watermark and, once consumed, the new `handledCursor`.
- **Unresolved threads** reuse `getPRComments` (already returns review threads with `isResolved`, `client.ts:1096`); filter to `!isResolved` for `commentsJson` / `commentsSummary`.

**Cadence & caching.** Polling is gated by `nextPollAt` at `pollIntervalSeconds` (default 30), like collect-ci. The terminal + arming reads pass `noCache` (or a short TTL), but **only** when the interval elapses — at most one state poll per node per interval, batched state+reviews. Respects the rate-limit guidance in AGENTS.md.

**Dedup across restart.** `handledCursor` (ISO timestamp / high-water review id) is persisted on the step state, so a rehydrated watcher never re-fires a cycle for an already-handled review.

**Cross-repo / fork PRs.** Reads work by PR number against the base repo, so fork PRs (`isCrossRepository`) need no special handling.

## Lifecycle, Cleanup & Restart Resilience

**Single teardown rule:** on cancel, delete, archive, *or* retry-drop, **cancel all non-terminal child runs whose `parentStepId` is being torn down** — found by **querying the Store** (`parentRunId == runId` and `parentStepId ∈ dropped steps`), not the in-memory tracker. This mirrors the existing restart-safe pane cleanup (`closePersistedStepPanes`, `service.ts:922`) and survives an app restart that wiped the tracker.

- **`dropRun(runId)`** — cancel all non-terminal child runs of this run, then clear the tracker.
- **`dropStep(runId, stepId)`** — cancel non-terminal child runs for that step, then clear that step's tracker. **Required** so retry-from-earlier-step stops the old loop before the chain re-reaches the node.
- Child cancellation is **fire-and-forget** — `cancelRun` is idempotent and the existing pane cleanup is synchronous, so the watch step goes terminal immediately without blocking on the child settling.
- Completed cycles stay as historical "Review round N" records; only non-terminal ones are cancelled.

**Restart.** The watch tracker rebuilds lazily on the next tick from the durable step-state fields. The child run is an ordinary persisted `AutomationRun`, so the service resumes ticking it automatically; the parent re-attaches via `activeChildRunId`. If the app was closed while archived, the first post-restart tick sees `isWorktreeArchived` and tears down.

**Two stop affordances, kept separate:**
- **Run Stop button** → `cancelRun(parentRunId)` → stops the *whole loop* and ends the run. Because the run parks in `waiting` for days, Stop is the primary manual exit and must be prominent while watching.
- **Agent stop** (interrupting the agent inside the supervised pane) → stops only that turn; the loop sees the agent go idle and, if feedback remains unhandled, eventually re-fires. Stopping a stuck agent must not tear down the loop.

## Editor / UX

- **Palette:** new "Watch PR / review loop" node, grouped near `collect-ci-results`.
- **Config panel:** `worktreeRef` picker; `paneRef` variable picker (offers upstream `run-prompt` `paneKey`s); `events` checkboxes (Changes requested ✓ default); `pollIntervalSeconds`; `agentIdleDebounceSeconds`; `failedCycleHaltsLoop` toggle.
- **The branch:** an **embedded nested chain editor** scoped to `branchSteps` (reuse the existing chain-editor component). Its variable picker (`getAvailableVariablesAtStep`, `chain-editor-modal-state.ts:161`) is extended so the branch sees all upstream parent variables **plus** the watch node's per-cycle payload (`steps.<watch-id>.*`).
- **Run history:** the parent run shows the watch node live (*"Watching #123 · 2 cycles · next poll 18s"*) with a prominent **Stop**; each cycle's child run appears nested/linked as *"Review round N"*, independently inspectable and retryable.

## Testing Strategy

The watch runner is a pure state machine over injected deps (like `collect-ci-results-runner`), so most coverage is fast unit tests with fakes for `now`, `getPRState`, `getPRReviews`, `getPRComments`, `getAgentStatus`, `spawnChildRun`, `getChildRunStatus`, `cancelChildRun`.

**`watch-pr-runner.test.ts`:**
- `resolving` waits for PR link; resolves paneKey.
- **Arming**: fires only on configured `events` (changes-requested by default; comment-only review ignored unless `newReviewComments`).
- **Gate**: no cycle while agent is `working`; fires only after `agentIdleDebounceSeconds` idle + PR open + `dirty`.
- **Coalesce**: two arming reviews during one cycle → exactly one follow-up cycle; `handledCursor` advances once.
- **Terminal**: merged → `done`/`succeeded`; closed → `done`/`succeeded`+`endChain`; both cancel an in-flight child.
- **Restart dedup**: rehydrate from persisted `handledCursor` → no duplicate cycle for an already-handled review.
- **Teardown**: `dropRun` and `dropStep` both cancel the active child.

**Service-level (extend the automations service suite):**
- `spawnChildRun` seeds child context = parent context + per-cycle payload (`{{steps.<run-prompt>.paneKey}}` and `{{steps.watch.commentsSummary}}` both resolve in the branch).
- Query-based teardown: retry-from-earlier-step cancels a live child found by `parentStepId` (restart-safe, not in-memory).
- `endChain` finalizes the run `completed` without materializing downstream steps; a normal `done` advances them.

**`chain-executor.test.ts`:** the `endChain` field — `done` + `endChain` finalizes `completed` and stops; `done` without it advances. Light integration: a `branchSteps` chain `run-prompt`(paneRef) → `run-command` runs to completion under the synthesized automation.

**Verification commands:** `pnpm tc:node` + `pnpm tc:web`, and targeted `pnpm vitest run` on new/changed test files — not the full suite or `tc:cli` (known unrelated failures).

## Files Touched (summary)

| Area | File | Change |
|---|---|---|
| Types | `src/shared/automations-types.ts` | `'watch-pr'` in `StepKind`; `WatchPrConfig`; `AutomationRun.parentRunId/parentStepId/cycleIndex` |
| Output schema | `src/shared/automation-step-schemas.ts` | `WATCH_PR_OUTPUT_SCHEMA` + `SCHEMA_BY_KIND` entry; per-cycle schema |
| Executor | `src/main/automations/chain-executor.ts` | honor `endChain`; synthesize child-run step source |
| Step runner | `src/main/automations/step-runner.ts` | `endChain?` on `StepRunnerResult` |
| Runner | `src/main/automations/runners/watch-pr-runner.ts` | new runner (state machine) |
| Service | `src/main/automations/service.ts` | register runner; `spawnChildRun`; tick child runs; query-based child teardown in cancel/retry |
| GitHub | `src/main/github/client.ts` | `getPRState`, `getPRReviews` |
| Editor | `src/renderer/src/components/automations/editor/` | new node UI + embedded branch editor; variable scope for branch |
| Tests | `*.test.ts` per the strategy above | — |
