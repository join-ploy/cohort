# Manual Picker Run-Status Indicator — Design

Date: 2026-06-08

## Goal

A manual `http-endpoint` trigger renders a run-time list (the "manual picker")
where an operator picks one item to run. Add a config that lets the author
nominate one **field** as the item's identity. At pick time, each list item
shows a mark reflecting the status of the most recent automation run whose stored
trigger value matches that item's identity — so the operator can see, at a
glance, which items have already been run (and how the last run went).

## Decisions

- **Config is one field, stored as a dot-path.** A new optional `idField` on
  `HttpEndpointConfig`, in the manual-only group beside `labelField` /
  `subtitleField`. Stores the field's **dot-path** (e.g. `"id"`), matching how
  `labelField`/`subtitleField` already store paths.
- **Three marks, every run maps to one.** in-progress (spinner), succeeded
  (check), failed (X). Cancelled and skipped fold into **failed (X)** per the
  user's call — an interrupted/never-ran most-recent run still reads as "not a
  clean success". Only an item with **no** matching run renders nothing.
- **Scope: any run of the automation.** Manual *and* auto/polled runs count —
  both store the picked/polled item's mapped vars at
  `context.trigger.http.<variableName>`, so matching is uniform.
- **Strict most-recent.** The single most recent run (by `createdAt`) for an id
  determines its mark — even if an older run is still active.
- **Feature is off when `idField` is unset.** No marks render; picker is
  unchanged from today.
- **v1 reads a runs snapshot at open** (hydrating the runs slice on mount). Live
  per-row updates as a run progresses are a deliberate non-goal for this
  short-lived modal; trivially added later via the slice's reactivity.

## Why path → variableName

An item's identity value lives in `item.vars[variableName]`; a past run's value
lives in `run.context.trigger.http[variableName]`. Both are keyed by
`variableName`, not path. So `idField` stores the path (keeping its config
dropdown identical to label/subtitle), and the picker resolves path →
`variableName` once via `http.fields` before matching.

## Data model

`src/shared/automations-types.ts` — `HttpEndpointConfig`, manual-only group:

```ts
// Manual-only:
labelField?: string
subtitleField?: string
idField?: string // dot-path identifying an item across runs; drives the
                 // run-status mark in the manual picker
```

Optional, so legacy persisted rows parse without migration.

## Config UI

`HttpEndpointTriggerCard.tsx`, "Manual run picker" section — a third
`NativeSelect` mirroring the label/subtitle dropdowns:

- Label: **"Status match field"**; helper: *"Items whose runs share this field's
  value show a run-status mark."*
- Options: the same `scalarFields` (`enabled`, non-`json`), value = `field.path`,
  with a `— None —` default.
- New `setIdField(trigger, idField)` mutator in `http-endpoint-card-state.ts`,
  mirroring `setLabelField`.

## Matching & state resolution (in `HttpEndpointItemPicker`)

`RunNowConfirmModal` already holds the http config, so it passes the picker the
resolved `matchVariableName` (from `idField` → `fields`). Runs come from the
existing `automation-runs` Zustand slice (`automationRunsById`, full `context`
intact across IPC), filtered to this `automationId`; the picker calls
`fetchAutomationRuns()` on mount if the slice isn't hydrated.

Runs are already sorted newest-first by `createdAt`. Reduce once (`useMemo`) into
a value→latest-run map (first wins = most recent):

```ts
const runByIdValue = new Map<string, AutomationRun>()
for (const run of runsForAutomation) {            // newest-first
  const v = run.context?.trigger?.http?.[matchVariableName]
  if (v == null || v === '') continue
  const key = String(v)                            // string-coerce both sides
  if (!runByIdValue.has(key)) runByIdValue.set(key, run)
}
```

Per item: `runByIdValue.get(String(item.vars[matchVariableName]))`, then map
`run.status` to a mark:

| Mark | Statuses |
|---|---|
| **in-progress** | pending, dispatching, dispatched, running, waiting |
| **succeeded** | completed |
| **failed** | failed, dispatch_failed, cancelled, skipped_missed, skipped_unavailable, skipped_needs_interactive_auth |

`String()` coercion on both sides guards numeric-vs-string id drift (`123` vs
`"123"`). Empty/nullish identity values are skipped.

## Rendering

Trailing-edge mark per `CommandItem` row (label/subtitle column gets `flex-1` so
marks align in a right-hand column); the leading `Globe` stays. lucide icons,
semantic-token colors aligned with `getAutomationRunStatusVariant`:

- **in-progress** → `LoaderCircle` + `animate-spin`, `text-muted-foreground`
  (the spinner the picker already uses).
- **succeeded** → `Check` / `CircleCheck` — "done" reading (confirm exact token
  vs `main.css`; `completed` is the neutral/secondary state, not green).
- **failed** → `CircleX` / `X`, `text-destructive`.

Each mark carries `title`/`aria-label` = `getAutomationRunStatusLabel(run.status)`
("Running" / "Done" / "Failed" / "Cancelled" …) so the precise most-recent status
shows through the coarse three-icon mark, for both hover and screen readers.

## Edge cases

- `idField` unset → feature off, no marks.
- Item's identity value empty/nullish → no mark for that item.
- No matching run → no mark.
- Numeric vs string id values → handled by `String()` coercion.
- Cancelled/skipped most-recent run → **X** (per decision).

## Testing

- **Unit (pure helpers, extract for testability):**
  - `runByIdValue` reducer: most-recent wins; nullish/empty skipped; string
    coercion across number/string.
  - status → mark mapper: every `AutomationRunStatus` lands in the right bucket
    (table-driven over the full union).
  - `idField` path → `variableName` resolution from `fields`.
- **Component (`HttpEndpointItemPicker`):** given items + a stubbed runs slice,
  asserts correct mark (and `aria-label`) per row, and no mark when `idField`
  unset / no match.
- **State mutator:** `setIdField` round-trips on the trigger.

## Out of scope (YAGNI)

- Live per-row updates while a run progresses (snapshot-at-open only).
- Matching on composite/multi-field identity (single field only).
- Counts/history beyond the single most-recent run.
