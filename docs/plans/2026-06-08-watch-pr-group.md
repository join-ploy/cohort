# Watch PR — Workspace-Group Extension Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend the existing single-PR `watch-pr` node to watch all PRs of a workspace group, batching responses on the shared group pane so member PRs never contend for the one agent pane.

**Architecture:** Same `watch-pr` StepKind, auto-detecting group vs single via `expandRef`. The runner's scalar PR state becomes a **per-member map** with a singular shared pane-cycle; the gate fires ONE batched cycle over all currently-dirty members; the node finalizes when every member is settled (all-merged → continue, any-closed → stop). All new logic lives in the runner — `spawnChildRun`, child-run tick, teardown, the `endChain` signal, and output persistence are unchanged.

**Tech Stack:** TypeScript (Electron main + React renderer), Vitest, `gh` CLI, the existing `WatchPrRunner` + `ChainExecutor` + `AutomationService`.

**Design doc:** `docs/plans/2026-06-08-watch-pr-group-design.md` — read it first. Single-PR base: `docs/plans/2026-06-08-watch-pr-review-loop-design.md`.

**Verification:** `pnpm tc:node`, `pnpm tc:web`, targeted `pnpm vitest run <file>` (renderer suites need `--config config/vitest.config.ts`). Never the full suite or `tc:cli` (known unrelated failures). Use `tsgo` via the `tc:*` scripts.

**Sequencing rationale:** Task 3 is a behavior-preserving refactor that makes EVERY phase per-member-capable while resolving still creates ONE member — so the 25 existing single-PR tests stay green (rewritten to the new progress shape). Task 4 then just turns on group expansion in resolving, and the already-N-capable phases light up.

---

## Task 1: Generalize the output schemas

**Files:**
- Modify: `src/shared/automation-step-schemas.ts` (`WATCH_PR_CYCLE_SCHEMA`, `WATCH_PR_OUTPUT_SCHEMA`)
- Test: `src/shared/automation-step-schemas.test.ts`

**Step 1: Write failing tests** — extend the existing `describe('watch-pr schema')`:

```typescript
it('cycle schema carries batched + convenience fields', () => {
  expect(WATCH_PR_CYCLE_SCHEMA).toEqual({
    memberCount: 'number',
    combinedSummary: 'string',
    membersJson: 'string',
    cycleIndex: 'number',
    changeRequestCount: 'number',
    prNumber: 'number',
    prUrl: 'string',
    reviewState: 'string',
    reviewAuthor: 'string',
    reviewBody: 'string',
    commentsJson: 'string',
    commentsSummary: 'string'
  })
})

it('final schema carries the group tally', () => {
  expect(WATCH_PR_OUTPUT_SCHEMA).toEqual({
    finalState: 'string',
    memberCount: 'number',
    mergedCount: 'number',
    closedCount: 'number',
    membersJson: 'string',
    cyclesRun: 'number',
    prNumber: 'number',
    prUrl: 'string',
    finishedAt: 'number'
  })
})
```

**Step 2: Run → FAIL** — `pnpm vitest run src/shared/automation-step-schemas.test.ts`.

**Step 3: Implement** — replace the two schema constants:

```typescript
export const WATCH_PR_OUTPUT_SCHEMA: OutputSchema = {
  finalState: 'string', // 'all-merged' | 'partial-closed' | (single: 'merged' | 'closed' | 'archived')
  memberCount: 'number',
  mergedCount: 'number',
  closedCount: 'number',
  membersJson: 'string', // [{ worktreeId, prNumber, prUrl, finalState }]
  cyclesRun: 'number',
  prNumber: 'number', // first/only member — single-PR convenience
  prUrl: 'string',
  finishedAt: 'number'
}

export const WATCH_PR_CYCLE_SCHEMA: OutputSchema = {
  memberCount: 'number',
  combinedSummary: 'string', // markdown: one section per batched member PR + feedback
  membersJson: 'string', // [{ worktreeId, prNumber, prUrl, prTitle, reviewState, reviewAuthor, reviewBody, commentsJson, commentsSummary }]
  cycleIndex: 'number',
  changeRequestCount: 'number',
  // First/only batched member — keeps existing single-PR branch prompts working:
  prNumber: 'number',
  prUrl: 'string',
  reviewState: 'string',
  reviewAuthor: 'string',
  reviewBody: 'string',
  commentsJson: 'string',
  commentsSummary: 'string'
}
```

Keep the existing `SCHEMA_BY_KIND['watch-pr'] = WATCH_PR_OUTPUT_SCHEMA`. Update the older Task-2 assertions in this test file that pinned the previous shapes (e.g. the `toEqual` on the old final schema) so they match the generalized shapes.

**Step 4: Run → PASS** (both watch-pr schema tests + the whole file).

**Step 5: `pnpm tc:node` + `pnpm tc:web`** → green (the renderer reads these schemas; the variable-descriptions test may need the new keys — Task 5 handles descriptions, but if `variable-descriptions.test.ts` asserts exhaustive coverage of schema keys it will fail now; if so, note it and add the description entries in this task to keep tc/web green, otherwise defer to Task 5).

**Step 6: Commit**
```bash
git add src/shared/automation-step-schemas.ts src/shared/automation-step-schemas.test.ts
git commit -m "feat(automations): generalize watch-pr schemas for grouped PRs"
```

---

## Task 2: Add group deps to the runner + wire them in the service

**Files:**
- Modify: `src/main/automations/runners/watch-pr-runner.ts` (`WatchPrDeps`)
- Modify: `src/main/automations/service.ts` (watchPrRunner construction)
- Test: `src/main/automations/service.test.ts`

These deps mirror what `CollectCiResultsRunner` already receives. Additive — the runner won't call them until Task 3/4.

**Step 1: Extend `WatchPrDeps`** (after `resolveLinkedPR`):

```typescript
  /** All workspace groups, for expanding a group:<uuid> worktreeRef into members. */
  getWorkspaceGroups: () => readonly import('../../../shared/types').WorkspaceGroup[]
  /** True when the worktree has a diff from main — a no-diff member has no PR. */
  hasChangesFromMain: (
    worktreeId: string,
    path: string,
    connectionId: string | null
  ) => Promise<boolean>
  /** Connection id for a repo (SSH-aware), passed to hasChangesFromMain. */
  getConnectionId: (repoId: string) => string | null
```

(Prefer a top-of-file `import type { WorkspaceGroup } from '../../../shared/types'` and use `WorkspaceGroup` directly rather than the inline import.)

**Step 2: Wire in the service** — in the `new WatchPrRunner({...})` construction (`service.ts` ~line 449), add the three deps, reusing the EXACT closures the `CollectCiResultsRunner` construction uses (lift to private methods if duplicating bothers you — `getWorkspaceGroups: () => this.store.getWorkspaceGroups()`, `hasChangesFromMain` via `hasPromptTargetChangesFromMain`, `getConnectionId: (repoId) => this.store.getRepo(repoId)?.connectionId ?? null`).

**Step 3: Test** — extend `service.test.ts` to assert the watchPrRunner is constructed without error and (lightly) that resolveRunner('watch-pr') still returns it. (Most coverage stays in the runner suite.)

**Step 4: `pnpm tc:node`** → green. `pnpm vitest run src/main/automations/service.test.ts` → pass.

**Step 5: Commit**
```bash
git add src/main/automations/runners/watch-pr-runner.ts src/main/automations/service.ts src/main/automations/service.test.ts
git commit -m "feat(automations): group deps for watch-pr runner (expand/hasChanges)"
```

---

## Task 3: Per-member refactor (behavior-preserving for single-PR)

**The big one.** Refactor the runner so every phase operates over a `members` map + a singular shared pane-cycle, while `resolving` still creates exactly ONE member. The 25 existing single-PR tests are rewritten to the new progress shape and must stay green.

**Files:**
- Modify: `src/main/automations/runners/watch-pr-runner.ts`
- Modify: `src/main/automations/runners/watch-pr-runner.test.ts`

**Step 1: New tracker + progress types** (replace the scalar fields):

```typescript
type Settled = 'open' | 'merged' | 'closed'

type MemberState = {
  worktreeId: string
  prNumber: number
  repoPath: string
  prUrl: string
  handledCursor: string
  pendingWatermark: string
  dirty: boolean
  settled: Settled
}

type WatchTracker = {
  phase: 'resolving' | 'watching' | 'responding'
  members: Map<string, MemberState> // keyed by worktreeId
  paneKey: string | null
  activeChildRunId: string | null
  cycleIndex: number
  idleSince: number | null
  lastPollAt: number
  startedAt: number
}

// Durable subset (members as a plain array so it serialises to state.output).
type WatchProgress = {
  phase: WatchTracker['phase']
  members: Array<Pick<MemberState, 'worktreeId' | 'prNumber' | 'repoPath' | 'prUrl' | 'handledCursor' | 'pendingWatermark' | 'dirty' | 'settled'>>
  paneKey: string | null
  activeChildRunId: string | null
  cycleIndex: number
}
```

`getOrCreateTracker` rehydrates `members` from `persisted.members ?? []` (Map ← array), and `progressOutput` serialises `members` back to an array. (Restart-safe per-member round-trip.)

**Step 2: `resolving` creates ONE member.** Keep the current single-worktree logic but write the result into `tracker.members.set(worktreeId, { worktreeId, prNumber, repoPath, prUrl: '', handledCursor: '', pendingWatermark: '', dirty: false, settled: 'open' })`. Resolve the single `paneRef` onto `tracker.paneKey`. (Group expansion is Task 4.)

**Step 3: Generalize `checkTerminal` → per-member settle + aggregate finish.** Rename/rework so it: (a) if archived → cancel child + `finish('archived', endChain:true)`; (b) for each non-settled member, `getPRState`; MERGED/CLOSED → set `member.settled`, cache `member.prUrl = state.url`; (c) if EVERY member is settled → cancel the active child and `finishAggregate(tracker, stepId)`; else return null (keep watching). Add `finishAggregate`:

```typescript
private finishAggregate(stepId: string, tracker: WatchTracker): StepRunnerResult {
  const members = [...tracker.members.values()]
  const merged = members.filter((m) => m.settled === 'merged')
  const allMerged = members.length > 0 && merged.length === members.length
  const finalState = allMerged ? 'all-merged' : 'partial-closed'
  const first = members[0]
  const output = {
    finalState,
    memberCount: members.length,
    mergedCount: merged.length,
    closedCount: members.filter((m) => m.settled === 'closed').length,
    membersJson: JSON.stringify(members.map((m) => ({ worktreeId: m.worktreeId, prNumber: m.prNumber, prUrl: m.prUrl, finalState: m.settled }))),
    cyclesRun: tracker.cycleIndex,
    prNumber: first?.prNumber ?? 0,
    prUrl: first?.prUrl ?? '',
    finishedAt: this.deps.now()
  }
  return { outcome: 'done', status: 'succeeded', endChain: !allMerged, statusMessage: allMerged ? 'All PRs merged' : 'Group settled — some PRs closed', output, contextPatch: { steps: { [stepId]: output } } }
}
```
(Note: the single-member 'merged'→continue / 'closed'→stop is preserved — 1 merged member ⇒ all-merged ⇒ endChain false; 1 closed ⇒ partial-closed ⇒ endChain true. The `finish('archived', …)` path stays for archive.)

**Step 4: Generalize the sweep + gate.** Replace `pollArming`'s single read with a per-member loop (cadence-gated as today): for each non-settled member, `getPRReviews(member.repoPath, member.prNumber)` then `armFromReviews(reviews, member, config)` (operate on the member's cursor/dirty/watermark). The gate condition becomes `members has any dirty ∧ activeChildRunId == null ∧ idle(debounced)`. On fire: collect `batch = [...members.values()].filter(m => m.dirty && m.settled === 'open')`; `buildCycleOutput(batch, tracker)`; spawn one child; per batched member advance `handledCursor = pendingWatermark`, clear `dirty`.

**Step 5: Generalize `buildCycleOutput(batch, tracker)`** → batched payload:

```typescript
private async buildCycleOutput(batch: MemberState[], tracker: WatchTracker, config: WatchPrConfig): Promise<Record<string, unknown>> {
  const perMember = []
  let totalArmed = 0
  for (const m of batch) {
    const reviews = await this.deps.getPRReviews(m.repoPath, m.prNumber)
    const armed = reviews.filter((r) => r.submittedAt && r.submittedAt > m.handledCursor && this.armingMatches(r, config.events))
    totalArmed += armed.length
    const latest = armed.at(-1)
    const prState = await this.deps.getPRState(m.repoPath, m.prNumber)
    m.prUrl = prState.url
    const comments = (await this.deps.getPRComments(m.repoPath, m.prNumber)).filter((c) => !c.isResolved)
    perMember.push({ worktreeId: m.worktreeId, prNumber: m.prNumber, prUrl: prState.url, prTitle: prState.title, reviewState: latest?.state ?? '', reviewAuthor: latest?.author ?? '', reviewBody: latest?.body ?? '', commentsJson: JSON.stringify(comments), commentsSummary: buildCommentsSummary(comments) })
  }
  const first = perMember[0]
  return {
    memberCount: batch.length,
    combinedSummary: buildCombinedSummary(perMember), // '## PR #<n> (repo)\n<summary>' per member
    membersJson: JSON.stringify(perMember),
    cycleIndex: tracker.cycleIndex,
    changeRequestCount: totalArmed,
    prNumber: first?.prNumber ?? 0,
    prUrl: first?.prUrl ?? '',
    reviewState: first?.reviewState ?? '',
    reviewAuthor: first?.reviewAuthor ?? '',
    reviewBody: first?.reviewBody ?? '',
    commentsJson: first?.commentsJson ?? '[]',
    commentsSummary: first?.commentsSummary ?? ''
  }
}
```
Add module-level `buildCombinedSummary(perMember)` — for each entry, a `## PR #${prNumber} (${repoName})` header + the member's `commentsSummary` (+ `reviewBody` if present); join with blank lines. `repoName` = `repoPath.split('/').pop()` (compute from the member; thread repoPath into perMember if needed). Keep the existing `buildCommentsSummary`.

**Step 6: `responding`** — `getChildRunStatus` every tick; per-interval do the per-member terminal sweep (via the generalized checkTerminal) + per-member arming; child active → stay; child failed + halt → fail; else loop back to watching. (Structure unchanged; just calls the generalized helpers.)

**Step 7: Rewrite the runner tests to the new progress shape.** The existing tests assert `result.output.phase/prNumber/dirty/cycleIndex/activeChildRunId/handledCursor`. Update them to read from `result.output.members[0].*` (per-member fields) and the top-level `phase/activeChildRunId/cycleIndex`. The behaviors (resolve, terminal merged/closed/archived, arming, gate/debounce/spawn, coalesce, responding transitions, drop hooks) all stay — only the assertion paths change for the per-member shape. Keep every existing scenario; they're the single-PR regression guarantee (1-member batch). For the terminal tests: merged ⇒ `finalState: 'all-merged'`, endChain false; closed ⇒ `finalState: 'partial-closed'`, endChain true.

**Step 8: Run** — `pnpm vitest run src/main/automations/runners/watch-pr-runner.test.ts` (all pass) + `pnpm vitest run src/main/automations/chain-executor.test.ts` (no regress) + `pnpm tc:node` green.

**Step 9: Commit**
```bash
git add src/main/automations/runners/watch-pr-runner.ts src/main/automations/runners/watch-pr-runner.test.ts
git commit -m "refactor(automations): per-member watch-pr tracker (single = 1-member batch)"
```

---

## Task 4: Group expansion — turn on multi-PR

**Files:**
- Modify: `src/main/automations/runners/watch-pr-runner.ts` (resolving phase only)
- Modify: `src/main/automations/runners/watch-pr-runner.test.ts`

**Step 1: Add an `expandRef` helper** mirroring `collect-ci-results-runner.ts`'s:

```typescript
private expandRef(ref: string): string[] | null {
  const memberScoped = parseMemberScopedRef(ref)
  if (memberScoped) return [memberScoped.worktreeId]
  if (ref.startsWith('group:')) {
    const group = findGroupById(ref, this.deps.getWorkspaceGroups())
    return group ? group.memberWorktreeIds : null
  }
  return [ref] // single worktree
}
```
Import `parseMemberScopedRef` from `'../../../shared/automation-member-scoped-ref'` and `findGroupById` from `'../../workspace-group-runtime'` (same imports collect-ci uses).

**Step 2: Group-aware `resolving`.** Replace the single-member creation with: `const worktreeIds = this.expandRef(resolvedRef)` (fail if null); for each id, `getWorktreeMeta` (skip if gone); filter to `hasChangesFromMain(id, meta.path, getConnectionId(repoId))` (a no-diff member has no PR — skip it); resolve `prNumber` per member (`meta.linkedPR ?? resolveLinkedPR`), and if ANY expected member's PR isn't linked yet return `needs-more-time` ('Waiting for PRs to be linked'); populate `tracker.members` with one `MemberState` per eligible member. Resolve the single `paneRef`. If zero eligible members → `finish` immediately as all-merged-with-0 (or a clean done with memberCount 0 — mirror collect-ci's "nothing to collect"). Decide and comment.

**Step 3: Group tests** (new `describe('WatchPrRunner — group')`). Extend `makeDeps` with `getWorkspaceGroups`/`hasChangesFromMain`/`getConnectionId` stubs. A helper to seed a group ref + N members.
- **Expansion**: a `group:` ref with 2 members (both with changes, both PR-linked) → tracker has 2 members; a 3rd no-diff member is skipped (hasChangesFromMain false).
- **Waits for all PRs linked**: one member unlinked → `needs-more-time`.
- **Batched arming/firing**: members A + B both armed (CHANGES_REQUESTED), pane idle → exactly ONE `spawnChildRun`; `cycleOutput.memberCount === 2`, `combinedSummary` contains both PR sections, `membersJson` length 2, both members' `handledCursor` advanced and `dirty` cleared.
- **Per-member settle**: A merges (getPRState MERGED) while B open → node stays watching (no finish); then B merges → `finishAggregate` 'all-merged', endChain false.
- **Aggregate any-closed**: A merged, B closed → 'partial-closed', endChain true.
- **Settle-mid-cycle (last member)**: child active, A already settled, B merges → all settled → `cancelChildRunsForStep` called + finish.
- **Cross-member coalesce**: child active (batch was [A]); B arms mid-cycle; child completes → next gate fires batch [B] (second spawn).
- **Restart**: rehydrate `members[]` with one settled + one open → settled member not re-armed; open member still polled.

**Step 4: Run** — `pnpm vitest run src/main/automations/runners/watch-pr-runner.test.ts` (single + group all pass) + `pnpm tc:node` green.

**Step 5: Commit**
```bash
git add src/main/automations/runners/watch-pr-runner.ts src/main/automations/runners/watch-pr-runner.test.ts
git commit -m "feat(automations): watch-pr group expansion + batched cross-member responses"
```

---

## Task 5: Editor — group hint + generalized branch variables

**Files:**
- Modify: `src/renderer/src/lib/variable-descriptions.ts` (entries for the new cycle/final fields)
- Modify: `src/renderer/src/components/automations/editor/WatchPrStepCard.tsx` (group hint)
- Test: the existing editor tests (`variable-descriptions.test.ts`, `chain-editor-modal-state.test.ts`) must stay green.

**Step 1: Variable descriptions** — add entries for the new fields on both schemas: `memberCount`, `combinedSummary`, `membersJson`, `mergedCount`, `closedCount` (and confirm `finalState` description mentions `all-merged`/`partial-closed`). If `variable-descriptions.test.ts` asserts every schema leaf has a description, this keeps it green.

**Step 2: Group hint** in `WatchPrStepCard.tsx` — when `config.worktreeRef` is a `group:` ref (or template that looks group-shaped), render a one-line muted note under the worktree field: *"Watches all member PRs; batches responses on the shared pane."* Use existing tokens (`text-muted-foreground text-xs`). Keep it purely informational; no new config.

**Step 3: Run** — `pnpm tc:web` → 0 errors. `pnpm vitest run --config config/vitest.config.ts src/renderer/src/lib/variable-descriptions.test.ts src/renderer/src/components/automations/editor/WatchPrStepCard.test.tsx src/renderer/src/components/automations/editor/chain-editor-modal-state.test.ts` → pass.

**Step 4: Commit**
```bash
git add -A
git commit -m "feat(automations): watch-pr editor group hint + grouped variable descriptions"
```

---

## Task 6: Full verification + finish

**Step 1: Gates**
```bash
pnpm tc:node && pnpm tc:web
```
Both 0 errors.

**Step 2: Targeted suites**
```bash
pnpm vitest run src/shared/automation-step-schemas.test.ts src/main/automations/chain-executor.test.ts src/main/github/client.test.ts src/main/automations/runners/watch-pr-runner.test.ts src/main/automations/service.test.ts
pnpm vitest run --config config/vitest.config.ts src/renderer/src/components/automations/editor/ src/renderer/src/lib/variable-descriptions.test.ts
```
All pass.

**Step 3: Self-review** — REQUIRED SUB-SKILL: `superpowers:requesting-code-review` against both design docs. Confirm: single-PR regression intact (1-member batch), batched firing spawns exactly one child for N dirty members, per-member settle + aggregate exit (all-merged→continue / any-closed→stop), cross-member coalesce, restart per-member round-trip, and that service/executor/teardown were genuinely untouched.

**Step 4:** Fix any findings, then proceed to `superpowers:finishing-a-development-branch` for the PR (single-PR + group in one PR).

---

## Notes / risk register

- **Regression is the #1 risk.** Task 3 must keep every single-PR behavior identical (1-member batch). The rewritten tests are the guard — do not delete scenarios, only re-path assertions to `members[0]`.
- **`armFromReviews` now takes a member**, not the tracker — it mutates that member's cursor/dirty/watermark. Keep it cadence-free (the caller owns the poll gate, as today).
- **Poll cost** scales O(members) per interval — bounded and gated. No per-tick `getPRState` (the Task-9 cadence fix applies per member).
- **Empty group** (no eligible members): decide between an immediate clean `done` vs failing; mirror collect-ci's "nothing to collect" done. Comment the choice.
- **`combinedSummary` repoName**: thread `repoPath` (or a derived repo label) into each perMember entry so the header reads `## PR #12 (repo-a)`.
- **`spawnChildRun` is unchanged** — it seeds whatever `cycleOutput` the runner builds; the batched payload flows through untouched.
