# Watch PR — Detached Mode + Pane Queue Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `detached` mode that runs the `watch-pr` loop as an independent background run (so the chain continues), plus a general FIFO pane queue so no two run-prompts drive the same agent pane at once.

**Architecture:** A service-wide `Map<paneKey, token[]>` FIFO queue (head holds the pane); the run-prompt runner acquires the head before driving an agent and releases on terminal/drop. Detached reuses the child-run/tick-interception machinery: the watch step spawns a background run carrying the same step (flagged `__watchDetached`) and returns `done`. Pause is a `run.paused` flag the tick loop skips.

**Tech Stack:** TypeScript (Electron main + React renderer), Vitest, the existing `WatchPrRunner`/`RunPromptRunner`/`AutomationService`/`ChainExecutor`.

**Design doc:** `docs/plans/2026-06-08-watch-pr-detached-and-pane-queue-design.md` — read it first.

**Verification:** `pnpm tc:node`, `pnpm tc:web`, targeted `pnpm vitest run <file>` (renderer suites need `--config config/vitest.config.ts`). Never the full suite or `tc:cli`. Use `tsgo` via `tc:*`.

**Risk:** Task 3 (pane queue threaded into `run-prompt-runner`) touches a hot, subtle path (the agent-status / `requiresWorkingFirst` reuse logic). TDD it hard; `releasePane` is idempotent so over-releasing is safe, and the tests must prove every terminal path frees the pane.

---

## Task 1: Types

**Files:** Modify `src/shared/automations-types.ts`.

**Step 1:** Add `detached?: boolean` to `WatchPrConfig` (after `endOnApprove?`):
```typescript
  // When true, the watch step spawns a background run and returns immediately
  // so the chain continues; the background run carries the loop until terminal.
  detached?: boolean
```

**Step 2:** Add to `AutomationRun` (after `cycleIndex?`):
```typescript
  // Set on a background watch run spawned by a detached watch-pr step (provenance
  // / UI grouping only — no teardown coupling to the spawner).
  detachedFromRunId?: string
  // When true, tickRunningChains skips this run (paused). State is preserved.
  paused?: boolean
```

**Step 3:** `pnpm tc:node` → green. **Commit:** `feat(automations): types for watch-pr detached mode + run pause`.

---

## Task 2: Pane queue core (service)

**Files:** Modify `src/main/automations/service.ts`. Test: `src/main/automations/service.test.ts`.

A FIFO queue keyed by paneKey; head holds. Pure-ish, easy to unit test via casts (the existing service tests construct the real `AutomationService`).

**Step 1: Write failing tests** (new describe in `service.test.ts`):
```typescript
describe('AutomationService pane queue', () => {
  it('grants the pane to the first acquirer (FIFO), others wait until release', () => {
    const svc = makeService() // however the existing tests build it
    const q = svc as unknown as {
      acquirePane(p: string, t: string): boolean
      releasePane(p: string, t: string): void
    }
    expect(q.acquirePane('pane1', 'A')).toBe(true)   // A is head
    expect(q.acquirePane('pane1', 'B')).toBe(false)  // B waits
    expect(q.acquirePane('pane1', 'A')).toBe(true)   // idempotent re-acquire by head
    q.releasePane('pane1', 'A')
    expect(q.acquirePane('pane1', 'B')).toBe(true)   // B is now head
  })

  it('keeps panes independent', () => {
    const q = makeService() as unknown as { acquirePane(p: string, t: string): boolean }
    expect(q.acquirePane('p1', 'A')).toBe(true)
    expect(q.acquirePane('p2', 'B')).toBe(true)
  })

  it('releasePane on a non-head / unknown token is a no-op (idempotent)', () => {
    const q = makeService() as unknown as {
      acquirePane(p: string, t: string): boolean
      releasePane(p: string, t: string): void
    }
    q.acquirePane('p', 'A')
    q.releasePane('p', 'NOPE') // unknown — no throw, A still head
    expect(q.acquirePane('p', 'A')).toBe(true)
  })
})
```
(Use whatever the file's existing helper is for constructing the service; if there's no `makeService`, mirror the Task-11/12 watch-pr service tests' construction.)

**Step 2:** Run → FAIL (methods missing).

**Step 3: Implement** — add a field + two methods:
```typescript
/** FIFO pane queue: paneKey → ordered waiter tokens (`${runId}:${stepId}`). The
 *  head holds the pane. Ephemeral (in-memory) so a restart can't deadlock — steps
 *  re-register on their next tick. */
private readonly paneQueue = new Map<string, string[]>()

/** Register `token` for `paneKey` (tail) if new; return true iff it is the head
 *  (the holder). Synchronous — call before any await so only the head ever drives. */
acquirePane(paneKey: string, token: string): boolean {
  let q = this.paneQueue.get(paneKey)
  if (!q) {
    q = []
    this.paneQueue.set(paneKey, q)
  }
  if (!q.includes(token)) {
    q.push(token)
  }
  return q[0] === token
}

/** Remove `token` from `paneKey`'s queue (idempotent). The next waiter becomes
 *  the holder on its next tick. */
releasePane(paneKey: string, token: string): void {
  const q = this.paneQueue.get(paneKey)
  if (!q) {
    return
  }
  const idx = q.indexOf(token)
  if (idx !== -1) {
    q.splice(idx, 1)
  }
  if (q.length === 0) {
    this.paneQueue.delete(paneKey)
  }
}

/** Release every pane claim held/queued by a run (any step). Called from the
 *  cancel/teardown paths so a dead holder never blocks the queue. */
private releasePanesForRun(runId: string): void {
  for (const [paneKey, q] of this.paneQueue) {
    const filtered = q.filter((t) => !t.startsWith(`${runId}:`))
    if (filtered.length === 0) {
      this.paneQueue.delete(paneKey)
    } else if (filtered.length !== q.length) {
      this.paneQueue.set(paneKey, filtered)
    }
  }
}
```

**Step 4:** Wire `releasePanesForRun(run.id)` into `cancelRun` (right where it cancels child runs / drops runners) so a stopped run frees its panes. (Per-step release on retry is handled in Task 3 via `dropStep`.)

**Step 5:** Run → PASS. `pnpm tc:node` → green. **Commit:** `feat(automations): FIFO pane queue (acquire/release) in service`.

---

## Task 3: run-prompt-runner — acquire/hold/release around driving

**Files:** Modify `src/main/automations/runners/run-prompt-runner.ts`. Wire deps in `src/main/automations/service.ts`. Test: `src/main/automations/runners/run-prompt-runner.test.ts`.

**Step 1: Add deps** to `RunPromptDeps`:
```typescript
  /** Pane FIFO queue. acquirePane returns true only when this token holds the
   *  pane; releasePane frees it. token = `${runId}:${stepId}`. */
  acquirePane: (paneKey: string, token: string) => boolean
  releasePane: (paneKey: string, token: string) => void
```
Wire in the service's `new RunPromptRunner({...})`: `acquirePane: (p, t) => this.acquirePane(p, t)`, `releasePane: (p, t) => this.releasePane(p, t)`.

**Step 2: Acquire before driving.** `const token = \`${ctx.runId}:${ctx.step.id}\``.
- **Reuse branch** (`paneRef.length > 0`, ~line 299): BEFORE the `getAgentStatus(paneRef)` gate, add:
  ```typescript
  if (!this.deps.acquirePane(paneRef, token)) {
    return { outcome: 'needs-more-time', status: 'waiting', statusMessage: 'Waiting for pane' }
  }
  ```
  (We hold the pane while we then wait for the agent to be idle and send — correct: no one else can jump in.)
- **Open branch** (after `paneKey = result.paneKey`, ~line 362): `this.deps.acquirePane(paneKey, token)` (returns true — fresh key; we claim it so a concurrent paneRef reuse of this key queues behind us).

**Step 3: Release on every terminal + drop.** `releasePane` is idempotent, so release at each `done`/`failed` exit AFTER a pane was acquired. The sites:
- Reuse branch: the `blocked`/`waiting` → `failed` return and the `SendPromptToPaneError` → `failed` return — add `this.deps.releasePane(paneRef, token)` before each.
- Poll path (subsequent ticks, ~line 390+): every terminal return — the `done` return, the timeout `failed`, the `blocked`/`waiting` `failed`, and any agent-error `failed` — add `this.deps.releasePane(tracker.paneKey, token)` before returning. (READ the poll path and cover all `outcome: 'done' | 'failed'` returns.)
- `dropStep(runId, stepId)` and `dropRun(runId)`: release the pane(s) for the dropped step(s). In `dropStep`, the tracker has `paneKey` — `this.deps.releasePane(tracker.paneKey, \`${runId}:${stepId}\`)` for the dropped step. In `dropRun`, release for every tracked step. (The service's `releasePanesForRun` is a backstop, but releasing here keeps the runner self-consistent.)

To keep it maintainable, consider a tiny private helper `private release(ctx, paneKey): void { this.deps.releasePane(paneKey, \`${ctx.runId}:${ctx.step.id}\`) }` and call it at each site.

**Step 4: Tests** (`run-prompt-runner.test.ts`, extend `makeDeps` with `acquirePane: vi.fn(() => true)`, `releasePane: vi.fn()`):
1. **Waits when not head:** `acquirePane` returns false → reuse-branch tick returns `{ outcome: 'needs-more-time', status: 'waiting', statusMessage: 'Waiting for pane' }`, and `sendPromptToPane` was NOT called.
2. **Drives when head:** `acquirePane` true → sends, builds tracker, returns needs-more-time.
3. **Releases on done:** drive a reuse step to completion (agent `done`) → `releasePane(paneKey, token)` called once.
4. **Releases on failure:** the `blocked`/`waiting` human-input path → `releasePane` called.
5. **Releases on dropStep:** acquire (tracker exists) then `dropStep` → `releasePane` called.

**Step 5:** Run the run-prompt suite + `pnpm vitest run src/main/automations/service.test.ts` + `pnpm tc:node` → green. **Commit:** `feat(automations): run-prompt acquires/releases the pane queue`.

---

## Task 4: Detached mode (runner spawn + service spawn + tick interception)

**Files:** Modify `watch-pr-runner.ts`, `service.ts`. Tests in both `*.test.ts`.

**Step 1: Runner deps + spawn branch.** Add to `WatchPrDeps`:
```typescript
  /** Spawn the background detached watcher run; returns its id. */
  spawnDetachedWatcher: (args: { fromRunId: string; stepId: string; context: Record<string, unknown> }) => string
```
At the TOP of `tick` (after resolving `config`, before the phase machine), add:
```typescript
const config = ctx.step.config as WatchPrConfig
if (config.detached && !ctx.context.__watchDetached) {
  const detachedRunId = this.deps.spawnDetachedWatcher({
    fromRunId: ctx.runId,
    stepId: ctx.step.id,
    context: ctx.context
  })
  return {
    outcome: 'done',
    status: 'succeeded',
    statusMessage: 'Watching in the background',
    output: { detached: true, detachedRunId },
    contextPatch: { steps: { [ctx.step.id]: { detached: true, detachedRunId } } }
  }
}
```
(When `__watchDetached` is set — i.e. we ARE the detached run — fall through to the normal loop, so no re-spawn.)

**Step 2: Service `spawnDetachedWatcher`** (mirror `spawnChildRun`, but the run carries the watch step and the flag):
```typescript
spawnDetachedWatcher(args: { fromRunId: string; stepId: string; context: Record<string, unknown> }): string {
  const parent = this.store.listAutomationRuns().find((r) => r.id === args.fromRunId)
  if (!parent) throw new Error(`spawnDetachedWatcher: run ${args.fromRunId} not found`)
  const automation = this.store.listAutomations().find((a) => a.id === parent.automationId)
  if (!automation) throw new Error(`spawnDetachedWatcher: automation ${parent.automationId} not found`)
  const run = this.store.createAutomationRun(automation, Date.now(), 'manual')
  if (run.id === parent.id) throw new Error('spawnDetachedWatcher: aliased parent (scheduledFor collision)')
  run.detachedFromRunId = parent.id
  run.parentStepId = args.stepId // reuse this field to resolve the watch step (below)
  run.status = 'running'
  run.stepStates = []
  const ctx = structuredClone(args.context)
  ctx.__watchDetached = true // makes the watch runner run the loop, not re-spawn
  run.context = ctx
  this.store.replaceAutomationRun(run)
  this.broadcastAutomationsChanged()
  this.wakeChains()
  return run.id
}
```

**Step 3: Tick interception for detached runs.** In `tickRunningChains`, the child-run branch resolves steps from the parent's watch step's `branchSteps`. A detached run instead ticks against the **single watch step itself**. Extend `resolveChildRunAutomation` (or add a sibling) so:
- A run with `detachedFromRunId` set → look up the watch step (`parentStepId`) in the spawner's automation, return `{ ...automation, steps: [watchStep] }`.
- A run with `parentRunId` set (existing branch child) → unchanged (branchSteps).

Make sure the branch detection in `tickRunningChains` covers BOTH `run.parentRunId` and `run.detachedFromRunId` as "synthetic step source" runs.

**Step 4: Tests.**
- Runner: `detached: true` + context without `__watchDetached` → `spawnDetachedWatcher` called once; result `{ outcome: 'done', status: 'succeeded' }`, output.detached true. With `__watchDetached: true` → does NOT call spawn; runs resolving (returns waiting / advances).
- Service: `spawnDetachedWatcher` builds a run with `detachedFromRunId`, `status: 'running'`, `context.__watchDetached === true`, and the resolveChildRunAutomation path returns the single watch step. `cancelRun(spawnerRunId)` does NOT cancel the detached run (assert it stays active); `cancelRun(detachedRunId)` cancels it.

**Step 5:** `pnpm tc:node` + the two suites → green. **Commit:** `feat(automations): watch-pr detached background run`.

---

## Task 5: Pause / resume

**Files:** Modify `src/main/automations/service.ts`. Test: `service.test.ts`.

**Step 1:** In `tickRunningChains`, after the `isActiveChainRunStatus` / `inFlightRunIds` guards, add `if (run.paused) { continue }`. In `scheduleFastTickIfRunsActive`'s `hasActiveRun` predicate, also exclude paused runs (`&& !run.paused`).

**Step 2:** Add `pauseRun(runId)` / `resumeRun(runId)`:
```typescript
pauseRun(runId: string): AutomationRun | undefined {
  const run = this.store.listAutomationRuns().find((r) => r.id === runId)
  if (!run || !isActiveChainRunStatus(run.status)) return run
  run.paused = true
  this.store.replaceAutomationRun(run)
  this.broadcastAutomationsChanged()
  return run
}
resumeRun(runId: string): AutomationRun | undefined {
  const run = this.store.listAutomationRuns().find((r) => r.id === runId)
  if (!run) return undefined
  run.paused = false
  this.store.replaceAutomationRun(run)
  this.broadcastAutomationsChanged()
  this.wakeChains()
  return run
}
```
Expose these via the existing automations IPC surface (find how `cancelRun` is exposed and mirror it).

**Step 3: Tests.** A paused run is skipped by a `tickRunningChains` pass (its step state doesn't advance); `resumeRun` clears the flag and the run ticks again. Pause preserves state (the watch tracker / step output is untouched).

**Step 4:** `pnpm tc:node` + service suite → green. **Commit:** `feat(automations): pause/resume runs (detached watcher control)`.

---

## Task 6: Editor — detached checkbox + run controls

**Files:** Modify `WatchPrStepCard.tsx`, `chain-editor-modal-state.ts` (default), the run-row UI that renders Stop. Tests: editor suites.

**Step 1:** `WatchPrStepCard.tsx` — add a checkbox mirroring the others:
```tsx
<label className="flex items-center gap-2 text-xs text-muted-foreground">
  <input
    type="checkbox"
    aria-label="Run in the background (don't block the chain)"
    checked={config.detached ?? false}
    onChange={(e) => update({ detached: e.target.checked })}
  />
  Run in the background (don't block the chain)
</label>
```
Add `detached: false` to `defaultConfigForKind('watch-pr')` and to the `seeds the watch-pr default config` test's `toEqual`.

**Step 2:** Run-row controls — find the component that renders the run Stop/cancel button (grep for `cancelRun` / `retryRunFromStep` IPC calls in the renderer). For a run with `paused` togglable (active, long-lived watcher — `detachedFromRunId` set OR a watch-pr run), render **Pause** (calls `pauseRun`) / **Resume** (calls `resumeRun`) next to Stop. Use STYLEGUIDE tokens + shadcn primitives; reuse the existing button styling. Wire the new IPC calls (mirror the cancel/retry wiring in the preload + renderer store).

**Step 3:** `pnpm tc:web` → 0 errors. Editor suites (`chain-editor-modal-state.test.ts`, `WatchPrStepCard.test.tsx`) → pass. If the run-row UI is large, keep the node-side Pause/Resume controls minimal and clearly report what's wired vs deferred.

**Step 4:** **Commit:** `feat(automations): watch-pr detached toggle + pause/resume run controls`.

---

## Task 7: Full verification + PR update

**Step 1:** `pnpm tc:node && pnpm tc:web` → 0 errors.
**Step 2:** Targeted suites:
```bash
pnpm vitest run src/main/automations/service.test.ts src/main/automations/runners/run-prompt-runner.test.ts src/main/automations/runners/watch-pr-runner.test.ts src/main/automations/chain-executor.test.ts
pnpm vitest run --config config/vitest.config.ts src/renderer/src/components/automations/editor/
```
All pass.
**Step 3:** REQUIRED SUB-SKILL: `superpowers:requesting-code-review` against this design doc. Confirm: the pane queue frees on every terminal/drop path (no leak/deadlock), detached run is independent + automation-owned, pause skips ticks without losing state, and run-prompt's existing reuse/agent-status behavior is unchanged when there's no contention.
**Step 4:** Fix findings, push to the existing branch so the PR updates.

---

## Notes / risk register

- **Pane release coverage is the #1 risk.** Every `outcome: 'done' | 'failed'` return in run-prompt's drive+poll paths must release; `releasePane` idempotency + `releasePanesForRun` (cancel) + `dropStep`/`dropRun` are the backstops. The "holder fails → next waiter proceeds" and "holder dropped → next proceeds" tests are the guard.
- **Acquire before any `await`** so interleaved async ticks can't double-drive (only the head sends).
- **Detached + group/endOnApprove compose for free** — the detached run is just a normal watcher; all its existing logic (members, batching, approve-exit) applies.
- **`parentStepId` reuse** on the detached run (to resolve the watch step) is deliberate; if it collides confusingly with child-run semantics, add a dedicated `detachedStepId` field instead.
- **No new run-status** for pause — a `paused` boolean the tick loop honors keeps the blast radius small.
