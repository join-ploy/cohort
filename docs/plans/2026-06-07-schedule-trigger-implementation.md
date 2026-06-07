# Schedule Trigger Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `schedule` auto-trigger that fires automation runs on a cron-like recurrence, with a visual builder + raw-cron escape hatch + live "next runs" preview, using skip-missed semantics.

**Architecture:** A schedule trigger is an `AutoTrigger` whose only config is `{ cron, timezone }`. It has no external entity — time is the trigger — so it runs on a per-trigger, time-driven path in `AutoTriggerEngine`, mirroring the existing `http-endpoint` per-trigger path. All cron/timezone math lives in one isomorphic module (`src/shared/schedule-cron.ts`, wrapping `croner`) used by *both* the engine (firing) and the renderer (preview), so preview == reality including DST. Skip-missed: in-memory next-run state re-anchors to the next future occurrence on every (re)start, and a max-lateness guard drops instants missed due to sleep/disable.

**Tech Stack:** TypeScript, Electron (main + renderer), React + shadcn primitives, `croner@10.0.1` (pinned, zero deps), Vitest, Playwright (e2e).

**Design doc:** `docs/plans/2026-06-07-schedule-trigger-design.md`

**Conventions for every task:**
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass.
- Verify per repo norms (see `memory/verification-commands`): targeted `pnpm test <path>`, plus `pnpm tc:node` / `pnpm tc:web`. Do NOT run the full suite or `tc:cli` for green/red signal — both have known-unrelated failures.
- Follow `AGENTS.md`: comment the *why* briefly; no `helpers`/`utils` file names; STYLEGUIDE + shadcn for UI; cross-platform.
- Commit after each task.

---

## Task 1: Add the `croner` dependency (pinned exact)

**Files:**
- Modify: `package.json` (dependencies)

**Step 1: Add the dependency, pinned exact**

In `package.json` `dependencies`, add (alphabetical position, no `^`/`~` — the repo pins all deps exactly):

```json
"croner": "10.0.1",
```

**Step 2: Install**

Run: `pnpm install`
Expected: lockfile updates, `croner@10.0.1` resolved, zero transitive deps added.

**Step 3: Sanity-check the import resolves**

Run: `node -e "const {Cron}=require('croner'); console.log(new Cron('0 9 * * *',{timezone:'Europe/London'}).nextRun() instanceof Date)"`
Expected: prints `true`.

**Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): add croner@10.0.1 (pinned) for schedule trigger"
```

---

## Task 2: `schedule-cron` shared module (the pure core)

The standalone cron/timezone math + builder⇄cron bridge. No dependency on the trigger union, so it's fully testable in isolation.

**Files:**
- Create: `src/shared/schedule-cron.ts`
- Test: `src/shared/schedule-cron.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import {
  nextOccurrenceAfter,
  nextOccurrences,
  isValidCron,
  cronFromRecurrence,
  recurrenceFromCron
} from './schedule-cron'

const LONDON = 'Europe/London'

describe('schedule-cron', () => {
  it('computes the next daily occurrence in the given timezone', () => {
    // 2026-06-07T00:00:00Z is 01:00 London (BST). Next "0 9 * * *" is 09:00 London = 08:00Z.
    const from = Date.UTC(2026, 5, 7, 0, 0, 0)
    const next = nextOccurrenceAfter('0 9 * * *', LONDON, from)
    expect(next).toBe(Date.UTC(2026, 5, 7, 8, 0, 0))
  })

  it('returns occurrences strictly after `from`, in ascending order', () => {
    const from = Date.UTC(2026, 5, 7, 8, 0, 0) // exactly 09:00 London
    const runs = nextOccurrences('0 9 * * *', LONDON, from, 3)
    expect(runs).toHaveLength(3)
    expect(runs[0]).toBe(Date.UTC(2026, 5, 8, 8, 0, 0)) // next day, not `from` itself
    expect(runs[0]).toBeLessThan(runs[1])
    expect(runs[1]).toBeLessThan(runs[2])
  })

  it('holds 09:00 wall-clock across the autumn DST change', () => {
    // London clocks go back on 2026-10-25. 09:00 local is 08:00Z before, 09:00Z after.
    const beforeDst = Date.UTC(2026, 9, 24, 12, 0, 0)
    expect(nextOccurrenceAfter('0 9 * * *', LONDON, beforeDst)).toBe(Date.UTC(2026, 9, 25, 9, 0, 0))
  })

  it('validates cron expressions', () => {
    expect(isValidCron('0 9 * * 1-5')).toBe(true)
    expect(isValidCron('not a cron')).toBe(false)
    expect(isValidCron('')).toBe(false)
  })

  it('round-trips builder recurrences through cron', () => {
    expect(cronFromRecurrence({ freq: 'daily', hour: 9, minute: 0 })).toBe('0 9 * * *')
    expect(cronFromRecurrence({ freq: 'hourly', minute: 30 })).toBe('30 * * * *')
    expect(cronFromRecurrence({ freq: 'weekly', days: [1, 3, 5], hour: 9, minute: 0 })).toBe('0 9 * * 1,3,5')
    expect(cronFromRecurrence({ freq: 'monthly', dayOfMonth: 1, hour: 9, minute: 0 })).toBe('0 9 1 * *')

    expect(recurrenceFromCron('0 9 * * *')).toEqual({ freq: 'daily', hour: 9, minute: 0 })
    expect(recurrenceFromCron('30 * * * *')).toEqual({ freq: 'hourly', minute: 30 })
    expect(recurrenceFromCron('0 9 * * 1,3,5')).toEqual({ freq: 'weekly', days: [1, 3, 5], hour: 9, minute: 0 })
    expect(recurrenceFromCron('0 9 1 * *')).toEqual({ freq: 'monthly', dayOfMonth: 1, hour: 9, minute: 0 })
  })

  it('returns null for cron shapes the builder cannot represent', () => {
    expect(recurrenceFromCron('*/15 9-17 * * *')).toBeNull()
    expect(recurrenceFromCron('garbage')).toBeNull()
  })
})
```

**Step 2: Run to verify it fails**

Run: `pnpm test src/shared/schedule-cron.test.ts`
Expected: FAIL — module not found / exports undefined.

**Step 3: Implement `schedule-cron.ts`**

```ts
import { Cron } from 'croner'

// Single source of truth for schedule semantics: both the auto-trigger engine
// (firing) and the renderer (preview) call these, so what's previewed is exactly
// what fires — including DST — because croner owns the timezone math.

export type Recurrence =
  | { freq: 'hourly'; minute: number }
  | { freq: 'daily'; hour: number; minute: number }
  | { freq: 'weekly'; days: number[]; hour: number; minute: number } // 0=Sun…6=Sat
  | { freq: 'monthly'; dayOfMonth: number; hour: number; minute: number }

function makeCron(cron: string, timezone: string): Cron | null {
  try {
    // croner throws on malformed expressions; treat any throw as invalid.
    return new Cron(cron, { timezone })
  } catch {
    return null
  }
}

export function isValidCron(cron: string): boolean {
  if (!cron.trim()) return false
  // Validate against a fixed valid zone so a bad tz can't mask a bad expression.
  return makeCron(cron, 'UTC') !== null
}

export function nextOccurrenceAfter(cron: string, timezone: string, fromMs: number): number | null {
  const c = makeCron(cron, timezone)
  const next = c?.nextRun(new Date(fromMs))
  return next ? next.getTime() : null
}

export function nextOccurrences(cron: string, timezone: string, fromMs: number, n: number): number[] {
  const c = makeCron(cron, timezone)
  if (!c) return []
  return c.nextRuns(n, new Date(fromMs)).map((d) => d.getTime())
}

// ---- builder <-> cron bridge -------------------------------------------------

export function cronFromRecurrence(r: Recurrence): string {
  switch (r.freq) {
    case 'hourly':
      return `${r.minute} * * * *`
    case 'daily':
      return `${r.minute} ${r.hour} * * *`
    case 'weekly':
      return `${r.minute} ${r.hour} * * ${[...r.days].sort((a, b) => a - b).join(',')}`
    case 'monthly':
      return `${r.minute} ${r.hour} ${r.dayOfMonth} * *`
  }
}

const INT = /^\d+$/

// Reverse only the constrained shapes the visual builder emits; anything else
// returns null, which the UI reads as "Custom" (raw-cron) mode.
export function recurrenceFromCron(cron: string): Recurrence | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [min, hr, dom, mon, dow] = parts
  if (mon !== '*') return null
  if (!INT.test(min)) return null
  const minute = Number(min)

  // hourly: "<min> * * * *"
  if (hr === '*' && dom === '*' && dow === '*') return { freq: 'hourly', minute }
  if (!INT.test(hr)) return null
  const hour = Number(hr)

  // daily: "<min> <hr> * * *"
  if (dom === '*' && dow === '*') return { freq: 'daily', hour, minute }

  // weekly: "<min> <hr> * * <d,d,...>"
  if (dom === '*' && dow !== '*') {
    const days = dow.split(',')
    if (!days.every((d) => INT.test(d) && Number(d) >= 0 && Number(d) <= 6)) return null
    return { freq: 'weekly', days: days.map(Number), hour, minute }
  }

  // monthly: "<min> <hr> <dom> * *"
  if (dow === '*' && INT.test(dom)) return { freq: 'monthly', dayOfMonth: Number(dom), hour, minute }

  return null
}
```

**Step 4: Run to verify it passes**

Run: `pnpm test src/shared/schedule-cron.test.ts`
Expected: PASS (all cases). If a DST assertion is off by an hour, re-derive the expected UTC instant — do not weaken the assertion.

**Step 5: Typecheck**

Run: `pnpm tc:node && pnpm tc:web`
Expected: no new errors.

**Step 6: Commit**

```bash
git add src/shared/schedule-cron.ts src/shared/schedule-cron.test.ts
git commit -m "feat(automations): cron+timezone core for schedule trigger"
```

---

## Task 3: Widen the type model (and keep the compiler green)

Add the union member + config types. Widening `TriggerSourceId` breaks any exhaustive `Record<TriggerSourceId, …>` — at minimum `SOURCE_META` — so this task fixes those in the same commit to keep `tc` green.

**Files:**
- Modify: `src/shared/automations-types.ts`
- Modify: `src/renderer/src/components/automations/editor/AutoTriggerCard.tsx` (`SOURCE_META`)
- Test: `src/shared/automations-types.test.ts`

**Step 1: Add a type-level test asserting the new shape**

Append to `src/shared/automations-types.test.ts` (mirror the existing style there):

```ts
import { expectTypeOf } from 'vitest'
import type { TriggerSourceId, ScheduleConfig, AutoTrigger } from './automations-types'

it('schedule is a trigger source with a cron+timezone config', () => {
  expectTypeOf<'schedule'>().toMatchTypeOf<TriggerSourceId>()
  expectTypeOf<ScheduleConfig>().toEqualTypeOf<{ cron: string; timezone: string }>()
  const t: Pick<AutoTrigger, 'schedule'> = { schedule: { cron: '0 9 * * *', timezone: 'UTC' } }
  expect(t.schedule?.cron).toBe('0 9 * * *')
})
```

**Step 2: Run to verify it fails**

Run: `pnpm test src/shared/automations-types.test.ts`
Expected: FAIL — `'schedule'` not assignable / `ScheduleConfig` missing.

**Step 3: Widen the types**

In `src/shared/automations-types.ts`:

```ts
export type TriggerSourceId = 'linear-issue' | 'github-pr' | 'http-endpoint' | 'schedule'

// Schedule trigger config — a standard 5-field cron plus an IANA timezone.
// The visual builder edits this; the raw-cron field exposes `cron` directly.
export type ScheduleConfig = {
  cron: string
  timezone: string
}
```

Add `schedule?` to `AutoTrigger` (next to the `http?` field):

```ts
  // schedule source only: the cron recurrence + timezone this trigger fires on.
  schedule?: ScheduleConfig
```

Add `schedule?` to `RunNowPayload`:

```ts
  schedule?: { firedAt: number; scheduledFor: number; cron: string; timezone: string }
```

**Step 4: Fix `SOURCE_META` (the broken Record)**

In `AutoTriggerCard.tsx`, add a schedule entry (import `CalendarClock` from `lucide-react`):

```ts
const SOURCE_META: Record<TriggerSourceId, { label: string; icon: LucideIcon }> = {
  'linear-issue': { label: 'Linear issue', icon: Zap },
  'github-pr': { label: 'GitHub PR', icon: GitPullRequest },
  'http-endpoint': { label: 'HTTP endpoint', icon: Globe },
  schedule: { label: 'Schedule', icon: CalendarClock }
}
```

**Step 5: Run tests + typecheck — fix every remaining compiler-flagged site**

Run: `pnpm test src/shared/automations-types.test.ts && pnpm tc:node && pnpm tc:web`
Expected: PASS. If `tc` flags any other exhaustive `Record<TriggerSourceId,…>` or `switch` with a `never` default, that's an intended discovery — add the missing `schedule` arm. (The if/else chains in `service.ts`, `chain-editor-modal-state.ts`, etc. are non-exhaustive and won't error yet; they're handled in later tasks.)

**Step 6: Commit**

```bash
git add src/shared/automations-types.ts src/shared/automations-types.test.ts src/renderer/src/components/automations/editor/AutoTriggerCard.tsx
git commit -m "feat(automations): add 'schedule' to trigger source union + config types"
```

---

## Task 4: The schedule trigger source + register it

A thin `TriggerSource` for the catalog/UI, whose `poll()` formats one CandidateEvent for a given fire instant. The engine (Task 5) owns the timing; the source owns the event shape — symmetric with `http-endpoint`.

**Files:**
- Modify: `src/main/automations/trigger-sources/types.ts` (extend `PollCtx`)
- Create: `src/main/automations/trigger-sources/schedule.ts`
- Test: `src/main/automations/trigger-sources/schedule.test.ts`
- Modify: `src/main/index.ts` (register the source)

**Step 1: Extend `PollCtx`**

In `types.ts`, add two optional fields (per-source ctx fields are an established pattern — see `http?`):

```ts
  // Set by the engine for the per-trigger schedule source; ignored by others.
  schedule?: ScheduleConfig
  // The fire instant ("now"), injected by the engine so the schedule source's
  // event payload is deterministic in tests; ignored by other sources.
  now?: number
```

Add `ScheduleConfig` to the import from `automations-types`.

**Step 2: Write the failing source test**

```ts
import { describe, it, expect } from 'vitest'
import { makeScheduleSource } from './schedule'

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

describe('schedule trigger source', () => {
  it('formats one event for the scheduled instant', async () => {
    const source = makeScheduleSource()
    const scheduledFor = Date.UTC(2026, 5, 8, 8, 0, 0)
    const events = await collect(
      source.poll({
        since: scheduledFor,
        now: scheduledFor + 1234,
        hostId: 'h1',
        schedule: { cron: '0 9 * * *', timezone: 'Europe/London' }
      })
    )
    expect(events).toHaveLength(1)
    expect(events[0].entityId).toBe(new Date(scheduledFor).toISOString())
    expect(events[0].updatedAt).toBe(scheduledFor)
    expect(events[0].payload).toEqual({
      schedule: {
        firedAt: scheduledFor + 1234,
        scheduledFor,
        cron: '0 9 * * *',
        timezone: 'Europe/London'
      }
    })
  })

  it('yields nothing when no schedule config is present', async () => {
    const source = makeScheduleSource()
    const events = await collect(source.poll({ since: 0, hostId: 'h1' }))
    expect(events).toHaveLength(0)
  })
})
```

**Step 3: Run to verify it fails**

Run: `pnpm test src/main/automations/trigger-sources/schedule.test.ts`
Expected: FAIL — module not found.

**Step 4: Implement `schedule.ts`**

```ts
import type { CandidateEvent, PollCtx, TriggerSource } from './types'

// Time-driven source: it has no external entity, so the engine decides WHEN to
// poll (the fire instant arrives as ctx.since) and this just shapes the event.
// entityId is the occurrence's ISO instant so dedup makes each instant idempotent.
export function makeScheduleSource(): TriggerSource {
  async function* poll(ctx: PollCtx): AsyncIterable<CandidateEvent> {
    if (!ctx.schedule) return
    const scheduledFor = ctx.since
    const firedAt = ctx.now ?? scheduledFor
    yield {
      entityId: new Date(scheduledFor).toISOString(),
      updatedAt: scheduledFor,
      payload: {
        schedule: {
          firedAt,
          scheduledFor,
          cron: ctx.schedule.cron,
          timezone: ctx.schedule.timezone
        }
      },
      fields: {}
    }
  }
  return { id: 'schedule', displayName: 'Schedule', fieldCatalog: [], poll }
}
```

**Step 5: Run to verify it passes**

Run: `pnpm test src/main/automations/trigger-sources/schedule.test.ts`
Expected: PASS.

**Step 6: Register the source in `src/main/index.ts`**

Next to the other `triggerSourceRegistry.register(...)` calls (~line 685):

```ts
triggerSourceRegistry.register(makeScheduleSource())
```

Add the import alongside the other source factories.

**Step 7: Typecheck**

Run: `pnpm tc:node`
Expected: no new errors.

**Step 8: Commit**

```bash
git add src/main/automations/trigger-sources/types.ts src/main/automations/trigger-sources/schedule.ts src/main/automations/trigger-sources/schedule.test.ts src/main/index.ts
git commit -m "feat(automations): schedule trigger source + PollCtx schedule/now"
```

---

## Task 5: Engine firing path (skip-missed + idempotent)

Add the per-trigger schedule path to `AutoTriggerEngine`, mirroring `pollHttpTrigger`. In-memory `scheduleNextRun` state + a max-lateness guard implement skip-missed.

**Files:**
- Modify: `src/main/automations/auto-trigger-engine.ts`
- Test: `src/main/automations/auto-trigger-engine.test.ts` (read this first for the existing mock-deps harness)

**Step 1: Write the failing engine tests**

Read `auto-trigger-engine.test.ts` to reuse its harness (how it builds `AutoTriggerEngineDeps` with a fake registry, `dispatchAutoRun` spy, in-memory dedup, and injectable `now`). Add a `describe('schedule trigger', …)` with these cases, using a `scheduleNextRun` Map-backed dep and the real `makeScheduleSource()` in the fake registry:

```ts
// Pseudocode of the assertions — adapt to the file's existing helpers.
it('anchors to the next future occurrence on first tick without firing', async () => {
  // now = 2026-06-07T08:30Z; cron "0 9 * * *" UTC → next is 09:00Z.
  // First tick: scheduleNextRun is 0 → engine sets it to 09:00Z and does NOT dispatch.
  expect(dispatch).not.toHaveBeenCalled()
  expect(scheduleNextRun.get(triggerId)).toBe(Date.UTC(2026, 5, 7, 9, 0, 0))
})

it('fires exactly once when the instant elapses while ticking', async () => {
  // Pre-seed scheduleNextRun = 09:00Z. now = 09:00:10Z (within grace).
  // Tick → one dispatch; scheduleNextRun advanced to next day 09:00Z.
  expect(dispatch).toHaveBeenCalledTimes(1)
  const { event, rule } = dispatch.mock.calls[0][0]
  expect(event.entityId).toBe(new Date(Date.UTC(2026, 5, 7, 9, 0, 0)).toISOString())
  expect(rule.projectId).toBe(automation.projectId) // implicit rule
  expect(scheduleNextRun.get(triggerId)).toBe(Date.UTC(2026, 5, 8, 9, 0, 0))
})

it('does not re-fire the same instant on a second tick (dedup idempotency)', async () => {
  // Two ticks at the same now; dedupHas returns true the second time.
  expect(dispatch).toHaveBeenCalledTimes(1)
})

it('skips an instant missed by more than the grace window (sleep/disable)', async () => {
  // Pre-seed scheduleNextRun = 09:00Z. now = 12:00Z (> grace past due).
  // Tick → NO dispatch; scheduleNextRun re-anchored to next future 09:00Z.
  expect(dispatch).not.toHaveBeenCalled()
  expect(scheduleNextRun.get(triggerId)).toBe(Date.UTC(2026, 5, 8, 9, 0, 0))
})

it('does not fire for a paused automation', async () => {
  // automation.enabled = false → not in `active` → no dispatch, no state change.
  expect(dispatch).not.toHaveBeenCalled()
})
```

**Step 2: Run to verify they fail**

Run: `pnpm test src/main/automations/auto-trigger-engine.test.ts`
Expected: FAIL — `scheduleNextRun` dep / schedule path absent.

**Step 3: Implement the engine path**

In `AutoTriggerEngineDeps` add (next to `httpLastPoll`):

```ts
  // Per-schedule-trigger next-fire instant (in-memory; re-anchored each process
  // start, which is how skip-missed drops instants from while the app was closed).
  scheduleNextRun: (triggerId: string) => number
  scheduleNextRunSet: (triggerId: string, value: number) => void
```

Add the import:

```ts
import { nextOccurrenceAfter } from '../../shared/schedule-cron'
```

Add a module constant:

```ts
// Fire an instant only if it came due within this window — longer than a tick so
// jitter still fires, short enough that a closed/asleep/disabled gap is skipped.
const SCHEDULE_MAX_LATENESS_MS = 5 * 60_000
```

In `tick()`, exclude schedule from the shared group and route it separately. Change the `sharedEntries` filter and add a schedule list + loop:

```ts
const httpEntries = active.filter(
  (e) => e.trigger.source === 'http-endpoint' && (e.trigger.pollingEnabled ?? true)
)
const scheduleEntries = active.filter((e) => e.trigger.source === 'schedule')
const sharedEntries = active.filter(
  (e) => e.trigger.source !== 'http-endpoint' && e.trigger.source !== 'schedule'
)
// …existing bySource grouping over sharedEntries…

for (const entry of httpEntries) {
  try { await this.pollHttpTrigger(entry) }
  catch (err) { this.reportError(`tick:http(${entry.trigger.id})`, err) }
}
for (const entry of scheduleEntries) {
  try { await this.pollScheduleTrigger(entry) }
  catch (err) { this.reportError(`tick:schedule(${entry.trigger.id})`, err) }
}
```

Add the method (mirror `pollHttpTrigger`):

```ts
// Fire a single schedule trigger when its next instant elapses live. State is
// in-memory: a fresh process re-anchors to the next FUTURE occurrence, and the
// lateness guard drops instants missed while asleep/disabled — both "skip-missed".
private async pollScheduleTrigger(entry: ActiveEntry): Promise<void> {
  const { automation, trigger } = entry
  if (!trigger.schedule) return
  const { cron, timezone } = trigger.schedule
  const nowMs = this.deps.now()
  const nextRunAt = this.deps.scheduleNextRun(trigger.id)

  if (nextRunAt === 0) {
    // First observation this process: anchor strictly in the future.
    const anchor = nextOccurrenceAfter(cron, timezone, Math.max(nowMs, trigger.enabledAt))
    if (anchor !== null) this.deps.scheduleNextRunSet(trigger.id, anchor)
    return
  }
  if (nowMs < nextRunAt) return

  if (nowMs - nextRunAt > SCHEDULE_MAX_LATENESS_MS) {
    // Missed (sleep/disable/long tick gap): re-anchor without firing.
    const next = nextOccurrenceAfter(cron, timezone, nowMs)
    if (next !== null) this.deps.scheduleNextRunSet(trigger.id, next)
    return
  }

  // Due and fresh: advance the clock BEFORE dispatch so a slow/failed dispatch
  // can't re-fire this instant.
  const next = nextOccurrenceAfter(cron, timezone, nowMs)
  if (next !== null) this.deps.scheduleNextRunSet(trigger.id, next)

  const source = this.deps.registry.get('schedule')
  if (!source) return
  for await (const event of source.poll({
    since: nextRunAt,
    now: nowMs,
    hostId: this.deps.hostId,
    schedule: trigger.schedule
  })) {
    try {
      if (this.deps.dedupHas(automation.id, trigger.id, event.entityId)) continue
      // No conditions: one implicit match targeting the automation's project.
      const rule = { id: 'implicit', conditions: [], projectId: automation.projectId }
      // Insert dedup BEFORE dispatch so a crash mid-dispatch can't re-fire.
      this.deps.dedupInsert(
        automation.id, trigger.id, trigger.source,
        event.entityId, event.entityIdentifier, this.deps.now()
      )
      await this.deps.dispatchAutoRun({ automation, trigger, rule, event })
    } catch (err) {
      this.reportError(`tick:schedule-event(${trigger.id}:${event.entityId})`, err)
    }
  }
}
```

**Step 4: Run to verify the tests pass**

Run: `pnpm test src/main/automations/auto-trigger-engine.test.ts`
Expected: PASS.

**Step 5: Typecheck**

Run: `pnpm tc:node`
Expected: FAIL where the engine is constructed without the new `scheduleNextRun*` deps (i.e. `src/main/index.ts`). That's wired in Task 6 — proceed.

**Step 6: Commit**

```bash
git add src/main/automations/auto-trigger-engine.ts src/main/automations/auto-trigger-engine.test.ts
git commit -m "feat(automations): engine fires schedule triggers with skip-missed"
```

---

## Task 6: Wire engine state in the composition root

Back the new engine deps with an in-memory map in `index.ts` (mirror the `httpTriggerLastPoll` map).

**Files:**
- Modify: `src/main/index.ts`

**Step 1: Add the state map + deps**

Near `httpTriggerLastPoll` (~line 695), add:

```ts
// Per-schedule-trigger next-fire instant; in-memory so it re-anchors each start.
const scheduleNextRun = new Map<string, number>()
```

In the `new AutoTriggerEngine({ … })` deps object, add:

```ts
scheduleNextRun: (id) => scheduleNextRun.get(id) ?? 0,
scheduleNextRunSet: (id, value) => { scheduleNextRun.set(id, value) },
```

**Step 2: Typecheck**

Run: `pnpm tc:node`
Expected: PASS (the Task 5 construction error is now resolved).

**Step 3: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(automations): back schedule next-run state in main process"
```

---

## Task 7: Dispatch payload + run context

Map a schedule event into the run payload and surface it in the trigger context.

**Files:**
- Modify: `src/main/automations/service.ts` (`dispatchAutoRun` ~line 657, `buildTriggerContext` ~line 685)
- Test: `src/main/automations/service.test.ts` (read first for the existing `dispatchAutoRun` test pattern)

**Step 1: Write the failing test**

Mirror the existing http `dispatchAutoRun` test in `service.test.ts`. Build an automation with a schedule auto-trigger and dispatch a schedule CandidateEvent (entityId = an ISO instant, `payload.schedule = { firedAt, scheduledFor, cron, timezone }`). Assert the resulting run:
- targets `automation.projectId`,
- has `triggerSource === 'schedule'` and `triggerEntityId === event.entityId`,
- exposes `run.context.trigger.schedule` equal to the event's `payload.schedule`.

**Step 2: Run to verify it fails**

Run: `pnpm test src/main/automations/service.test.ts`
Expected: FAIL — `run.context.trigger.schedule` undefined (falls through `else` today).

**Step 3: Implement the dispatch arm**

In `dispatchAutoRun`, add before the final `else`:

```ts
} else if (trigger.source === 'schedule') {
  // Why: schedule has no external entity — the run targets the automation's
  // project (carried by the implicit rule) and payload.schedule is the
  // fire-time context surfaced to chain steps.
  const schedulePayload = (event.payload as { schedule?: RunNowPayload['schedule'] }).schedule
  runPayload = { projectId: rule.projectId, schedule: schedulePayload }
}
```

In `buildTriggerContext`, add:

```ts
if (payload?.schedule) {
  triggerContext.schedule = payload.schedule
}
```

**Step 4: Run to verify it passes**

Run: `pnpm test src/main/automations/service.test.ts`
Expected: PASS.

**Step 5: Typecheck**

Run: `pnpm tc:node`
Expected: no new errors.

**Step 6: Commit**

```bash
git add src/main/automations/service.ts src/main/automations/service.test.ts
git commit -m "feat(automations): dispatch + run context for schedule triggers"
```

---

## Task 8: Editor plumbing — add-trigger seed + card dispatch

Make "Schedule" selectable in the Add menu with a sensible default, and route its card.

**Files:**
- Modify: `src/renderer/src/components/automations/editor/TriggersModal.tsx` (`addTrigger`)
- Modify: `src/renderer/src/components/automations/editor/AutoTriggerCard.tsx` (render dispatch)

**Step 1: Seed a default schedule config in `addTrigger`**

Where `addTrigger` special-cases `http-endpoint`, add a schedule branch that seeds daily-09:00 in the user's system zone:

```ts
const next: AutoTrigger =
  source === 'http-endpoint'
    ? { ...base, ...httpDefaults }
    : source === 'schedule'
      ? {
          ...base,
          rules: [],
          // Daily 09:00 in the user's zone is the friendliest default.
          schedule: { cron: '0 9 * * *', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
        }
      : base
```

**Step 2: Route the card in `AutoTriggerCard`**

Next to the `http-endpoint` dispatch (~line 166):

```tsx
if (props.trigger.source === 'schedule') {
  return <ScheduleTriggerCard {...props} />
}
```

Import `ScheduleTriggerCard` (created in Task 9). Ensure the schedule branch returns before the shared RuleRow/conditions UI so no conditions render. The github-pr repo-watch-list (~line 197) must stay gated to github-pr only.

**Step 3: Typecheck (expected to fail until Task 9)**

Run: `pnpm tc:web`
Expected: FAIL — `ScheduleTriggerCard` not found. Proceed to Task 9 (or create the file stub first); commit together with Task 9.

> Note: commit this task together with Task 9 so the renderer stays compiling.

---

## Task 9: `ScheduleTriggerCard` — the visual builder

The friendly builder + Advanced raw-cron + live "next runs", driven entirely by `schedule-cron`.

**Files:**
- Create: `src/renderer/src/components/automations/editor/ScheduleTriggerCard.tsx`
- Test: `src/renderer/src/components/automations/editor/ScheduleTriggerCard.test.tsx` (if the renderer has a jsdom/RTL setup — check `config/vitest.config.ts`; otherwise rely on the Task 12 e2e and keep logic in `schedule-cron`, already unit-tested)

**Step 1: Read STYLEGUIDE + an existing card**

Read `docs/STYLEGUIDE.md` and `HttpEndpointTriggerCard.tsx` for the card chrome, spacing tokens, and shadcn primitives in use (`Select`, `Collapsible`, label/section layout — note recent fixes put section labels *above* their controls).

**Step 2: Implement the card**

Props match the other trigger cards (`{ trigger, onChange, … }`). Behavior:
- Derive mode from `recurrenceFromCron(trigger.schedule.cron)`. Non-null → friendly builder; `null` → "Custom", Advanced expanded, builder hidden.
- Controls by `freq`:
  - **Repeat** `Select`: Hourly / Daily / Weekly / Monthly. Changing freq builds a default recurrence for that freq and writes cron via `cronFromRecurrence`.
  - **Weekly**: weekday toggle chips (Mon–Sun; store 0=Sun…6=Sat). Default Mon–Fri.
  - **Monthly**: day-of-month `Select` (1–28, plus a "last day" option only if trivially expressible — otherwise omit; YAGNI).
  - **Time** (daily/weekly/monthly): hour + minute selects. **Minute-only** (hourly): minute select.
  - **Timezone**: searchable `Select` over `Intl.supportedValuesOf('timeZone')`, default the trigger's `timezone`.
- Any builder change recomputes `cron` via `cronFromRecurrence` and calls `onChange({ ...trigger, schedule: { cron, timezone } })`.
- **Advanced (raw cron)** in a `Collapsible`: an input bound to `trigger.schedule.cron`. On edit, validate with `isValidCron`; invalid → inline error (STYLEGUIDE destructive token) + suppress preview; valid → persist.
- **Next runs**: `nextOccurrences(cron, timezone, Date.now(), 3)`, each formatted with `new Intl.DateTimeFormat(undefined, { timeZone, weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })`. Empty list (invalid cron) → hide the preview block.

Keep all schedule semantics in `schedule-cron` — the card only renders state and calls the bridge.

**Step 3: Verify**

Run: `pnpm tc:web`
Expected: PASS. If an RTL test was added, `pnpm test <card test path>` PASS.

**Step 4: Manual smoke (optional)**

Use the `run` skill / app to open an automation → Triggers → Add → Schedule; confirm builder edits update the preview and the Advanced cron field round-trips.

**Step 5: Commit (Tasks 8 + 9 together)**

```bash
git add src/renderer/src/components/automations/editor/ScheduleTriggerCard.tsx \
        src/renderer/src/components/automations/editor/AutoTriggerCard.tsx \
        src/renderer/src/components/automations/editor/TriggersModal.tsx
git commit -m "feat(automations): schedule trigger card with visual builder + cron"
```

---

## Task 10: Save validation

Block saving a schedule trigger with an invalid cron.

**Files:**
- Modify: `src/renderer/src/components/automations/editor/chain-editor-modal-state.ts` (~lines 104/110 where github-pr/http-endpoint are validated)
- Test: `chain-editor-modal-state` test if one exists (check); else add one.

**Step 1: Write/extend the failing test**

Assert a schedule trigger with `schedule.cron = 'garbage'` makes the editor state invalid, and `'0 9 * * *'` makes it valid. (Import `isValidCron` from `schedule-cron`.)

**Step 2: Run to verify it fails**

Run: `pnpm test src/renderer/src/components/automations/editor/<chain-editor-modal-state test>`
Expected: FAIL.

**Step 3: Implement**

Add a schedule arm to the per-source validation:

```ts
if (t.source === 'schedule') {
  return !!t.schedule && isValidCron(t.schedule.cron)
}
```

**Step 4: Run to verify it passes + typecheck**

Run: `pnpm test <that test> && pnpm tc:web`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/renderer/src/components/automations/editor/chain-editor-modal-state.ts <test>
git commit -m "feat(automations): block save on invalid schedule cron"
```

---

## Task 11: Poll-status reporting

Report schedule triggers' *next run* (not "last poll") in `getPollStatus`.

**Files:**
- Modify: `src/main/automations/auto-trigger-engine.ts` (`getPollStatus`, ~line 267)
- Test: `auto-trigger-engine.test.ts`

**Step 1: Write the failing test**

Assert `getPollStatus()` includes the `schedule` source with `lastPollAt` reporting `scheduleNextRun(triggerId)` (or 0 when unanchored) and `intervalMs` as the engine interval.

**Step 2: Run to verify it fails → implement**

Add a `schedule` branch mirroring the `http-endpoint` one:

```ts
} else if (t.source === 'schedule') {
  // Time-driven: surface the next fire instant rather than a last-poll time.
  result.set(t.source, {
    lastPollAt: this.deps.scheduleNextRun(t.id),
    intervalMs: this.intervalMs
  })
}
```

**Step 3: Run to verify it passes + typecheck**

Run: `pnpm test src/main/automations/auto-trigger-engine.test.ts && pnpm tc:node`
Expected: PASS.

**Step 4: Commit**

```bash
git add src/main/automations/auto-trigger-engine.ts src/main/automations/auto-trigger-engine.test.ts
git commit -m "feat(automations): report schedule next-run in poll status"
```

---

## Task 12: End-to-end test

Cover the renderer flow, mirroring the existing http-trigger-card e2e.

**Files:**
- Find the existing http trigger card e2e (the recent commits reference "http trigger card section labels"); create a sibling schedule spec.

**Step 1: Write the e2e**

Open an automation editor → Triggers → Add → Schedule. Assert:
- the card renders with the default daily-09:00 builder,
- changing Repeat to Weekly shows weekday chips and updates the "Next runs" preview,
- expanding Advanced shows the cron `0 9 * * *`; typing an invalid cron shows the error and hides the preview; a valid cron restores it,
- saving persists and reopening shows the same schedule.

**Step 2: Run**

Run: `pnpm test:e2e -- <schedule spec>` (electron-headless)
Expected: PASS.

**Step 3: Commit**

```bash
git add tests/<schedule e2e spec>
git commit -m "test(e2e): schedule trigger card builder + cron + preview"
```

---

## Final verification

Run, and confirm green (targeted — not the full suite):

```bash
pnpm tc:node && pnpm tc:web
pnpm test src/shared/schedule-cron.test.ts \
          src/main/automations/trigger-sources/schedule.test.ts \
          src/main/automations/auto-trigger-engine.test.ts \
          src/main/automations/service.test.ts \
          src/shared/automations-types.test.ts
pnpm test:e2e -- <schedule spec>
```

Then use superpowers:requesting-code-review before merging.

## Notes / deferred (YAGNI)

- No conditions, no manual picker, no `repoIds` for schedule (by design).
- No persisted next-run/catch-up — skip-missed is intentional.
- "Every N minutes" and "last day of month" are omitted; the Advanced raw-cron field covers power cases. Add friendly controls later only if asked.
- The old RRULE schedule system (`automation-schedules.ts`, the migration, `LEGACY_AUTOMATION_FIELDS`) is left untouched.
- Sub-tick-granularity raw crons (e.g. `* * * * *` with a 60s+ poll interval) drop intermediate occurrences: the engine fires at most once per tick and advances from `now`. Consistent with skip-missed; the visual builder can't produce sub-hourly minute patterns, so this only affects hand-written Advanced crons.
- Editing a live trigger's cron/timezone re-anchors strictly to the next future occurrence of the new schedule (no stray fire at the old instant); handled via a per-trigger anchor signature in the engine.
