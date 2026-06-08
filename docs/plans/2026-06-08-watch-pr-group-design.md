# Watch PR — Workspace-Group Extension Design

> Extends the single-PR `watch-pr` node (`docs/plans/2026-06-08-watch-pr-review-loop-design.md`) to a **workspace group** with multiple member PRs. Read that design first — this doc only describes the deltas.

## Goal

Let a `watch-pr` node scoped to a `group:<uuid>` ref watch **all** member PRs at once and respond to changes across the group on the **shared** group pane, **batching and queueing** responses so they never contend for that one agent pane.

## The core insight: the conflict is pane contention

In a workspace group, members very likely share **one** supervised pane — the group agent whose CWD spans the member repos ("they'll use the same previous paneKey"). An agent pane can run only one turn at a time, so N member PRs funnelling onto one pane **must** be serialized. That is the whole reason for batching/queueing — not file conflicts, not load, but "one pane, one turn."

This yields a clean primitive: **a group node = N member PRs → 1 shared pane → batched, serialized responses.** The single-PR node is the degenerate 1-member case.

## Decisions (from brainstorming)

1. **Conflict source** — shared-pane contention.
2. **Response unit** — ONE batched cycle covering all currently-pending members on the pane; mid-cycle arrivals coalesce into the next batch. One branch definition, executed once per batch with combined context.
3. **Aggregate exit** — all members merged → continue downstream; any member closed-without-merge → stop cleanly (`endChain`).
4. **Settle-mid-cycle** — a single member settling mid-batch is silent (drops from watching, batch finishes); only the **last** member settling cancels the in-flight cycle and finalizes.

## Same node, auto-detecting (no new StepKind)

`worktreeRef` is already a template; we let it resolve to a single worktree (today) **or** a `group:<uuid>` ref. The runner branches on `expandRef` — the exact helper `collect-ci-results-runner` uses to fan a group into `memberWorktreeIds`. Single worktree = 1-member batch, so **config, editor, service wiring, executor, and child-run machinery are unchanged**. All new logic lives in the runner.

**Pane model:** one `paneRef` = the shared group pane. Out of scope (handled by composing N single-PR nodes): a group whose members deliberately have distinct per-member panes.

## Resolving phase (delta)

Instead of one `getWorktreeMeta`, the runner:
1. `expandRef(resolvedWorktreeRef)` → `memberWorktreeIds` (single id → `[id]`).
2. Filter to members with changes from main (reuse `collect-ci`'s `hasChangesFromMain`) — a no-diff member has no PR and is skipped.
3. Per member: resolve `prNumber` (`meta.linkedPR ?? resolveLinkedPR`), waiting (`needs-more-time`) until each expected PR is linked — like `collect-ci` phase 2.
4. Resolve the single `paneRef`.

## Tracker / WatchProgress (delta)

The scalar `prNumber`/`repoPath`/`handledCursor`/`dirty`/`pendingWatermark` become a **per-member map**; the cycle state stays singular (one shared pane → one in-flight cycle).

```ts
type MemberState = {
  worktreeId: string
  prNumber: number
  repoPath: string
  handledCursor: string      // per-member high-water (ISO)
  pendingWatermark: string
  dirty: boolean
  settled: 'open' | 'merged' | 'closed'
}

type WatchTracker = {
  phase: 'resolving' | 'watching' | 'responding'
  members: Map<string, MemberState>   // keyed by worktreeId
  paneKey: string | null
  prUrlByMember: Record<string, string> // cached for final tally
  // shared pane-cycle state (singular):
  activeChildRunId: string | null
  cycleIndex: number
  idleSince: number | null
  lastPollAt: number
  startedAt: number
}
```

Durable `WatchProgress` grows a `members[]` array (`worktreeId, prNumber, handledCursor, dirty, settled`) plus the shared `activeChildRunId`/`cycleIndex`/`phase`/`paneKey`. On rehydrate, settled members stay settled (no re-arming already-handled feedback); the active child re-attaches; the sweep resumes for open members.

## Watching — per-member sweep, batched firing

**Per poll interval (one gated sweep, O(members) gh reads):** for each non-settled member: `getPRState` (terminal) + `getPRReviews` (arming). A member review newer than *its own* `handledCursor` matching the configured events sets *that member's* `dirty` and advances *its* `pendingWatermark`. A member going MERGED/CLOSED is stamped `settled` and dropped from the sweep (its outcome recorded).

**Gate (generalized condition):** fire when **any** member is `dirty` ∧ `activeChildRunId == null` ∧ the shared pane's agent is idle for `agentIdleDebounceSeconds`. On fire:
1. Collect all currently-`dirty` members → the **batch**.
2. Build the batched `cycleOutput` (below).
3. `spawnChildRun` (one child) → store `activeChildRunId`.
4. Per batched member: advance `handledCursor = pendingWatermark`, clear `dirty`.
5. `cycleIndex += 1`, `phase = 'responding'`.

**Coalescing across members (the "queue"):** while `responding`, the per-interval sweep keeps arming members; a review on any member (in the batch or not) re-sets that member's `dirty`. When the child finishes, if any member is dirty, the next gate fires a fresh batch. No separate queue structure — the existing coalesce, generalized to "any member dirty."

## Responding (delta)

Every tick: `getChildRunStatus`. Per interval: terminal sweep (settles members) + arming (coalesce). Then:
- child `active` → stay responding.
- child terminal + `failedCycleHaltsLoop` + failed → run fails (unchanged).
- else → `activeChildRunId = null`, `phase = 'watching'`, loop back (a coalesced batch fires next tick).

## Batched cycle output (generalized `WATCH_PR_CYCLE_SCHEMA`)

Backward-compatible so the *same* branch prompt works for single-PR and group nodes.

```ts
{
  memberCount: number          // members in THIS batch (1 for single-PR)
  combinedSummary: string      // markdown: one '## PR #<n> (repo)' section per batched member + feedback
  membersJson: string          // [{ worktreeId, prNumber, prUrl, prTitle, reviewState, reviewAuthor,
                               //    reviewBody, commentsJson, commentsSummary }]
  cycleIndex: number
  changeRequestCount: number    // total arming reviews folded across all batched members
  // First/only batched member — keeps existing single-PR branch prompts working:
  prNumber: number
  prUrl: string
  reviewBody: string
  commentsSummary: string
}
```

`combinedSummary` is built by reusing the single-PR `buildCommentsSummary` per batched member and concatenating with per-PR headers. Natural group branch prompt:

> *"Reviewers requested changes across this group:\n{{steps.watch.combinedSummary}}\n\nAddress each PR's feedback in its repo and push."*

## Aggregate exit (generalized `WATCH_PR_OUTPUT_SCHEMA`)

Node completes only when **every** member is `settled`. Then:
- all `merged` → `finish('all-merged', endChain: false)` → chain continues.
- any `closed` → `finish('partial-closed', endChain: true)` → run completes cleanly, downstream skipped.

```ts
{
  finalState: 'all-merged' | 'partial-closed'  // 'merged'/'closed' alias for single-member back-compat
  memberCount: number
  mergedCount: number
  closedCount: number
  membersJson: string          // [{ worktreeId, prNumber, prUrl, finalState }]
  cyclesRun: number
  finishedAt: number
}
```

**Settle-mid-cycle:** a single member settling mid-batch only marks it settled (batch finishes). When the member that settles is the **last** open one, cancel the in-flight child (`cancelChildRunsForStep`) and finalize immediately — consistent with the single-PR "cancel in-flight, complete now."

## Unchanged (the payoff)

All per-member logic lives in the runner. **No changes** to: `spawnChildRun` (seeds whatever `cycleOutput` the runner builds), child-run tick interception, `cancelChildRunsForRun`/`cancelChildRunsForStep` teardown (one shared child at a time), the `endChain` executor signal, or non-terminal output persistence.

## Editor / UX (small)

- `worktreeRef` picker already offers `group:` refs (same picker as `collect-ci`); add a one-line hint when a group is selected: *"Watches all member PRs; batches responses on the shared pane."*
- Branch variable picker reflects the generalized `WATCH_PR_CYCLE_SCHEMA` (`combinedSummary`, `membersJson`, `memberCount`) with `variable-descriptions` entries.
- `paneRef`, events, intervals, branch editor, nested-watch-pr defenses: unchanged.

## Testing (extends the runner suite)

- Group expansion → per-member PR resolve (mirror `collect-ci` targets test); no-diff member skipped.
- Batched arming: members A + B dirty → exactly ONE child spawned; `cycleOutput.memberCount === 2`, `combinedSummary` has both sections, each member's `handledCursor` advanced.
- Per-member settle: A merges while B open → keep watching B; B settles (last) → finalize.
- Aggregate exit: all-merged → `endChain` false / `'all-merged'`; one closed → `endChain` true / `'partial-closed'`.
- Cross-member coalesce: review on C mid-cycle → next batch includes C.
- Restart: rehydrate `members[]`; settled members don't re-arm.
- **Regression:** single-worktree ref behaves exactly as today (1-member batch); an existing single-PR branch prompt still resolves via the convenience scalars.

Verification: `pnpm tc:node` + `tc:web` + targeted vitest.

## Files touched (summary)

| Area | File | Change |
|---|---|---|
| Schemas | `src/shared/automation-step-schemas.ts` | generalize `WATCH_PR_CYCLE_SCHEMA` + `WATCH_PR_OUTPUT_SCHEMA` |
| Runner | `src/main/automations/runners/watch-pr-runner.ts` | per-member tracker, group expansion, batched arming/firing, per-member settle, aggregate exit, generalized `buildCycleOutput`/`finish` |
| Service deps | `src/main/automations/service.ts` | wire `getWorkspaceGroups`/`hasChangesFromMain`/`expandRef` deps into the watch runner (reuse collect-ci's) |
| Editor | `src/renderer/.../WatchPrStepCard.tsx`, `variable-descriptions.ts` | group hint + generalized per-cycle vars |
| Tests | `watch-pr-runner.test.ts`, schema tests | per the strategy above |

The bulk is the runner; the service gains only a few collect-ci-style deps (`getWorkspaceGroups`, `hasChangesFromMain`, group `expandRef`).
