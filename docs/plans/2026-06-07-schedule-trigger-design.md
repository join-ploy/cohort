# Schedule Trigger — Design

**Date:** 2026-06-07
**Status:** Approved, ready for implementation

## Summary

Add a new `schedule` auto-trigger that fires automation runs on a cron-like
recurrence with a friendly, customisable UX (visual builder + raw-cron escape
hatch + live "next runs" preview). It is additive and independent of the old,
dormant RRULE schedule system (`src/shared/automation-schedules.ts`), which is
left untouched.

## Decisions (from brainstorming)

1. **UX:** Visual recurrence builder (Hourly / Daily / Weekly / Monthly + time +
   weekday/day-of-month) with an "Advanced (raw cron)" escape hatch and a live
   "next 3 runs" preview. Maximally flexible while staying approachable.
2. **Missed runs:** *Skip missed, next only.* If scheduled instants pass while the
   app is closed, they are dropped; on launch we anchor to the next future
   occurrence. No catch-up, no backlog.
3. **Conditions:** None. A schedule trigger fires unconditionally when due and
   runs against the automation's project. (No conditions/rules card.)
4. **Cron math:** Add the `croner` dependency, **pinned to an exact version**
   (`croner@10.0.1`, zero transitive deps), matching the repo's all-exact pinning
   convention. Isomorphic, IANA timezone + DST aware.

## Why schedule is different from existing triggers

Linear / GitHub / HTTP triggers follow a *polling* model: `poll()` fetches
candidate events from an external source and fires when conditions match. A
schedule trigger has **no external entity** — time itself is the trigger. So it
reuses the per-trigger, time-driven path (structurally identical to the
http-endpoint per-trigger path) but does local cron math instead of a network
request.

## Data model (`src/shared/automations-types.ts`)

```ts
export type TriggerSourceId =
  | 'linear-issue' | 'github-pr' | 'http-endpoint' | 'schedule'   // + schedule

export type ScheduleConfig = {
  cron: string        // standard 5-field cron, e.g. "0 9 * * 1-5"
  timezone: string    // IANA zone, e.g. "Europe/London" (defaults to system zone)
}

export type AutoTrigger = {
  // …existing fields…
  schedule?: ScheduleConfig   // schedule source only (mirrors source-scoped `http?`)
}

export type RunNowPayload = {
  // …existing fields…
  schedule?: { firedAt: number; scheduledFor: number; cron: string; timezone: string }
}
```

**Single source of truth = the cron string.** The visual builder is purely an
editor over that string; "Advanced (raw cron)" exposes the same string. We store
cron (not a structured recurrence object) so the escape hatch and builder can
never disagree, and so croner is the only interpreter of schedule semantics.

`rules` stays empty for schedule triggers; the engine takes the same "empty rules
⇒ one implicit match targeting `automation.projectId`" path the http source uses.
No `repoIds`, no field catalog.

## Cron + timezone core (`src/shared/schedule-cron.ts`)

One new module, named for its contents (not "helpers"). Wraps croner so the
**same functions run in the engine and the renderer** — preview == reality,
including DST.

```ts
import { Cron } from 'croner'

export function nextOccurrenceAfter(cron: string, tz: string, fromMs: number): number | null
export function nextOccurrences(cron: string, tz: string, fromMs: number, n: number): number[]
export function isValidCron(cron: string): boolean
export function describeCron(cron: string): string   // human summary for the card header

// builder ⇄ cron bridge (UI never hand-builds cron)
export type Recurrence =
  | { freq: 'hourly'; minute: number }
  | { freq: 'daily'; hour: number; minute: number }
  | { freq: 'weekly'; days: number[]; hour: number; minute: number }   // 0=Sun…6=Sat
  | { freq: 'monthly'; dayOfMonth: number; hour: number; minute: number }

export function cronFromRecurrence(r: Recurrence): string
export function recurrenceFromCron(cron: string): Recurrence | null  // null ⇒ advanced/Custom mode
```

`recurrenceFromCron` returning `null` is the signal that drives the UI into raw
cron mode (e.g. `*/15 9-17 * * *`).

## Engine integration (`src/main/automations/auto-trigger-engine.ts`)

Per-trigger, time-driven path mirroring `pollHttpTrigger`. New in-memory state map
(mirrors `httpLastPoll`):

```ts
scheduleNextRun(triggerId) / scheduleNextRunSet(triggerId, ms)   // next fire instant, in-memory only
```

`tick()` filters schedule entries out of `sharedEntries` (like http) and runs each
through `pollScheduleTrigger(entry)`:

```
nextRunAt = scheduleNextRun(trigger.id)
if (nextRunAt === 0) {                                  // first observation this process
  // skip-missed: anchor strictly in the FUTURE so anything that came due
  // while the app was closed is silently dropped.
  scheduleNextRunSet(trigger.id, nextOccurrenceAfter(cron, tz, max(now, enabledAt)))
  return                                                // never fire on the anchoring tick
}
if (now < nextRunAt) return                             // not due yet
event = { entityId: ISO(nextRunAt), updatedAt: nextRunAt,
          payload: { schedule: { firedAt: now, scheduledFor: nextRunAt, cron, timezone } } }
scheduleNextRunSet(trigger.id, nextOccurrenceAfter(cron, tz, now))   // advance BEFORE dispatch
→ dedup-check → dedupInsert(occurrence) → dispatchAutoRun(implicit rule)
```

**Skip-missed correctness:** the map is in-memory, so every (re)start re-anchors to
the next *future* occurrence. A run fires only when its instant elapses while the
engine is actively ticking.

**Idempotency:** `entityId` = the occurrence's ISO instant, so dedup-before-dispatch
makes each scheduled instant fire at most once (tick jitter / double-tick safe).

Empty `rules` ⇒ `{ id:'implicit', conditions:[], projectId: automation.projectId }`.
Automation pause is already honored by the `a.enabled` gate in `tick()`.

## Dispatch & run context (`src/main/automations/service.ts`)

`dispatchAutoRun` gains a `schedule` arm:

```ts
} else if (trigger.source === 'schedule') {
  runPayload = { projectId: rule.projectId, schedule: event.payload.schedule }
}
```

`buildTriggerContext` surfaces it:

```ts
if (payload?.schedule) { triggerContext.schedule = payload.schedule }
```

Result: `run.context.trigger.schedule.{ firedAt, scheduledFor, cron, timezone }` is
available to chain steps. Existing `triggerOverrides` path stamps provenance
(`kind:'auto'`, `triggerSource:'schedule'`, `triggerEntityId` = ISO instant).

No manual picker for schedule, so `run-now-payload-gate.ts` / `RunNowConfirmModal.tsx`
need no schedule logic (they key off `http-endpoint`/`manualEnabled`).

## Renderer UI

Catalog wiring:
- `SOURCE_META` in `AutoTriggerCard.tsx` += `schedule: { label: 'Schedule', icon: CalendarClock }`.
- `TriggersModal.addTrigger('schedule')` seeds `{ …base, rules: [], schedule: { cron: '0 9 * * *', timezone: <system zone> } }`.
- `AutoTriggerCard` render: `if (source === 'schedule') return <ScheduleTriggerCard {...props} />`; schedule skips RuleRow/conditions UI.

New `ScheduleTriggerCard.tsx` (visual builder), driven entirely by the
`schedule-cron` bridge:

```
┌─ Schedule ──────────────────────────────────┐
│ Repeat:  [ Weekly ▾ ]   (Hourly/Daily/       │
│                          Weekly/Monthly)     │
│ On days: [M][T][W][T][F] S  S   ← weekly     │
│ On day:  [ 1 ▾ ] of month       ← monthly    │
│ At time: [ 09 ]:[ 00 ]          ← daily/wk/mo│
│ At min:  [ :00 ]                ← hourly      │
│ Timezone:[ Europe/London ▾ ]                 │
│ ▸ Advanced (raw cron)  → [ 0 9 * * 1-5 ]     │
│ Next runs:                                   │
│  • Mon 8 Jun, 09:00                          │
│  • Tue 9 Jun, 09:00                          │
│  • Wed 10 Jun, 09:00                          │
└──────────────────────────────────────────────┘
```

Behavior:
- On render, `recurrenceFromCron(cron)` selects the mode; `null` auto-expands
  Advanced (labeled "Custom") and hides the builder.
- Builder edits → `cronFromRecurrence(...)` writes the single `cron` field. Advanced
  edits `cron` directly; `isValidCron` gates inline errors and suppresses preview.
- "Next runs" uses `nextOccurrences(cron, tz, now, 3)` — same code the engine fires on.
- STYLEGUIDE tokens + shadcn primitives (Select, toggle/chip, Collapsible);
  timezone is a searchable Select over `Intl.supportedValuesOf('timeZone')`,
  default = system zone.

## Remaining wiring & edge cases

- `index.ts`: `triggerSourceRegistry.register(makeScheduleSource())` — thin source
  for the catalog (`displayName`, empty `fieldCatalog`) + the cron-evaluation `poll()`.
- `chain-editor-modal-state.ts`: validate schedule iff `isValidCron(schedule.cron)`.
- `getPollStatus`: schedule branch reports `nextRunAt` (not "last poll").
- Verified no-op branches: `AutomationsPane.tsx` (linear-issue), `run-now-payload-gate.ts`,
  `RunNowConfirmModal.tsx` (http/manual) — fall through correctly; TS exhaustiveness
  will flag any non-exhaustive `switch` against the widened union.
- Old RRULE schedule system untouched.

## Testing

- `schedule-cron.test.ts` — recurrence⇄cron round-trips, `null`→advanced fallback,
  DST boundaries (Mar/Oct London/NY), invalid cron, `nextOccurrences` ordering.
- `auto-trigger-engine` — skip-missed on (re)start, fires exactly once when due,
  occurrence idempotency under double-tick, pause honored.
- `service.ts` — schedule dispatch payload + `buildTriggerContext`.
- e2e (mirror existing http-trigger-card e2e) — card renders, builder edits update
  cron + preview, Advanced toggle, invalid-cron error state.

Verification: `pnpm tc:node` + `pnpm tc:web` + targeted `vitest` on new suites
(full suite / `tc:cli` have known-unrelated failures).
