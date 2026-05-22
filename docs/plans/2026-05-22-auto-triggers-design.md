# Automation Auto-Triggers — Design

**Status:** Approved (brainstorming → design); ready for implementation plan.
**Date:** 2026-05-22

## Goal

Add automatic triggers to automations alongside the existing manual Run Now path. v1 ships a *Linear-issue* trigger source, but the data model, condition editor, and poller engine are designed around a pluggable **source** abstraction so additional integrations (GitHub PR events, Slack mentions, file-watch, calendar, etc.) can be added later without touching the editor or the runtime.

Companion feature in the same phase: an explicit **restart** action on terminal-failed runs, since auto-fire dedup otherwise leaves a failed run with no path forward except hand-rebuilding the manual payload.

## Key shape

- An automation may carry zero or more `AutoTrigger`s alongside its always-on manual trigger.
- Each `AutoTrigger` declares a `source` (e.g. `'linear-issue'`) and an ordered list of `Rule`s.
- A rule is `{ conditions: Condition[], projectId }` — an AND of typed conditions against the source's *field catalog*, plus the project to run in. First match wins per event.
- A `Condition` is `{ field, op, value }` where `field` is a dotted path the source publishes (e.g. `linear.assignee`, `linear.tag`, `linear.state`, `linear.priority`). The editor is generic; the source contributes the catalog (fields → allowed ops → value editor).
- A **poller engine** on each scheduler-owner host iterates registered sources on a user-configurable cadence (default 60s, min 15s, max 600s). Each source yields a stream of `{ entityId, payload }` candidate events; the engine evaluates them against every active rule and dispatches runs for first matches.
- Dedup is `(automationId, autoTriggerId, entityId)`: once we fire for an issue, we never auto-fire again for it. Manual Run Now and Restart still work.

## Out of scope (this phase)

- Cross-source compound rules ("Linear assigned to me AND open GitHub PR"). Each rule's conditions are scoped to its trigger's single source. The schema makes future composition possible but the editor doesn't expose it.
- Linear webhooks.
- OR / NOT inside a single rule (OR via multiple rules; first-match-wins ordering).
- Linear conditions beyond `assignee` / `tag` / `state` / `priority` in v1.
- Backfilling against pre-existing matches — gated by an `enabledAt` watermark per trigger.
- Per-automation poll intervals — one global cadence per host.
- Restart of `completed` runs (Run Now covers that intent).
- TTL on the dedup set.

## Why a source registry, not Linear-specific code

Three places would otherwise duplicate Linear knowledge: the schema, the condition editor, and the poller. A `TriggerSource` interface (`{ id, fieldCatalog, poll(): AsyncIterable<CandidateEvent> }`) collapses those into one extension point. Adding a new source means: register the source, define its `poll` function, register its field catalog. No edits to the editor, schema, or engine.

## Why polling, not webhooks

Webhooks need a public ingress and shared secret; polling fits Orca's host-process model (local app, SSH bridge, remote daemon) without extra network plumbing. The trade-off — 15–60s lag vs. seconds — is acceptable for the agent-workflow use case.

## Data model

Shared types live in `src/shared/automations-types.ts`.

```ts
export type Automation = {
  // …existing fields…
  trigger?: TriggerConfig          // unchanged — governs Run Now experience
  autoTriggers?: AutoTrigger[]     // NEW — zero or more automatic triggers
}

export type AutoTrigger = {
  id: string                       // stable id, used for dedup-set scoping
  source: TriggerSourceId          // 'linear-issue' in v1
  enabled: boolean
  enabledAt: number                // ms epoch; watermark for historical fires
  rules: Rule[]                    // ordered; first match wins per event
}

export type Rule = {
  id: string
  conditions: Condition[]          // AND of conditions; empty array = always match
  projectId: string                // run target; required (no fallback to automation.projectId)
}

export type Condition = {
  field: string                    // dotted path published by source, e.g. 'linear.tag'
  op: ConditionOp                  // 'is' | 'is-any-of' | 'gte' | 'contains-any' | …
  value: ConditionValue            // shape constrained by (field, op) at validation time
}

export type ConditionOp =
  | 'is' | 'is-not'
  | 'is-any-of' | 'is-none-of'
  | 'contains-any' | 'contains-all' | 'contains-none'
  | 'gte' | 'lte' | 'eq'

export type ConditionValue = string | number | string[] | number[]

export type TriggerSourceId = 'linear-issue' // open union; new sources extend it
```

Run-trigger metadata extends to record what fired the run:

```ts
export type AutomationRunTrigger = 'scheduled' | 'manual' | 'auto'

export type AutomationRun = {
  // …existing…
  trigger: AutomationRunTrigger
  triggerSource?: TriggerSourceId
  triggerAutoTriggerId?: string
  triggerRuleId?: string
  triggerEntityId?: string                  // for Linear, the issue id
  restartedFromRunId?: string               // restart lineage
}
```

### Source registry interface

`src/main/automations/trigger-sources/types.ts`:

```ts
export type FieldDescriptor = {
  field: string                              // 'linear.tag'
  label: string                              // 'Has tag'
  valueKind: 'user' | 'label' | 'state' | 'priority' | 'string' | 'number'
  ops: ConditionOp[]                         // ops this field allows
  fetchOptions?: (ctx: PollCtx) => Promise<Array<{value: string; label: string}>>
}

export type CandidateEvent = {
  entityId: string                           // 'ORC-123'; used for dedup
  updatedAt: number                          // ms epoch; engine filters against watermarks
  payload: Record<string, unknown>           // becomes run.context.trigger.<source>.*
  fields: Record<string, unknown>            // { 'linear.assignee': '…', 'linear.tag': ['orca'], … }
}

export type TriggerSource = {
  id: TriggerSourceId
  displayName: string
  fieldCatalog: FieldDescriptor[]
  poll: (ctx: PollCtx) => AsyncIterable<CandidateEvent>
}
```

### Persistence

- `automations.autoTriggers` column: optional JSON blob, additive.
- New table `automation_auto_dedup` with `(automationId, autoTriggerId, sourceId, entityId, firedAt)`. Primary key on first four fields. Append-only, per-host sqlite, same store as existing automation tables.
- New per-host setting `automations.pollIntervalSeconds`: default 60, min 15, max 600.
- Per-(sourceId, hostId) `lastPollTimestamp` lives in the same settings store.

### Migration

Additive only. Automations without `autoTriggers` keep loading and running unchanged. No data backfill.

## Polling engine

`src/main/automations/auto-trigger-engine.ts`, a sibling to the existing scheduler. One instance per scheduler-owner host (local, SSH bridge, remote). The existing rrule scheduler stays untouched.

### Tick loop

```
every pollIntervalSeconds:
  1. Collect active triggers
       triggers = automations.flatMap(a =>
         (a.autoTriggers ?? []).filter(t => t.enabled).map(t => ({a, t})))
       if triggers empty → noop, return
  2. Group by source
       bySource = groupBy(triggers, ({t}) => t.source)
  3. For each (sourceId, group):
       const source = registry.get(sourceId)
       const since  = min(group.map(({t}) =>
                       max(t.enabledAt, lastPoll(sourceId, hostId))))
       for await (const ev of source.poll({ since, hostId })):
         if (ev.updatedAt <= since) continue                    // belt+suspenders
         for ({a, t} of group):
           if (ev.updatedAt < t.enabledAt) continue             // per-trigger watermark
           if (dedupHas(a.id, t.id, ev.entityId)) continue
           const rule = firstMatch(t.rules, ev)
           if (!rule) continue
           await dispatchAutoRun({ automation: a, trigger: t, rule, event: ev })
           dedupInsert(a.id, t.id, ev.entityId, now())
       lastPollSet(sourceId, hostId, now())
  4. Each iteration wrapped in try/catch so one bad source/event
     doesn't kill the loop.
```

A simple in-process mutex guarantees ticks don't overlap; if one takes longer than the interval, the next is skipped rather than queued.

### Rule evaluation

Pure function. Heavily unit-tested — this is where subtle bugs will hide as we add fields.

```ts
function evaluateRule(rule: Rule, event: CandidateEvent): boolean {
  return rule.conditions.every(c => evalCondition(c, event.fields[c.field]))
}

function evalCondition({op, value}: Condition, actual: unknown): boolean {
  switch (op) {
    case 'is':            return actual === value
    case 'is-not':        return actual !== value
    case 'is-any-of':     return Array.isArray(value) && value.includes(actual as never)
    case 'is-none-of':    return Array.isArray(value) && !value.includes(actual as never)
    case 'contains-any':  return Array.isArray(actual) && actual.some(v => (value as unknown[]).includes(v))
    case 'contains-all':  return Array.isArray(actual) && (value as unknown[]).every(v => actual.includes(v))
    case 'contains-none': return Array.isArray(actual) && (value as unknown[]).every(v => !actual.includes(v))
    case 'gte':           return typeof actual === 'number' && actual >= (value as number)
    case 'lte':           return typeof actual === 'number' && actual <= (value as number)
    case 'eq':            return actual === value
  }
}
```

### Dispatch path

`dispatchAutoRun` is a thin wrapper that constructs a `RunNowPayload`-shaped object from the event and calls the same `automationsService.dispatchRun(...)` the manual Run Now path uses. Differences:

- `run.trigger = 'auto'`, plus `triggerSource`, `triggerAutoTriggerId`, `triggerRuleId`, `triggerEntityId`.
- `run.context.trigger.<source>.*` populated from `event.payload`. For Linear, the same `trigger.linear.issue.*` shape manual triggers already use — step templates work identically.
- The rule's `projectId` overrides `automation.projectId` for the run (same precedence as `RunNowPayload.projectId`).

### Dedup-write ordering

Dedup writes happen *before* dispatch starts the run, so a crash mid-dispatch leaves a phantom dedup row (we'd skip re-firing on restart — fine, matches the "once per issue" semantics). The dedup table is the source of truth; in-memory caches are tick-scoped only. The Restart action is how an operator recovers from a failed auto-fired run.

## Linear source

`src/main/automations/trigger-sources/linear-issue.ts`.

- `poll({ since })`: calls existing Linear GraphQL client for `issues(filter: { updatedAt: { gte: since } })` paginated by cursor. Maps each issue → `CandidateEvent { entityId: issue.id, updatedAt, payload: LinearIssuePayload, fields: { 'linear.assignee', 'linear.tag', 'linear.state', 'linear.priority' } }`.
- `fieldCatalog`:
  - `linear.assignee` — valueKind `user`, ops `['is', 'is-not', 'is-any-of', 'is-none-of']`. Includes a synthetic `"me"` option resolved to the authenticated user at evaluation time.
  - `linear.tag` — valueKind `label`, ops `['contains-any', 'contains-all', 'contains-none']`.
  - `linear.state` — valueKind `state`, ops `['is', 'is-any-of', 'is-none-of']`.
  - `linear.priority` — valueKind `priority`, ops `['eq', 'is-any-of', 'gte', 'lte']`.
- If Linear isn't authenticated, `poll` yields zero events with no thrown error; engine logs once per tick at info.

## Restart action

A failed run today is a dead end on the auto-trigger path: dedup already records the issue, and the user can't manually Run Now without re-picking everything. The Restart action replays a run with its original trigger context.

### Scope

Available for terminal non-success states: `failed`, `dispatch_failed`, `cancelled`, `skipped_missed`, `skipped_unavailable`, `skipped_needs_interactive_auth`. Not exposed for `completed`. Works for auto-fired, manually-fired, and scheduled runs alike.

### Semantics

- Restart creates a *new* `AutomationRun` row with status `pending`. The original failed run is unchanged and stays in the timeline.
- The new run inherits `run.context.trigger`, `triggerSource`, `triggerEntityId`, the resolved `projectId`, and `workspaceId` if `workspaceMode === 'existing'`. For `new_per_run`, a fresh worktree is created by the chain executor.
- The new run's `trigger` field preserves the original (`'auto'` / `'manual'` / `'scheduled'`); `restartedFromRunId` records the lineage.
- The new run uses the **current** automation steps/prompt/agent. Restart means "try again with current config".
- Dedup is **not** touched. The original `(automationId, autoTriggerId, entityId)` row remains; restart is out-of-band, not a new auto-fire.

### IPC + service

```ts
// new IPC
automations:restartRun(runId: string): Promise<AutomationDispatchResult>

// new service method (sketch)
async restartRun(runId): Promise<AutomationDispatchResult> {
  const prior = await store.getRun(runId)
  if (!prior) throw new Error('run not found')
  if (!isRestartable(prior.status)) throw new Error('run is not restartable')
  const automation = await store.getAutomation(prior.automationId)
  if (!automation) throw new Error('automation no longer exists')

  const payload: RunNowPayload = {
    linear: prior.context?.trigger?.linear,
    projectId: deriveProjectId(prior),
  }
  return this.dispatchRun({
    automation,
    payload,
    triggerOverrides: {
      kind: prior.trigger,
      triggerSource: prior.triggerSource,
      triggerAutoTriggerId: prior.triggerAutoTriggerId,
      triggerRuleId: prior.triggerRuleId,
      triggerEntityId: prior.triggerEntityId,
      restartedFromRunId: prior.id,
    },
  })
}
```

`dispatchRun` is the existing internal that both `runNow` and `dispatchAutoRun` funnel through; we extend it with an optional `triggerOverrides` arg so all three callers compose cleanly.

### Edge cases

- *Automation deleted* → restart errors with `automation no longer exists`. Button hidden in the run-detail view.
- *Rule deleted* → fine. We use the prior run's resolved `projectId`; `triggerRuleId` becomes dangling and renders as "Rule deleted" in the run header.
- *Project deleted* → restart errors with `project no longer exists`. Same UX as Run Now.
- *Linear issue archived* → restart still works; we use the captured payload, not a fresh fetch. Steps that need a live lookup are their own concern.
- *Concurrent restarts of the same prior run* → each creates a new run; no dedup. Operator's responsibility.

## Editor & settings UX

### Trigger pill

Today's "Trigger: Manual ▾" graduates into the entry point for both manual options *and* auto triggers. The pill's label summarizes everything that can fire the automation:

- No auto triggers → `Manual`
- Manual + 1 auto trigger → `Manual + Linear auto`
- Manual + N auto triggers → `Manual + N auto triggers`

Clicking opens a **Triggers** sub-modal (not a popover — too much to fit) with two stacked sections:

```
┌─ Triggers ──────────────────────────────────────┐
│ Manual                                          │
│  ☑ Accept Linear ticket on Run                  │
│  ☑ Accept project selection on Run              │
│  ☑ Accept worktree selection on Run             │
│ ─────────────────────────────────────────────── │
│ Automatic                          [+ Add ▾]    │
│  ┌─ Linear issue • enabled ▾  [enable toggle] ─┐│
│  │ Rule 1                                      ││
│  │   Project: [orca-repo  ▾]      [⋮ delete]   ││
│  │   Conditions (all must match):              ││
│  │     • [Assignee   ▾] [is  ▾] [me        ▾]  ││
│  │     • [Has tag    ▾] [any ▾] [orca      ▾]  ││
│  │   [+ Add condition]                         ││
│  │ ─────────────────────────                   ││
│  │ Rule 2 …                                    ││
│  │ [+ Add rule]                                ││
│  │ ─────────────────────────                   ││
│  │ Fired for 12 issues  [View] [Clear all]     ││
│  └─────────────────────────────────────────────┘│
│                            [Cancel] [Save]      │
└─────────────────────────────────────────────────┘
```

`[+ Add ▾]` is a dropdown of registered sources — v1 has one item ("Linear issue"). It reads from the source registry; new sources show up automatically when registered.

### Generic condition row

Three selects driven entirely by the active source's `fieldCatalog`:

1. **Field select.** Lists every `FieldDescriptor`. Label from `descriptor.label`.
2. **Op select.** Lists `descriptor.ops` for the chosen field. Op labels come from a small per-op map.
3. **Value editor.** Switches on `descriptor.valueKind`:
   - `user` → single user picker (Linear users; includes synthetic `"me"`).
   - `label` → label multi-select.
   - `state` → workflow-state multi-select.
   - `priority` → priority picker.
   - `string` / `number` → free input.
   Options come from `descriptor.fetchOptions(ctx)` — called once when the editor opens, cached in component state. `Promise.allSettled` parallelism so a slow Linear endpoint can't hang the editor; each select shows its own skeleton.

The editor component itself knows nothing about Linear. It walks the catalog.

### Project picker

Existing `ProjectPicker` reused per rule. Every rule requires its own `projectId` — no fallback to `automation.projectId`, because the whole point of multi-rule triggers is to fan out by project.

### Validation

Save is disabled until: every rule has a `projectId`; every condition has a `field`, `op`, and a value valid for its `valueKind`; the auto-trigger's `source` is registered.

### Reorder

Rules drag-reorder (first-match-wins matters). Conditions inside a rule don't reorder (AND is commutative).

### Dedup management

The trigger card's footer shows `Fired for N issues` with three actions:

- **View** opens a small list of `{ entityId, identifier, firedAt, link to last run }` rows scoped to that auto-trigger.
- **Clear all** wipes the dedup set for that auto-trigger. A confirm prompt warns: *"This will let already-handled issues fire again on the next poll. Continue?"*
- Each row has its own **Clear** for one-off resets.

### Run detail

- Header shows trigger source + rule ("Auto: Linear issue • Rule 2 (mobile-app)") in addition to the existing Linear-issue link.
- Restartable runs show a **Restart run** button.
- Restart-lineage runs show `Restarted from #<id>` / `Restarted as #<id>` links.

### Settings

A new field in the existing Automations settings panel: `Linear poll interval — [60] seconds` (clamped 15–600, default 60). One value per host; SSH-bridge and remote-host services read their own settings.

## Testing strategy

### Pure-function tests (highest leverage)

- `evalCondition` for every `ConditionOp`, including: `is`/`is-not` against null/undefined; `is-any-of` with empty arrays; `contains-*` with array actuals and array values; `gte`/`lte`/`eq` with numeric edge cases (priority `0` vs `null`); rules with `conditions: []` always match.
- `firstMatch(rules, event)` returns first hit in order; `undefined` when none match.
- Auto-trigger engine tick loop with a fake `TriggerSource` and an in-memory dedup store:
  - dedup'd events don't re-fire,
  - per-trigger `enabledAt` watermark skips older events,
  - per-source `lastPollTimestamp` advances at end of tick,
  - one bad event doesn't kill the loop (caught + logged; others dispatched),
  - mutex prevents overlapping ticks.
- `restartRun` invariants: new run inherits trigger context; dedup set unchanged; restart of non-restartable status throws; restart of a deleted automation throws.

### Source-specific tests (Linear)

- `linearIssueSource.poll({since})` maps Linear GraphQL paginated responses to `CandidateEvent`s with correct `fields` paths.
- Unauthenticated state yields zero events with no thrown error.
- `fieldCatalog.fetchOptions` returns labels/states/users from the existing Linear cache (mocked).

### Component tests (`renderToStaticMarkup`)

- Trigger pill label updates for the four states (no auto / +1 / +N / disabled-N).
- Condition row renders the three selects with catalog-derived options; switching field resets op + value when the new field's op list doesn't include the prior op.
- Rule reorder via drag handle preserves rule ids.
- Save button disabled until validation passes.
- Run-detail Restart button visible only for restartable statuses; lineage links render when `restartedFromRunId` is set.

### Integration tests

- End-to-end: create automation with one rule (assignee=me, tag=orca → project=orca-repo); seed a fake Linear poll that yields a matching issue; assert a run is created with `trigger: 'auto'`, the right rule/project, and `run.context.trigger.linear.issue.title` resolves in a templated step.
- Concurrent dedup: two ticks racing on the same `(automationId, autoTriggerId, entityId)` — only one run is created.
- Restart of an auto-fired failed run produces a new run with the same trigger metadata and no new dedup row.

## Risks

1. **Linear API rate limit / token exhaustion.** Single shared poller per host mitigates the multiplier. Add backoff: on a `429` or rate-limit response, double the next poll's interval up to a ceiling, log a warning, and surface a small banner in the Automations settings panel. The 15s minimum is an explicit lower bound.

2. **Stale field-catalog options.** The editor caches `fetchOptions` results for the lifetime of the modal — adding a new Linear label requires re-opening the trigger editor to see it. Acceptable in v1; add a refresh button if it bites.

3. **Project for a rule was deleted.** Poller silently skips and logs; the rule shows a red "Project deleted" badge in the editor with a fix-or-delete CTA. We don't auto-disable the trigger — other rules may still be valid.

4. **Linear source registered but not authenticated.** Poll yields nothing; logs once per tick. Settings panel shows "Linear not connected — auto triggers paused" when at least one automation has an enabled Linear auto-trigger.

5. **Dedup set growth.** Append-only but bounded in practice (only issues the user is assigned and rules match). If it exceeds ~10k rows per automation, add a 90-day TTL. Not implemented in v1; flag for monitoring.

6. **Auto-fire while the user edits the automation.** Engine reads the automation snapshot at tick start; saves during the tick are picked up next tick. No locking. Worst case: one race-condition fire against old config — acceptable given once-per-issue dedup.

7. **Clock skew between hosts.** Each host's poller uses its own clock for `lastPollTimestamp`/`enabledAt`; issues' `updatedAt` is Linear's clock. Comparing Linear's clock against ours could miss an edge event once. Next poll catches it (we use `gte`, not `gt`).

8. **`fetchOptions` slow path blocks the editor.** Parallel `Promise.allSettled` so a slow Linear endpoint can't hang. Each select shows its own skeleton.

9. **Restart of a run whose automation has structurally changed.** Restart uses current steps; if a step the original depended on was removed, the new run may behave differently. Document in the restart confirmation toast: *"Restart uses the automation's current configuration, not a snapshot."*

10. **Auto-trigger fires for an automation whose underlying agent isn't available.** Same path as scheduled runs today — the run goes to `skipped_unavailable`. Restart covers recovery once availability returns.
