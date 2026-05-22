# Automation Auto-Triggers Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add automatic Linear-polled triggers to automations (alongside existing manual Run Now), plus an explicit Restart action for terminal-failed runs. v1 ships a Linear-issue source behind a pluggable source registry so future integrations slot in without editor changes.

**Architecture:** Source registry abstraction (`TriggerSource` interface with `fieldCatalog` + `poll()`) lets the polling engine, rule evaluator, and condition editor stay source-agnostic. Engine runs per scheduler-owner host, evaluates each candidate event against every active rule (AND of conditions, first-match-wins per event), and dispatches through the existing `dispatchRun` path. Dedup keyed `(automationId, autoTriggerId, entityId)` is written *before* dispatch, with Restart as the operator's recovery path.

**Tech Stack:** TypeScript, Electron (main + renderer), Vitest, React + shadcn primitives, JSON-blob `PersistedState`, existing Linear GraphQL client.

**Reference design:** `docs/plans/2026-05-22-auto-triggers-design.md`.

**Conventions:**
- All typechecks via `pnpm tc` / `pnpm tc:node` / `pnpm tc:web` (uses `tsgo`, not `tsc`).
- All tests via `pnpm vitest run <path>` (single-file targeted runs).
- Project-owned types go in `.ts` files, never `.d.ts`. See `docs/preload-typecheck-hole.md`.
- Follow [`docs/STYLEGUIDE.md`](../STYLEGUIDE.md) for UI tokens, spacing, and shadcn primitive use.
- Commit after every passing test step — no batching multiple tasks into one commit.
- Run the design doc through the section it covers before each phase so the reader has the rationale loaded.

---

## Phase 1 — Shared types

### Task 1.1: Add AutoTrigger / Rule / Condition types

**Files:**
- Modify: `src/shared/automations-types.ts`
- Test: `src/shared/automations-types.test.ts`

**Step 1: Write the failing test**

Append to `src/shared/automations-types.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { Automation, AutoTrigger, Rule, Condition } from './automations-types'

describe('AutoTrigger shape', () => {
  it('accepts a minimal linear-issue auto trigger', () => {
    const cond: Condition = {
      field: 'linear.assignee',
      op: 'is',
      value: 'me@example.com'
    }
    const rule: Rule = {
      id: 'r1',
      conditions: [cond],
      projectId: 'p1'
    }
    const trig: AutoTrigger = {
      id: 'at1',
      source: 'linear-issue',
      enabled: true,
      enabledAt: 1_700_000_000_000,
      rules: [rule]
    }
    const a: Automation = {
      id: 'a1',
      name: 'x',
      prompt: 'p',
      agentId: 'claude-code',
      projectId: 'p1',
      executionTargetType: 'local',
      executionTargetId: 'local',
      schedulerOwner: 'local_host_service',
      workspaceMode: 'new_per_run',
      workspaceId: null,
      baseBranch: 'main',
      timezone: 'UTC',
      rrule: '',
      dtstart: 0,
      enabled: true,
      nextRunAt: 0,
      missedRunPolicy: 'run_once_within_grace',
      missedRunGraceMinutes: 5,
      createdAt: 0,
      updatedAt: 0,
      autoTriggers: [trig]
    }
    expect(a.autoTriggers?.[0]?.rules[0]?.projectId).toBe('p1')
  })
})
```

**Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/shared/automations-types.test.ts
```

Expected: FAIL (types `AutoTrigger`, `Rule`, `Condition` are not exported).

**Step 3: Add the types**

In `src/shared/automations-types.ts`, after the existing `TriggerConfig` definition:

```ts
export type TriggerSourceId = 'linear-issue'

export type ConditionOp =
  | 'is'
  | 'is-not'
  | 'is-any-of'
  | 'is-none-of'
  | 'contains-any'
  | 'contains-all'
  | 'contains-none'
  | 'gte'
  | 'lte'
  | 'eq'

export type ConditionValue = string | number | string[] | number[]

export type Condition = {
  field: string
  op: ConditionOp
  value: ConditionValue
}

export type Rule = {
  id: string
  conditions: Condition[]
  projectId: string
}

export type AutoTrigger = {
  id: string
  source: TriggerSourceId
  enabled: boolean
  enabledAt: number
  rules: Rule[]
}
```

And add `autoTriggers?: AutoTrigger[]` to the `Automation` type and `AutomationCreateInput`.

**Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/shared/automations-types.test.ts
pnpm tc
```

Expected: PASS; typecheck clean.

**Step 5: Commit**

```bash
git add src/shared/automations-types.ts src/shared/automations-types.test.ts
git commit -m "auto-triggers: shared AutoTrigger/Rule/Condition types"
```

---

### Task 1.2: Extend AutomationRun trigger metadata

**Files:**
- Modify: `src/shared/automations-types.ts`
- Test: `src/shared/automations-types.test.ts`

**Step 1: Add a test that constructs an auto-fired run**

```ts
it('AutomationRun records auto-trigger metadata', () => {
  const r: AutomationRun = {
    id: 'r1',
    automationId: 'a1',
    title: 't',
    scheduledFor: 0,
    status: 'pending',
    trigger: 'auto',
    triggerSource: 'linear-issue',
    triggerAutoTriggerId: 'at1',
    triggerRuleId: 'r1',
    triggerEntityId: 'ORC-123',
    restartedFromRunId: undefined,
    workspaceId: null,
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    error: null,
    startedAt: null,
    dispatchedAt: null,
    createdAt: 0
  }
  expect(r.trigger).toBe('auto')
})
```

**Step 2: Run it, observe failure**

```bash
pnpm vitest run src/shared/automations-types.test.ts
```

Expected: FAIL (`'auto'` not assignable to `AutomationRunTrigger`).

**Step 3: Extend types**

In `src/shared/automations-types.ts`:

```ts
export type AutomationRunTrigger = 'scheduled' | 'manual' | 'auto'

export type AutomationRun = {
  // …existing fields…
  triggerSource?: TriggerSourceId
  triggerAutoTriggerId?: string
  triggerRuleId?: string
  triggerEntityId?: string
  restartedFromRunId?: string
}
```

**Step 4: Re-run test + typecheck**

```bash
pnpm vitest run src/shared/automations-types.test.ts
pnpm tc
```

Expected: PASS clean.

**Step 5: Commit**

```bash
git add src/shared/automations-types.ts src/shared/automations-types.test.ts
git commit -m "auto-triggers: AutomationRun trigger-source metadata"
```

---

## Phase 2 — Persistence (JSON state)

### Task 2.1: Add `automationAutoDedup` and `automationsPollIntervalSeconds` to PersistedState

**Files:**
- Modify: `src/shared/types.ts` (PersistedState, GlobalSettings)
- Modify: `src/main/persistence.ts` (load/save shape; default state)
- Test: `src/main/persistence.test.ts`

**Step 1: Write the failing test**

Add to `src/main/persistence.test.ts`:

```ts
it('initializes automationAutoDedup as empty array and poll interval at 60', () => {
  const store = new Store({ /* existing test ctor args */ })
  expect(store.listAutomationAutoDedup()).toEqual([])
  expect(store.getAutomationsPollIntervalSeconds()).toBe(60)
})
```

**Step 2: Run it**

```bash
pnpm vitest run src/main/persistence.test.ts -t 'automationAutoDedup'
```

Expected: FAIL (methods don't exist).

**Step 3: Extend shared types**

In `src/shared/types.ts`:

```ts
export type AutoDedupEntry = {
  automationId: string
  autoTriggerId: string
  sourceId: TriggerSourceId
  entityId: string
  entityIdentifier?: string   // human-readable id like 'ORC-123' for the dedup UI
  firedAt: number
  lastRunId?: string
}

// Add to PersistedState:
automationAutoDedup: AutoDedupEntry[]
```

Add to `GlobalSettings`:

```ts
automationsPollIntervalSeconds?: number   // default 60, min 15, max 600
```

Update `getDefaultPersistedState` to initialize `automationAutoDedup: []`.

**Step 4: Implement the Store methods**

In `src/main/persistence.ts`:

```ts
listAutomationAutoDedup(automationId?: string, autoTriggerId?: string): AutoDedupEntry[] {
  const all = this.state.automationAutoDedup ?? []
  return all.filter(
    (e) =>
      (automationId == null || e.automationId === automationId) &&
      (autoTriggerId == null || e.autoTriggerId === autoTriggerId)
  )
}

hasAutomationAutoDedup(automationId: string, autoTriggerId: string, entityId: string): boolean {
  return (this.state.automationAutoDedup ?? []).some(
    (e) =>
      e.automationId === automationId &&
      e.autoTriggerId === autoTriggerId &&
      e.entityId === entityId
  )
}

insertAutomationAutoDedup(entry: AutoDedupEntry): void {
  if (this.hasAutomationAutoDedup(entry.automationId, entry.autoTriggerId, entry.entityId)) return
  this.state.automationAutoDedup = [...(this.state.automationAutoDedup ?? []), entry]
  this.persist()
}

clearAutomationAutoDedup(automationId: string, autoTriggerId: string, entityId?: string): void {
  this.state.automationAutoDedup = (this.state.automationAutoDedup ?? []).filter((e) => {
    if (e.automationId !== automationId || e.autoTriggerId !== autoTriggerId) return true
    return entityId != null && e.entityId !== entityId
  })
  this.persist()
}

getAutomationsPollIntervalSeconds(): number {
  return clamp(this.state.settings.automationsPollIntervalSeconds ?? 60, 15, 600)
}

setAutomationsPollIntervalSeconds(value: number): void {
  this.state.settings = {
    ...this.state.settings,
    automationsPollIntervalSeconds: clamp(value, 15, 600)
  }
  this.persist()
}
```

Also extend the load path (around the existing `automationRuns: Array.isArray(...)` guard) to initialize `automationAutoDedup` as an array on legacy state.

**Step 5: Run tests + typecheck**

```bash
pnpm vitest run src/main/persistence.test.ts -t 'automationAutoDedup'
pnpm tc:node
```

Expected: PASS clean.

**Step 6: Commit**

```bash
git add src/shared/types.ts src/main/persistence.ts src/main/persistence.test.ts
git commit -m "auto-triggers: persist dedup set and poll interval setting"
```

---

### Task 2.2: Persist `autoTriggers` on Automation

**Files:**
- Modify: `src/main/persistence.ts` (createAutomation, updateAutomation)
- Test: `src/main/persistence.test.ts`

**Step 1: Write the failing test**

```ts
it('round-trips autoTriggers through create/update/list', () => {
  const store = new Store({ /* ... */ })
  const created = store.createAutomation({
    name: 'x', prompt: '', agentId: 'claude-code', projectId: 'p1',
    workspaceMode: 'new_per_run', timezone: 'UTC', rrule: '', dtstart: 0
  })
  store.updateAutomation(created.id, {
    autoTriggers: [{
      id: 'at1', source: 'linear-issue', enabled: true, enabledAt: 1,
      rules: [{ id: 'rl1', conditions: [], projectId: 'p1' }]
    }]
  })
  const after = store.listAutomations().find((a) => a.id === created.id)
  expect(after?.autoTriggers?.[0]?.rules[0]?.projectId).toBe('p1')
})
```

**Step 2: Run, expect FAIL** (the `updateAutomation` Pick type doesn't include `autoTriggers`).

**Step 3: Add `autoTriggers` to `AutomationUpdateInput`** in `src/shared/automations-types.ts` (extend the existing `Pick<...>`), and propagate through `updateAutomation` in `persistence.ts` (most likely already structural; verify).

**Step 4: Re-run + typecheck**

```bash
pnpm vitest run src/main/persistence.test.ts -t 'autoTriggers'
pnpm tc
```

**Step 5: Commit**

```bash
git add -A
git commit -m "auto-triggers: persist Automation.autoTriggers through update"
```

---

## Phase 3 — Source registry interface

### Task 3.1: Define TriggerSource interface

**Files:**
- Create: `src/main/automations/trigger-sources/types.ts`
- Test: `src/main/automations/trigger-sources/types.test.ts`

**Step 1: Write the failing test (compile-only)**

```ts
import { describe, it, expectTypeOf } from 'vitest'
import type { TriggerSource, FieldDescriptor, CandidateEvent, PollCtx } from './types'

describe('TriggerSource interface', () => {
  it('has the expected shape', () => {
    expectTypeOf<TriggerSource>().toHaveProperty('id')
    expectTypeOf<TriggerSource>().toHaveProperty('fieldCatalog')
    expectTypeOf<TriggerSource>().toHaveProperty('poll')
  })
})
```

**Step 2: Run, expect FAIL** (file doesn't exist).

**Step 3: Write the file**

```ts
import type { ConditionOp, TriggerSourceId } from '../../../shared/automations-types'

export type PollCtx = {
  since: number
  hostId: string
}

export type FieldDescriptor = {
  field: string
  label: string
  valueKind: 'user' | 'label' | 'state' | 'priority' | 'string' | 'number'
  ops: ConditionOp[]
  fetchOptions?: (ctx: PollCtx) => Promise<Array<{ value: string; label: string }>>
}

export type CandidateEvent = {
  entityId: string
  entityIdentifier?: string
  updatedAt: number
  payload: Record<string, unknown>
  fields: Record<string, unknown>
}

export type TriggerSource = {
  id: TriggerSourceId
  displayName: string
  fieldCatalog: FieldDescriptor[]
  poll: (ctx: PollCtx) => AsyncIterable<CandidateEvent>
}
```

**Step 4: Run + typecheck.**

**Step 5: Commit**

```bash
git add src/main/automations/trigger-sources/types.ts src/main/automations/trigger-sources/types.test.ts
git commit -m "auto-triggers: TriggerSource interface"
```

---

### Task 3.2: Source registry

**Files:**
- Create: `src/main/automations/trigger-sources/registry.ts`
- Test: `src/main/automations/trigger-sources/registry.test.ts`

**Step 1: Test**

```ts
import { describe, it, expect } from 'vitest'
import { TriggerSourceRegistry } from './registry'
import type { TriggerSource } from './types'

const fake: TriggerSource = {
  id: 'linear-issue',
  displayName: 'Linear issue',
  fieldCatalog: [],
  poll: async function* () {}
}

describe('TriggerSourceRegistry', () => {
  it('registers and looks up sources', () => {
    const r = new TriggerSourceRegistry()
    r.register(fake)
    expect(r.get('linear-issue')).toBe(fake)
    expect(r.list()).toEqual([fake])
  })

  it('throws on duplicate id', () => {
    const r = new TriggerSourceRegistry()
    r.register(fake)
    expect(() => r.register(fake)).toThrow(/already registered/)
  })

  it('returns undefined for unknown ids', () => {
    const r = new TriggerSourceRegistry()
    expect(r.get('linear-issue')).toBeUndefined()
  })
})
```

**Step 2: Run, expect FAIL** (no `registry.ts`).

**Step 3: Implement**

```ts
import type { TriggerSource } from './types'
import type { TriggerSourceId } from '../../../shared/automations-types'

export class TriggerSourceRegistry {
  private byId = new Map<TriggerSourceId, TriggerSource>()
  register(source: TriggerSource): void {
    if (this.byId.has(source.id)) {
      throw new Error(`Trigger source ${source.id} already registered`)
    }
    this.byId.set(source.id, source)
  }
  get(id: TriggerSourceId): TriggerSource | undefined {
    return this.byId.get(id)
  }
  list(): TriggerSource[] {
    return Array.from(this.byId.values())
  }
}
```

**Step 4: Pass + typecheck**

**Step 5: Commit**

---

## Phase 4 — Rule evaluator (pure)

### Task 4.1: `evalCondition`

**Files:**
- Create: `src/main/automations/rule-evaluator.ts`
- Test: `src/main/automations/rule-evaluator.test.ts`

**Step 1: Test (cover every op)**

```ts
import { describe, it, expect } from 'vitest'
import { evalCondition } from './rule-evaluator'
import type { Condition } from '../../shared/automations-types'

const C = (op: Condition['op'], value: Condition['value']): Condition => ({
  field: 'x', op, value
})

describe('evalCondition', () => {
  it('is / is-not', () => {
    expect(evalCondition(C('is', 'a'), 'a')).toBe(true)
    expect(evalCondition(C('is', 'a'), 'b')).toBe(false)
    expect(evalCondition(C('is-not', 'a'), 'b')).toBe(true)
    expect(evalCondition(C('is', 'a'), undefined)).toBe(false)
  })
  it('is-any-of / is-none-of', () => {
    expect(evalCondition(C('is-any-of', ['a', 'b']), 'a')).toBe(true)
    expect(evalCondition(C('is-any-of', ['a', 'b']), 'c')).toBe(false)
    expect(evalCondition(C('is-any-of', []), 'a')).toBe(false)
    expect(evalCondition(C('is-none-of', ['a', 'b']), 'c')).toBe(true)
  })
  it('contains-any/all/none against array actuals', () => {
    expect(evalCondition(C('contains-any', ['x']), ['a', 'x'])).toBe(true)
    expect(evalCondition(C('contains-any', ['x']), ['a'])).toBe(false)
    expect(evalCondition(C('contains-any', ['x']), undefined)).toBe(false)
    expect(evalCondition(C('contains-all', ['a', 'b']), ['a', 'b', 'c'])).toBe(true)
    expect(evalCondition(C('contains-all', ['a', 'b']), ['a'])).toBe(false)
    expect(evalCondition(C('contains-none', ['x']), ['a', 'b'])).toBe(true)
    expect(evalCondition(C('contains-none', ['x']), ['a', 'x'])).toBe(false)
  })
  it('gte/lte/eq numeric', () => {
    expect(evalCondition(C('gte', 2), 3)).toBe(true)
    expect(evalCondition(C('gte', 2), 1)).toBe(false)
    expect(evalCondition(C('gte', 2), '3')).toBe(false)
    expect(evalCondition(C('lte', 2), 2)).toBe(true)
    expect(evalCondition(C('eq', 0), 0)).toBe(true)
    expect(evalCondition(C('eq', 0), null)).toBe(false)
  })
})
```

**Step 2: FAIL.**

**Step 3: Implement** — see `evalCondition` in the design doc, section "Rule evaluation". Copy verbatim.

**Step 4: PASS.**

**Step 5: Commit**

```bash
git commit -m "auto-triggers: pure evalCondition with full op coverage"
```

---

### Task 4.2: `evaluateRule` + `firstMatch`

**Step 1: Test**

```ts
import { evaluateRule, firstMatch } from './rule-evaluator'
import type { Rule } from '../../shared/automations-types'
import type { CandidateEvent } from './trigger-sources/types'

const ev = (fields: Record<string, unknown>): CandidateEvent => ({
  entityId: 'e', updatedAt: 0, payload: {}, fields
})

describe('evaluateRule', () => {
  it('AND across conditions', () => {
    const r: Rule = {
      id: 'r', projectId: 'p',
      conditions: [
        { field: 'a', op: 'is', value: 1 },
        { field: 'b', op: 'is', value: 2 }
      ]
    }
    expect(evaluateRule(r, ev({ a: 1, b: 2 }))).toBe(true)
    expect(evaluateRule(r, ev({ a: 1, b: 3 }))).toBe(false)
  })
  it('empty conditions always match', () => {
    expect(evaluateRule({ id: 'r', projectId: 'p', conditions: [] }, ev({}))).toBe(true)
  })
})

describe('firstMatch', () => {
  it('returns first matching rule', () => {
    const rules: Rule[] = [
      { id: 'r1', projectId: 'p1', conditions: [{ field: 'a', op: 'is', value: 2 }] },
      { id: 'r2', projectId: 'p2', conditions: [{ field: 'a', op: 'is', value: 1 }] },
      { id: 'r3', projectId: 'p3', conditions: [{ field: 'a', op: 'is', value: 1 }] }
    ]
    expect(firstMatch(rules, ev({ a: 1 }))?.id).toBe('r2')
  })
  it('returns undefined when nothing matches', () => {
    expect(firstMatch([], ev({}))).toBeUndefined()
  })
})
```

**Step 2: FAIL.**

**Step 3: Implement.**

```ts
export function evaluateRule(rule: Rule, event: CandidateEvent): boolean {
  return rule.conditions.every((c) => evalCondition(c, event.fields[c.field]))
}

export function firstMatch(rules: Rule[], event: CandidateEvent): Rule | undefined {
  return rules.find((r) => evaluateRule(r, event))
}
```

**Step 4: PASS.**

**Step 5: Commit.**

---

## Phase 5 — Polling engine

### Task 5.1: Engine skeleton + tick

**Files:**
- Create: `src/main/automations/auto-trigger-engine.ts`
- Test: `src/main/automations/auto-trigger-engine.test.ts`

**Step 1: Test (with a fake source + in-memory dedup + capturing dispatch)**

Sketch:

```ts
describe('AutoTriggerEngine', () => {
  it('dispatches first-match rule for new event', async () => {
    const dispatched: Array<{ automationId: string; ruleId: string; entityId: string }> = []
    const dedup = new Set<string>()
    const fakeSource: TriggerSource = {
      id: 'linear-issue', displayName: 'L', fieldCatalog: [],
      async *poll() {
        yield { entityId: 'ORC-1', updatedAt: 1000, payload: {}, fields: { a: 1 } }
      }
    }
    const automation = makeAutomationWithRule({ field: 'a', op: 'is', value: 1 })
    const engine = new AutoTriggerEngine({
      registry: regWith(fakeSource),
      listAutomations: () => [automation],
      dispatchAutoRun: ({ automation, rule, event }) => {
        dispatched.push({ automationId: automation.id, ruleId: rule.id, entityId: event.entityId })
      },
      dedupHas: (a, t, e) => dedup.has(`${a}|${t}|${e}`),
      dedupInsert: (a, t, e) => dedup.add(`${a}|${t}|${e}`),
      lastPoll: () => 0,
      lastPollSet: () => undefined,
      hostId: 'h1',
      now: () => 2000
    })
    await engine.tick()
    expect(dispatched).toEqual([
      { automationId: automation.id, ruleId: 'rl1', entityId: 'ORC-1' }
    ])
    expect(dedup.has(`${automation.id}|at1|ORC-1`)).toBe(true)
  })

  it('skips dedup-hit events', async () => { /* … */ })
  it('skips events older than enabledAt', async () => { /* … */ })
  it('mutex prevents overlapping ticks', async () => { /* … */ })
  it('catches per-event errors without aborting the loop', async () => { /* … */ })
  it('catches per-source errors without aborting the outer loop', async () => { /* … */ })
})
```

(Write each `it` as its own block; full helpers live in the test file.)

**Step 2: FAIL.**

**Step 3: Implement engine** — match the tick loop pseudocode in the design doc. Key pieces:
- Constructor takes deps (registry, listAutomations, dispatchAutoRun, dedupHas, dedupInsert, lastPoll, lastPollSet, hostId, now).
- `tick()` returns `Promise<void>`; guarded by an in-instance boolean mutex.
- `start(intervalMs)` schedules a `setInterval` calling `void tick()`.
- `stop()` clears the interval.

**Step 4: PASS for each case + `pnpm tc:node`.**

**Step 5: Commit per logical group of tests** (e.g., one commit for the basic dispatch case + happy path tests, a second for error-isolation + mutex). Keep commits small.

---

### Task 5.2: Engine wiring into AutomationService

**Files:**
- Modify: `src/main/automations/service.ts`
- Modify: `src/main/index.ts` (wire registry + engine on startup; pass per-host settings)

**Step 1: Test (service-level)**

In `src/main/automations/service.test.ts`, add a test that constructs an `AutomationService` with a stub engine and asserts that `service.start()` starts the engine and `service.stop()` stops it.

**Step 2: FAIL** (service doesn't know about engine).

**Step 3: Add an optional `autoTriggerEngine` dep to `AutomationServiceOpts` and start/stop it alongside the existing scheduler.**

**Step 4: PASS + typecheck.**

**Step 5: Commit.**

---

## Phase 6 — Linear source

### Task 6.1: Linear field catalog (no `poll` yet)

**Files:**
- Create: `src/main/automations/trigger-sources/linear-issue.ts`
- Test: `src/main/automations/trigger-sources/linear-issue.test.ts`

**Step 1: Test**

```ts
import { linearIssueSource } from './linear-issue'

it('exposes the four field descriptors', () => {
  const fields = linearIssueSource.fieldCatalog.map((d) => d.field)
  expect(fields).toEqual(['linear.assignee', 'linear.tag', 'linear.state', 'linear.priority'])
})

it('priority field allows gte/lte/eq/is-any-of', () => {
  const p = linearIssueSource.fieldCatalog.find((d) => d.field === 'linear.priority')!
  expect(p.ops).toEqual(expect.arrayContaining(['gte', 'lte', 'eq', 'is-any-of']))
})
```

**Step 2: FAIL.**

**Step 3: Implement**, stubbing `poll` as `async function* () {}` and `fetchOptions` returning `[]` for now. Real implementations land in 6.2.

**Step 4: PASS.**

**Step 5: Commit.**

---

### Task 6.2: Linear `poll()` against existing client

**Files:**
- Modify: `src/main/automations/trigger-sources/linear-issue.ts`
- Modify: `src/main/automations/trigger-sources/linear-issue.test.ts`

**Step 1: Test (mock the Linear client)**

```ts
it('maps Linear issues into CandidateEvents with the right field paths', async () => {
  const client = {
    listIssuesUpdatedSince: vi.fn().mockResolvedValue({
      issues: [
        {
          id: 'iss-1', identifier: 'ORC-1', title: 't', description: '', url: 'u',
          updatedAt: 1234, assignee: { email: 'me@x.com' },
          labels: { nodes: [{ name: 'orca' }, { name: 'ai' }] },
          state: { name: 'Todo' }, priority: 2
        }
      ],
      cursor: null
    })
  }
  const source = makeLinearIssueSource({ client })
  const out: CandidateEvent[] = []
  for await (const ev of source.poll({ since: 0, hostId: 'h' })) out.push(ev)
  expect(out[0].entityId).toBe('iss-1')
  expect(out[0].fields['linear.assignee']).toBe('me@x.com')
  expect(out[0].fields['linear.tag']).toEqual(['orca', 'ai'])
  expect(out[0].fields['linear.state']).toBe('Todo')
  expect(out[0].fields['linear.priority']).toBe(2)
})

it('yields zero events when client throws auth error', async () => { /* … */ })

it('paginates via cursor', async () => { /* … */ })
```

**Step 2: FAIL.**

**Step 3: Refactor `linearIssueSource` to be a factory (`makeLinearIssueSource({ client })`) that closes over the client.** Implement `poll` against the existing Linear GraphQL methods. Inspect `src/main/ipc/linear.ts` for the function to call (e.g., `listIssues({ updatedAfter })`).

**Step 4: PASS.**

**Step 5: Commit.**

---

### Task 6.3: Linear `fetchOptions` (labels/states/users)

**Files:**
- Modify: `src/main/automations/trigger-sources/linear-issue.ts`
- Modify: `src/main/automations/trigger-sources/linear-issue.test.ts`

**Step 1: Test**

```ts
it('linear.tag.fetchOptions returns labels from the cached store', async () => {
  const client = { listLabels: vi.fn().mockResolvedValue([{ id: 'l1', name: 'orca' }]) }
  const source = makeLinearIssueSource({ client })
  const opts = await source.fieldCatalog.find((d) => d.field === 'linear.tag')!.fetchOptions!({
    since: 0, hostId: 'h'
  })
  expect(opts).toEqual([{ value: 'orca', label: 'orca' }])
})
```

Add equivalent tests for `linear.state` and `linear.assignee` (with the synthetic `"me"` entry).

**Step 2: FAIL.**

**Step 3: Implement.** For `assignee`, prepend `{ value: 'me', label: 'me' }` plus authenticated user's email.

**Step 4: PASS.**

**Step 5: Commit.**

---

### Task 6.4: Register the Linear source

**Files:**
- Modify: `src/main/index.ts` (or wherever services are constructed)

**Step 1: Test (integration-style)**

Verify in `src/main/automations/service.test.ts` (or a new wiring test) that, after startup, `engine.registry.get('linear-issue')` returns the factory-built source.

**Step 2: FAIL.**

**Step 3: Wire `registry.register(makeLinearIssueSource({ client: linearClient }))` at startup.**

**Step 4: PASS.**

**Step 5: Commit.**

---

## Phase 7 — Auto-run dispatch

### Task 7.1: `dispatchRun` accepts `triggerOverrides`

**Files:**
- Modify: `src/main/automations/service.ts`
- Test: `src/main/automations/service.test.ts`

**Step 1: Test**

Test that calling the (newly factored) `dispatchRun({ automation, payload, triggerOverrides: { kind: 'auto', triggerSource: 'linear-issue', triggerAutoTriggerId: 'at1', triggerRuleId: 'rl1', triggerEntityId: 'ORC-1' } })` results in a `run.trigger === 'auto'` row with those fields populated.

**Step 2: FAIL.**

**Step 3: Refactor `runNow` to delegate its chain-shape path to a new internal `dispatchRun({...})` that accepts the optional `triggerOverrides`. Update `createAutomationRun` (in `persistence.ts`) to accept an optional metadata blob containing the trigger fields.**

**Step 4: PASS.**

**Step 5: Commit.**

---

### Task 7.2: `dispatchAutoRun`

**Files:**
- Modify: `src/main/automations/service.ts`
- Test: `src/main/automations/service.test.ts`

**Step 1: Test**

```ts
it('dispatchAutoRun builds Linear trigger context and uses rule.projectId', async () => {
  // arrange: automation with autoTrigger + rule.projectId = 'p2',
  //         automation.projectId = 'p1' (should be overridden).
  await service.dispatchAutoRun({
    automation, trigger, rule,
    event: {
      entityId: 'iss-1', entityIdentifier: 'ORC-1', updatedAt: 1,
      payload: { issue: { id: 'iss-1', identifier: 'ORC-1', title: 'X', /* … */ } },
      fields: {}
    }
  })
  const run = store.listAutomationRuns().at(-1)
  expect(run?.trigger).toBe('auto')
  expect(run?.triggerEntityId).toBe('iss-1')
  expect(run?.context?.automation?.projectId).toBe('p2')
  expect(run?.context?.trigger?.linear?.issue?.identifier).toBe('ORC-1')
})
```

**Step 2: FAIL.**

**Step 3: Implement** by mapping `event.payload` into `RunNowPayload.linear` shape and calling `dispatchRun` with the rule's `projectId` override.

**Step 4: PASS.**

**Step 5: Commit.**

---

### Task 7.3: Engine → dispatchAutoRun wiring

**Files:**
- Modify: `src/main/automations/auto-trigger-engine.ts`
- Modify: `src/main/index.ts` (pass `service.dispatchAutoRun.bind(service)` into engine ctor)

**Step 1: Test (already present from 5.1) — flip the dispatch fake to assert engine calls the real `dispatchAutoRun` shape.**

**Step 2: PASS** without code changes if the engine takes `dispatchAutoRun` as a dep. Otherwise refactor.

**Step 3: Commit if any change.**

---

## Phase 8 — Restart action

### Task 8.1: `service.restartRun`

**Files:**
- Modify: `src/main/automations/service.ts`
- Test: `src/main/automations/service.test.ts`

**Step 1: Tests** (one `it` per scenario in the design's "Edge cases" list, plus the happy path):

```ts
it('happy path: creates a new run with inherited trigger metadata', async () => { /* … */ })
it('does NOT insert a dedup row on restart', async () => { /* … */ })
it('throws on non-restartable status', async () => { /* … */ })
it('throws when automation has been deleted', async () => { /* … */ })
it('restart of a manual run preserves manual payload', async () => { /* … */ })
it('restart of an auto run preserves triggerSource/triggerAutoTriggerId/triggerEntityId', async () => { /* … */ })
```

**Step 2: FAIL.**

**Step 3: Implement** per design doc's `restartRun` sketch. Define `RESTARTABLE_STATUSES = new Set([...])`.

**Step 4: PASS.**

**Step 5: Commit.**

---

### Task 8.2: IPC `automations:restartRun`

**Files:**
- Modify: `src/main/ipc/automations.ts`
- Modify: `src/preload/index.ts` (and `index.d.ts` if applicable — see CLAUDE.md note)
- Modify: `src/renderer/src/store/slices/automations.ts` (action method)
- Test: `src/main/ipc/automations.test.ts` (if it exists) or extend service tests; renderer store test in `src/renderer/src/store/slices/automation-runs.test.ts`.

**Step 1: Test**

Renderer-side: store action `restartRun(runId)` calls the IPC and updates local state with the new run.

**Step 2: FAIL.**

**Step 3: Wire the IPC handler, preload bridge, and store action.**

**Step 4: PASS + `pnpm tc`.**

**Step 5: Commit.**

---

## Phase 9 — IPC for auto-trigger management

### Task 9.1: `automations:listAutoDedup` / `clearAutoDedup`

**Files:**
- Modify: `src/main/ipc/automations.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/store/slices/automations.ts`
- Test: store-slice test

**Step 1: Test**

```ts
it('listAutoDedup hits the IPC and exposes entries', async () => { /* … */ })
it('clearAutoDedup({automationId, autoTriggerId}) wipes the set', async () => { /* … */ })
it('clearAutoDedup({automationId, autoTriggerId, entityId}) clears one row', async () => { /* … */ })
```

**Step 2: FAIL.**

**Step 3: Add the three IPC channels (`automations:listAutoDedup`, `automations:clearAutoDedup`) and their preload bridges + store actions.**

**Step 4: PASS + `pnpm tc`.**

**Step 5: Commit.**

---

### Task 9.2: Settings IPC for poll interval

**Files:**
- Modify: `src/main/ipc/settings.ts` (or wherever GlobalSettings IPC lives)
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/store/slices/settings.ts`

**Step 1: Test (renderer store)**

```ts
it('automationsPollIntervalSeconds round-trips through the IPC, clamped 15-600', async () => { /* … */ })
```

**Step 2: FAIL.**

**Step 3: Implement getter + setter IPC + store action.**

**Step 4: PASS.**

**Step 5: Commit.**

---

## Phase 10 — Trigger pill label

### Task 10.1: Pill label reflects auto-trigger count

**Files:**
- Modify: `src/renderer/src/components/automations/editor/TriggerPill.tsx`
- Test: `src/renderer/src/components/automations/editor/TriggerPill.test.tsx` (create if missing)

**Step 1: Test** (`renderToStaticMarkup`):

```ts
it('renders "Manual" when no auto triggers', () => {
  const html = renderToStaticMarkup(
    <TriggerPill trigger={{ kind: 'manual' }} autoTriggers={[]} onClick={() => {}} />
  )
  expect(html).toContain('Manual')
})
it('renders "Manual + Linear auto" with one enabled trigger', () => { /* … */ })
it('renders "Manual + N auto triggers" with N>1', () => { /* … */ })
it('disabled auto triggers do not count toward the label', () => { /* … */ })
```

**Step 2: FAIL.**

**Step 3: Extend `TriggerPillProps` to accept `autoTriggers: AutoTrigger[]`; compute the label.**

**Step 4: PASS + `pnpm tc:web`.**

**Step 5: Commit.**

---

## Phase 11 — Triggers sub-modal scaffolding

### Task 11.1: Sub-modal container

**Files:**
- Create: `src/renderer/src/components/automations/editor/TriggersModal.tsx`
- Test: `src/renderer/src/components/automations/editor/TriggersModal.test.tsx`

**Step 1: Test**

```ts
it('renders Manual section with the three checkboxes', () => { /* … */ })
it('renders Automatic section with an Add dropdown', () => { /* … */ })
it('Save is disabled until validation passes', () => { /* … */ })
```

**Step 2: FAIL.**

**Step 3: Build the sub-modal scaffolding using the existing shadcn Dialog primitive (see existing `ChainEditorModal` for prior art). No auto-trigger card yet — just the Manual section and the empty Automatic section with the `Add ▾` dropdown reading from a stubbed registry list.**

**Step 4: PASS + `pnpm tc:web`.**

**Step 5: Commit.**

---

### Task 11.2: Open sub-modal from the pill

**Files:**
- Modify: `src/renderer/src/components/automations/editor/ChainEditorModal.tsx`

**Step 1: Test (e2e-ish via existing `ChainEditorModal.e2e.test.tsx`)**

Add a test that clicking the trigger pill opens the new `TriggersModal`.

**Step 2: FAIL.**

**Step 3: Wire onClick → open the sub-modal; pass `trigger`, `autoTriggers`, `onSave` (mutating draft state).**

**Step 4: PASS + `pnpm tc:web`.**

**Step 5: Commit.**

---

## Phase 12 — Auto-trigger card

### Task 12.1: Auto-trigger card (no condition rows yet)

**Files:**
- Create: `src/renderer/src/components/automations/editor/AutoTriggerCard.tsx`
- Test: `src/renderer/src/components/automations/editor/AutoTriggerCard.test.tsx`

**Step 1: Test**

```ts
it('renders source label and enable toggle', () => { /* … */ })
it('clicking Add rule appends a rule with conditions: []', () => { /* … */ })
it('clicking delete on a rule removes it', () => { /* … */ })
it('drag-reorder reorders rules but not condition order', () => { /* … */ })
```

**Step 2: FAIL.**

**Step 3: Build the card.** Uses `ProjectPicker` for the per-rule project; renders rule list with a placeholder for `<ConditionList>` (next task).

**Step 4: PASS + `pnpm tc:web`.**

**Step 5: Commit.**

---

## Phase 13 — Generic condition editor

### Task 13.1: Condition row

**Files:**
- Create: `src/renderer/src/components/automations/editor/ConditionRow.tsx`
- Test: `src/renderer/src/components/automations/editor/ConditionRow.test.tsx`

**Step 1: Test**

```ts
it('Field select lists every catalog entry', () => { /* … */ })
it('Op select lists only ops allowed by the chosen field', () => { /* … */ })
it('Changing field resets op + value when current op is not allowed on new field', () => { /* … */ })
it('Value editor switches by valueKind', () => { /* … */ })
```

**Step 2: FAIL.**

**Step 3: Implement.** Drive selects from a `fieldCatalog: FieldDescriptor[]` prop. For value editors, dispatch on `valueKind` to one of: `<UserPicker>`, `<LabelMultiSelect>`, `<StateMultiSelect>`, `<PriorityPicker>`, `<Input>`. Each receives an `optionsLoader: () => Promise<Option[]>` for the data-driven ones.

**Step 4: PASS + `pnpm tc:web`.**

**Step 5: Commit.**

---

### Task 13.2: Wire `fieldCatalog` from the registry into the editor

**Files:**
- Modify: `src/renderer/src/components/automations/editor/AutoTriggerCard.tsx`
- Create: `src/renderer/src/lib/trigger-source-catalog.ts` (renderer-side mirror of the registry: serialized descriptors come over IPC since `fetchOptions` runs in main)

**Step 1: Test**

```ts
it('AutoTriggerCard fetches the fieldCatalog for its source and passes it to ConditionRow', () => { /* … */ })
it('fetchOptions errors render as empty selects with a small "couldn\'t load" hint', () => { /* … */ })
```

**Step 2: FAIL.**

**Step 3: Add IPC `triggerSources:list` that returns `Array<{ id, displayName, fieldCatalog }>` (descriptors only — no `fetchOptions`). Add IPC `triggerSources:fetchOptions(sourceId, field)` to call the descriptor's `fetchOptions` in main. Renderer caches by `(sourceId, field)` for the modal lifetime; the modal subscribes on open.**

**Step 4: PASS + `pnpm tc`.**

**Step 5: Commit.**

---

## Phase 14 — Dedup management UI

### Task 14.1: "Fired for N issues" card footer

**Files:**
- Modify: `src/renderer/src/components/automations/editor/AutoTriggerCard.tsx`
- Create: `src/renderer/src/components/automations/editor/DedupListPopover.tsx`

**Step 1: Test**

```ts
it('renders "Fired for N issues" with N from the store', () => { /* … */ })
it('Clear all calls clearAutoDedup with no entityId', () => { /* … */ })
it('Per-row Clear calls clearAutoDedup with that entityId', () => { /* … */ })
```

**Step 2: FAIL.**

**Step 3: Build the popover.** Wire to `store.automations.listAutoDedup({automationId, autoTriggerId})`.

**Step 4: PASS + `pnpm tc:web`.**

**Step 5: Commit.**

---

## Phase 15 — Run detail enhancements

### Task 15.1: Trigger badge in run header

**Files:**
- Modify: `src/renderer/src/components/automations/AutomationDetail.tsx` (or wherever the run header lives)
- Test: the corresponding `.test.tsx`

**Step 1: Test**

```ts
it('shows "Auto: Linear issue • Rule 2 (mobile-app)" when run is auto-triggered', () => { /* … */ })
it('shows "Manual" when run is manually triggered', () => { /* … */ })
it('shows "Scheduled" when run is scheduled', () => { /* … */ })
```

**Step 2: FAIL.**

**Step 3: Implement.** Resolve `triggerRuleId` → rule index via the parent automation; rule project name from the repo store.

**Step 4: PASS + `pnpm tc:web`.**

**Step 5: Commit.**

---

### Task 15.2: Restart button + lineage links

**Files:**
- Modify: `src/renderer/src/components/automations/AutomationDetail.tsx`

**Step 1: Test**

```ts
it('Restart button visible for failed/dispatch_failed/cancelled/skipped_* statuses', () => { /* … */ })
it('Restart button hidden for pending/running/completed/dispatching/dispatched', () => { /* … */ })
it('clicking Restart calls store.restartRun(runId) and navigates to the new run', () => { /* … */ })
it('renders "Restarted from #X" when restartedFromRunId is set', () => { /* … */ })
it('renders "Restarted as #Y" on the prior run when a newer run references it', () => { /* … */ })
```

**Step 2: FAIL.**

**Step 3: Implement.** Button uses the existing button primitive. The "Restarted as" link is computed by scanning sibling runs for `restartedFromRunId === currentRunId`.

**Step 4: PASS + `pnpm tc:web`.**

**Step 5: Commit.**

---

## Phase 16 — Settings page

### Task 16.1: Poll interval field

**Files:**
- Modify: settings panel component (find via `grep -rn 'Settings' src/renderer/src/components | head`)
- Test: corresponding `.test.tsx`

**Step 1: Test**

```ts
it('renders the Linear poll interval field with current value', () => { /* … */ })
it('clamps to 15–600 on save', () => { /* … */ })
it('shows "Linear not connected — auto triggers paused" banner when applicable', () => { /* … */ })
```

**Step 2: FAIL.**

**Step 3: Implement the field + banner.**

**Step 4: PASS + `pnpm tc:web`.**

**Step 5: Commit.**

---

## Phase 17 — Integration tests + polish

### Task 17.1: End-to-end auto-fire integration test

**Files:**
- Create: `src/main/automations/auto-trigger-engine.e2e.test.ts`

**Step 1: Test**

Spin up a real `Store` (in-memory), a real `AutomationService`, a fake Linear client that yields one matching issue, and the real engine. Tick once. Assert:

- One `AutomationRun` exists with `trigger: 'auto'`, the right `triggerEntityId`, and a `context.trigger.linear.issue.title` that resolves in a templated step.
- One dedup row exists.
- A second tick does not produce a second run.

**Step 2: FAIL.**

**Step 3: Iterate on engine/source until green.**

**Step 4: PASS.**

**Step 5: Commit.**

---

### Task 17.2: Concurrent dedup test

```ts
it('two concurrent ticks racing on the same entity insert exactly one run', async () => { /* … */ })
```

Wire the engine with a slow `dispatchAutoRun` that yields control before completing. Start two ticks via `Promise.all([engine.tick(), engine.tick()])`. Assert one run; one dedup row. (Note: the mutex makes the second `tick()` skip — verify that behavior, don't fight it.)

**Commit.**

---

### Task 17.3: Restart-of-auto preserves metadata, no new dedup row

```ts
it('restarting an auto-fired run preserves triggerSource/AutoTriggerId/EntityId and does NOT add a dedup row', async () => { /* … */ })
```

**Commit.**

---

### Task 17.4: Final docs + typecheck pass

**Files:**
- Modify: `docs/plans/2026-05-22-auto-triggers.md` (this file) — append a "Status: complete" note at the top.
- Run: `pnpm tc` (all three projects).
- Run: `pnpm vitest run` (full suite).

**Commit.**

---

## Verification checklist (run before declaring done)

- [ ] `pnpm tc` clean across node + cli + web.
- [ ] `pnpm vitest run` green.
- [ ] Manual smoke (via `/run` skill): start the app, create an automation with one rule (assignee=me, tag=test-orca-auto, project=any), assign a Linear ticket to yourself with the tag, observe a run appears within poll interval. Restart the run; observe a new run.
- [ ] Polling stops cleanly when the user disables a trigger.
- [ ] Disabling Linear auth surfaces the "Linear not connected" banner.
- [ ] Settings page poll interval saves and is picked up on next tick (no app restart required).

## Risks reminder

See the corresponding section of the design doc (`docs/plans/2026-05-22-auto-triggers-design.md`). The two most likely sources of subtle bugs during implementation: (a) clock skew around the `since`/`enabledAt` watermarks (use `gte`, not `gt`), and (b) the dedup-before-dispatch ordering — make sure tests exercise the crash-mid-dispatch scenario.

**Known limitation (v1):** the synthetic "me" assignee entry in the Linear source resolves to the current viewer's user id **at editor-pick time**, not at evaluation time. A user who later switches Linear accounts will still see the prior viewer's id baked into the saved rule and must re-save the rule for "me" to track the new account. The design intent is "me follows the active account at evaluation time"; a follow-up will introduce a sentinel-based eval-time resolver.
