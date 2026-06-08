# Watch PR — Detached Mode + General Pane Queue Design

> Builds on the `watch-pr` node (`docs/plans/2026-06-08-watch-pr-review-loop-design.md`, `...-group-design.md`). Adds (1) a **detached** mode so the watcher runs in the background while the chain continues, and (2) a **general FIFO pane queue** so concurrent run-prompts can't drive the same agent pane at once.

## Goal

Let a `watch-pr` node run **detached** — fire the loop as a background run and let the rest of the chain keep going — and ensure that the detached watcher, the now-continuing main chain, and any other run-prompt **never drive the same agent pane concurrently**: they queue, in order, per pane.

## Why

Today a `watch-pr` node is a barrier: a parallel group won't advance until every sibling is terminal (`chain-executor.ts` — *"if any sibling is still running, wait"*), and group siblings are single steps (`StepOrGroup = Step | Step[]`). So a long-lived watcher in a chain blocks everything after it. Detached mode removes that barrier. But once the watcher runs alongside a continuing chain, both can issue run-prompts — and an agent pane can only do one turn at a time — so we need cross-run serialization on the pane.

## Decisions (from brainstorming)

1. **Conflict unit = the pane (`paneKey`).** Serialize run-prompts that target the same agent session. Two agents in different panes (even same worktree) may run concurrently.
2. **The queue is general, not watcher-specific.** The original chain, the detached watcher's branch cycles, and any other run-prompt all contend through the same per-`paneKey` FIFO queue. Nobody is privileged.
3. **Detached watcher = independent run** with its own ending criteria (merged/closed/archived); it outlives the spawning chain. Owned by the **automation** (deleting the automation / archiving the workspace cleans it up). **Pausable + stoppable** from the automation's run UI.

---

## Part 1 — Detached mode

**Config:** add `detached?: boolean` to `WatchPrConfig` (default false → today's inline/blocking behavior). Editor: a checkbox — *"Run in the background (don't block the chain)."*

**Spawn-and-continue.** When `detached` is true and the runner is **not** already inside the detached run, the watch step's tick:
1. resolves the refs (worktree/group → members, paneRef),
2. calls a new service dep `spawnDetachedWatcher({ fromRunId, stepId, context })`,
3. returns `{ outcome: 'done', status: 'succeeded', statusMessage: 'Watching #<n> in background', output: { detachedRunId, … } }` — so the parent chain advances.

`spawnDetachedWatcher` creates a background `AutomationRun`:
- `automationId` = the spawner's automation (so automation-delete cleans it up),
- `detachedFromRunId` = the spawner run id (provenance / UI grouping; **no teardown coupling**),
- `context` = clone of the parent context + `__watchDetached: true`,
- step source = the single watch step (resolved via the existing child-run tick-interception path — the run ticks against `[watchStep]`, not the whole chain).

**No infinite spawn.** The runner checks `ctx.context.__watchDetached`: set → run the normal `resolving → watching → responding` loop (single- or group-PR); unset + `detached` → spawn + return done. The detached run carries the flag, so it runs the loop and never re-spawns.

**Bounded nesting:** original chain → detached watcher run → per-cycle branch runs. `branchSteps` still cannot contain a `watch-pr` (existing palette/paste/validation guard), so depth is fixed.

**Lifecycle:**
| Event | Effect on the detached watcher |
|---|---|
| Original chain finishes / is Stopped | **Unaffected** — it lives on (the point of detach). |
| Detached watcher's own terminal (merged/closed/archived) | Finalizes itself (existing watch terminal logic). |
| **Stop** on the detached run | `cancelRun(detachedRunId)` — cancels it + its in-flight branch cycle + releases its pane claims. |
| **Delete automation** | Hard-deletes all its runs incl. detached watchers (existing cascade). |
| Workspace archived | The watcher's own `isWorktreeArchived` teardown fires. |

---

## Part 2 — General pane queue

A **service-wide FIFO queue keyed by `paneKey`**. Every run-prompt that drives a pane goes through it.

**State:** `paneQueue: Map<paneKey, string[]>` — each entry an ordered list of tokens `${runId}:${stepId}`. **The head holds the pane.**

**Service deps for the run-prompt runner:**
```ts
acquirePane(paneKey: string, token: string): boolean  // push token at tail if new; true iff token is head
releasePane(paneKey: string, token: string): void     // remove token (the head); next waiter becomes holder next tick
```

**Integration in `run-prompt-runner` (uniform across the open-new and reuse-by-paneRef paths):** each tick, before driving the agent:
1. `acquirePane(paneKey, token)`. Not head → return `{ outcome: 'needs-more-time', status: 'waiting', statusMessage: 'Waiting for pane — N ahead' }`; park, retry next tick.
2. Head → proceed: send the prompt (or, on the open path, after `openPromptPane` returns the key, claim it), then poll the agent to `done` **while holding the lock across ticks**.
3. On `done` → `releasePane`, return `done`. On drop/cancel/retry → `releasePane`.

So one run-prompt owns an agent from prompt to turn-completion; everyone else queues in arrival order.

**Why FIFO, not a bare lock:** a lock grants to whoever ticks first when it frees — non-deterministic, starvation-prone. The ordered queue is the "appropriate queuing": the detached watcher's response and a main-chain prompt to the same pane run in the order they asked.

**Deadlock / restart safety:**
- The queue is **in-memory and ephemeral** — a crash/restart empties it; steps re-register on their next tick; it can never deadlock.
- Claims are set **synchronously before any `await`**, so even with interleaved async ticks, only the head ever sends.
- A holder cancelled/dropped releases via the existing `dropRun`/`dropStep`/`cancelRun` paths, which now also call `releasePane` for that run's claims.
- The service's tick loop runs runs in series; combined with synchronous queue ops, there's no double-holder.

**Relationship to the idle gate:** the watcher's "agent idle" gate still decides *whether* to respond; the pane queue is the authoritative serializer for *driving*. A watcher cycle that looks ready still waits if the main chain holds the pane.

---

## Part 3 — Pause / stop

The detached watcher is a normal run, so its run UI gets:

- **Stop** — `cancelRun` (already wired) + releases pane claims (Part 2). Terminal.
- **Pause / Resume** — a `paused?: boolean` on `AutomationRun`. `tickRunningChains` skips a paused run (`if (run.paused) continue`); the watcher stops polling/arming/firing but keeps all durable state (members, `handledCursor`, `cycleIndex`). Resume clears the flag and it continues exactly where it left off. No new run-status enum. `scheduleFastTickIfRunsActive` ignores paused runs so the fast timer doesn't spin for them.

**In-flight cycle when paused:** an active branch cycle (agent mid-turn) is its own child run and is **not** interrupted — it finishes and releases the pane; the paused watcher just won't start another until resumed. Pause never cuts an agent off mid-thought.

**UI:** the detached watcher renders with its live status (*"Watching #123 (background) · 2 cycles"*), Pause/Resume + Stop, and is distinguishable via `detachedFromRunId`. `run.paused` is a general flag, but the only UI surface here is the detached watcher's controls (YAGNI — no pausing arbitrary mid-chain runs).

---

## Testing

**Pane queue (service unit tests):** FIFO (A head, B waits, A releases → B head); idempotent re-acquire; independent panes; holder dropped/cancelled → freed, next proceeds; restart (empty) → re-registers.

**run-prompt-runner:** reuse step returns `waiting` when not head; sends when head; `releasePane` on done and on drop/cancel.

**Detached (runner):** `detached` + no `__watchDetached` → `spawnDetachedWatcher` called, returns `done`; `__watchDetached` set → runs the loop, never re-spawns.

**Detached (service/lifecycle):** `spawnDetachedWatcher` builds an independent run (automationId = spawner, `detachedFromRunId`, `__watchDetached` context, single-watch-step source) ticked via interception; `cancelRun(original)` does NOT cancel it; `cancelRun(detached)` cancels it + branch + releases panes; `deleteAutomation` removes it; `paused` run skipped by the tick loop and resumes.

**End-to-end:** a detached watcher's branch run-prompt and a main-chain run-prompt on the **same** `paneKey` → exactly one drives at a time, in FIFO order (the headline guarantee).

**Verification:** `pnpm tc:node` + `pnpm tc:web` + targeted vitest.

## Files touched (summary)

| Area | File | Change |
|---|---|---|
| Types | `src/shared/automations-types.ts` | `WatchPrConfig.detached?`; `AutomationRun.detachedFromRunId?` + `paused?` |
| Runner | `src/main/automations/runners/watch-pr-runner.ts` | detached spawn-and-done branch (guarded by `__watchDetached`) |
| run-prompt | `src/main/automations/runners/run-prompt-runner.ts` | acquire/hold/release the pane around driving |
| Service | `src/main/automations/service.ts` | `paneQueue` + `acquirePane`/`releasePane`; `spawnDetachedWatcher`; detached-run tick interception; `tickRunningChains` paused-skip; release panes in cancel/retry/drop |
| Editor | `src/renderer/.../WatchPrStepCard.tsx`, run UI | `detached` checkbox; Pause/Resume on the detached watcher run |
| Tests | per the strategy above | — |
