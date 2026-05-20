# Automations Chain Engine — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Generalize Orca's Automations from "one prompt on a schedule" to a chain executor that runs ordered steps in response to a trigger. Ship the foundation (Phase 1) first; subsequent phases are scoped but not yet TDD-detailed.

**Architecture:** Extend the existing `Automation` model with `trigger: TriggerConfig` and `steps: Step[]`. A chain executor lives in `AutomationService` (main process), driven by the existing 60-second tick. Each `Step` has a `kind` literal and a `StepRunner` implementation. The `run-prompt` runner consumes the existing `agentStatusByPaneKey` lifecycle the sidebar dot already reads. Linear-chain only — no DAG, no branching, no manual gates in v1.

**Tech Stack:** Electron main process (TypeScript), zustand renderer store, vitest, JSON persistence (`orca-data.json`), agent hook services (`src/main/<agent>/hook-service.ts`).

**Design doc:** `docs/plans/2026-05-19-automations-chain-engine-design.md`

---

## Phasing

| Phase | Scope | Plan detail |
| --- | --- | --- |
| **1. Foundation (this plan)** | Data model migration, template resolver, chain executor, `run-prompt` step kind, manual trigger only, minimal run viewer in existing UI | **TDD-detailed below** |
| 2. Step palette expansion | Add `create-worktree`, `wait-for-setup`, `run-command` step kinds | Outline only |
| 3. Schedule trigger (extended) | Reuse existing scheduler; fire chain runs instead of single dispatches | Outline only |
| 4. Linear trigger + Hookdeck | New `LinearTrigger` module + local HTTP receiver + `hookdeck listen` child-process supervisor | Outline only |
| 5. Chain editor UI | Replace `AutomationEditorDialog` with the full-screen vertical card editor | Outline only |
| 6. Run viewer UI | Per-step execution state, deep-link into captured `paneKey`, stdout/stderr tails | Outline only |
| 7. Variable picker | `{{` autocomplete popover with type-hinted suggestions | Outline only |

Re-plan Phases 2+ after Phase 1 lands and we've learned how the executor feels in practice.

---

## Pre-task: Research checkpoints

Before Task 1, verify these assumptions hold. If any are wrong, stop and reconcile before writing code.

**R1.** Confirm `agentStatusByPaneKey` is written from main-process hook services (`src/main/claude/hook-service.ts`, `codex`, `droid`) and exposed to the renderer store. We need a main-process getter to read it from the executor.

Run: `grep -rn "agentStatusByPaneKey" src/main src/preload --include="*.ts" | grep -v test`
Expected: at least one writer in `src/main/*/hook-service.ts`; if all access is renderer-side, Task 6 needs to add a main-process source-of-truth shim.

**R2.** Confirm the current dispatch IPC channel `automations:dispatchRequested` is the only main→renderer message used by automations today, and that the renderer-side handler creates a workspace + opens a tab + sends a prompt.

Run: `grep -rn "automations:dispatchRequested\|dispatchRequested" src --include="*.ts" --include="*.tsx"`
Expected: a single send-site (`src/main/automations/service.ts:128`) and a renderer-side handler. The renderer-side handler is where we'll add the response path (it must return the `paneKey` it created).

**R3.** Confirm the persistence file (`orca-data.json`) is loaded once at startup and held in memory — no incremental migrations needed on disk.

Run: `grep -n "loadState\|writeState\|persist" src/main/persistence.ts | head -20`
Expected: a single `loadState` on construction, a `writeStateDebounced` on mutation. Migration-on-read is fine; no DB schema to alter.

If R1, R2, or R3 fail, pause and re-scope.

---

## Phase 1 — Foundation

### Task 1: Add chain-shaped types alongside the legacy ones

**Files:**
- Modify: `src/shared/automations-types.ts`

**Goal:** New types live next to the existing ones. No existing field is dropped; new fields are optional on `Automation` and `AutomationRun` so legacy rows continue to type-check.

**Step 1: Write the failing test**

Create `src/shared/automations-types.test.ts`:

```ts
import { describe, it, expectTypeOf } from 'vitest'
import type {
  Automation,
  TriggerConfig,
  Step,
  StepKind,
  StepRunState,
  RunPromptConfig
} from './automations-types'

describe('chain types', () => {
  it('Automation carries trigger + steps optionally for migration', () => {
    expectTypeOf<Automation['trigger']>().toEqualTypeOf<TriggerConfig | undefined>()
    expectTypeOf<Automation['steps']>().toEqualTypeOf<Step[] | undefined>()
  })

  it('TriggerConfig has a manual variant in Phase 1', () => {
    const t: TriggerConfig = { kind: 'manual' }
    expectTypeOf(t).toMatchTypeOf<TriggerConfig>()
  })

  it('Step carries id, kind, config, onFailure, timeoutSeconds', () => {
    expectTypeOf<Step['id']>().toEqualTypeOf<string>()
    expectTypeOf<Step['kind']>().toEqualTypeOf<StepKind>()
    expectTypeOf<Step['onFailure']>().toEqualTypeOf<'halt' | 'continue'>()
    expectTypeOf<Step['timeoutSeconds']>().toEqualTypeOf<number | null>()
  })

  it('RunPromptConfig matches the design doc shape', () => {
    expectTypeOf<RunPromptConfig['worktreeRef']>().toEqualTypeOf<string>()
    expectTypeOf<RunPromptConfig['prompt']>().toEqualTypeOf<string>()
    expectTypeOf<RunPromptConfig['doneDebounceSeconds']>().toEqualTypeOf<number>()
  })

  it('StepRunState records status + timing + output + error', () => {
    expectTypeOf<StepRunState['status']>().toEqualTypeOf<
      'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'timed-out'
    >()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run --config config/vitest.config.ts src/shared/automations-types.test.ts`
Expected: FAIL — `TriggerConfig`, `Step`, `StepKind`, `StepRunState`, `RunPromptConfig` are not exported.

**Step 3: Add types to `automations-types.ts`**

Append to the bottom of `src/shared/automations-types.ts`:

```ts
// ── Chain engine (Phase 1) ───────────────────────────────────────────

export type TriggerConfig = { kind: 'manual' }
// Phase 3 adds: | { kind: 'schedule'; rrule, dtstart, timezone, missedRunGraceMinutes }
// Phase 4 adds: | { kind: 'linear'; teamId, eventTypes, filters }

export type StepKind = 'run-prompt'
// Phase 2 adds: 'create-worktree' | 'wait-for-setup' | 'run-command'

export type RunPromptConfig = {
  worktreeRef: string                // template, e.g. '{{automation.workspaceId}}'
  agentId: TuiAgent
  prompt: string                     // template
  doneDebounceSeconds: number        // default 15
}

export type StepConfig = RunPromptConfig
// Future kinds union additional configs here.

export type Step = {
  id: string
  kind: StepKind
  config: StepConfig
  onFailure: 'halt' | 'continue'
  timeoutSeconds: number | null
}

export type StepRunStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'timed-out'

export type StepRunState = {
  stepId: string
  status: StepRunStatus
  startedAt: number | null
  finishedAt: number | null
  output: unknown                    // shape depends on kind; documented per-runner
  error: string | null
}
```

Then modify the existing `Automation` and `AutomationRun` types to add the optional fields:

```ts
export type Automation = {
  // ...existing fields unchanged...
  // ── Phase 1 additions (optional during migration) ──
  trigger?: TriggerConfig
  steps?: Step[]
  haltOnFailure?: boolean
  maxConcurrentRuns?: number
  deduplicationKey?: string | null
}

export type AutomationRun = {
  // ...existing fields unchanged...
  // ── Phase 1 additions (optional during migration) ──
  stepStates?: StepRunState[]
  context?: Record<string, unknown>
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run --config config/vitest.config.ts src/shared/automations-types.test.ts`
Expected: PASS.

Also run typecheck across all projects:

Run: `pnpm tc`
Expected: PASS — no regressions in legacy callers since new fields are optional.

**Step 5: Commit**

```bash
git add src/shared/automations-types.ts src/shared/automations-types.test.ts
git commit -m "feat(automations): add chain-shape types alongside legacy fields"
```

---

### Task 2: Template variable resolver (pure function)

**Files:**
- Create: `src/main/automations/template.ts`
- Create: `src/main/automations/template.test.ts`

**Goal:** Resolve `{{path.to.value}}` against a context object. Strings only. Unresolved references throw with a clear message.

**Step 1: Write the failing test**

Create `src/main/automations/template.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveTemplate, TemplateResolutionError } from './template'

describe('resolveTemplate', () => {
  it('returns the input when no template tokens are present', () => {
    expect(resolveTemplate('hello world', {})).toBe('hello world')
  })

  it('substitutes a single token', () => {
    expect(resolveTemplate('hi {{name}}', { name: 'Mike' })).toBe('hi Mike')
  })

  it('substitutes nested paths', () => {
    expect(
      resolveTemplate('{{trigger.linear.issue.title}}', {
        trigger: { linear: { issue: { title: 'Fix X' } } }
      })
    ).toBe('Fix X')
  })

  it('coerces numbers and booleans to strings', () => {
    expect(resolveTemplate('{{n}} {{b}}', { n: 42, b: true })).toBe('42 true')
  })

  it('throws with the failing path for unresolved references', () => {
    expect(() => resolveTemplate('{{a.b.c}}', { a: { b: {} } })).toThrow(
      TemplateResolutionError
    )
    expect(() => resolveTemplate('{{a.b.c}}', { a: { b: {} } })).toThrow(/a\.b\.c/)
  })

  it('preserves whitespace and surrounding text', () => {
    expect(resolveTemplate('  {{x}}  ', { x: 'y' })).toBe('  y  ')
  })

  it('allows escaping with a doubled brace (literal {{)', () => {
    expect(resolveTemplate('use \\{{literal}} for braces', {})).toBe(
      'use {{literal}} for braces'
    )
  })

  it('rejects null/undefined values as unresolved', () => {
    expect(() => resolveTemplate('{{x}}', { x: null })).toThrow(TemplateResolutionError)
    expect(() => resolveTemplate('{{x}}', { x: undefined })).toThrow(TemplateResolutionError)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run --config config/vitest.config.ts src/main/automations/template.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement the resolver**

Create `src/main/automations/template.ts`:

```ts
export class TemplateResolutionError extends Error {
  constructor(
    message: string,
    public readonly path: string
  ) {
    super(message)
    this.name = 'TemplateResolutionError'
  }
}

const TOKEN = /\\\{\{|\{\{([^}]+)\}\}/g

export function resolveTemplate(input: string, context: Record<string, unknown>): string {
  return input.replace(TOKEN, (match, path: string | undefined) => {
    if (match === '\\{{') {
      return '{{'
    }
    const trimmed = (path ?? '').trim()
    const value = lookup(context, trimmed)
    if (value === undefined || value === null) {
      throw new TemplateResolutionError(
        `Template references unresolved path '${trimmed}'.`,
        trimmed
      )
    }
    return String(value)
  })
}

function lookup(ctx: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let cursor: unknown = ctx
  for (const part of parts) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') {
      return undefined
    }
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run --config config/vitest.config.ts src/main/automations/template.test.ts`
Expected: PASS, all 8 cases.

**Step 5: Commit**

```bash
git add src/main/automations/template.ts src/main/automations/template.test.ts
git commit -m "feat(automations): template variable resolver"
```

---

### Task 3: Step runner interface + RunPromptRunner skeleton

**Files:**
- Create: `src/main/automations/step-runner.ts` (interface)
- Create: `src/main/automations/runners/run-prompt-runner.ts` (skeleton)
- Create: `src/main/automations/runners/run-prompt-runner.test.ts`

**Goal:** Define the contract every step runner must satisfy, and a skeleton `RunPromptRunner` that we'll fill out as we add the other Tasks. This task only locks down the interface; the actual agent-status polling lands in Task 6.

**Step 1: Write the failing interface test**

Create `src/main/automations/runners/run-prompt-runner.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import type { Step, StepRunState } from '../../../shared/automations-types'
import { RunPromptRunner } from './run-prompt-runner'
import type { StepRunnerCtx } from '../step-runner'

const baseStep: Step = {
  id: 'send-prompt',
  kind: 'run-prompt',
  config: {
    worktreeRef: 'wt-123',
    agentId: 'claude',
    prompt: 'Hello',
    doneDebounceSeconds: 15
  },
  onFailure: 'halt',
  timeoutSeconds: null
}

const baseState: StepRunState = {
  stepId: 'send-prompt',
  status: 'pending',
  startedAt: null,
  finishedAt: null,
  output: null,
  error: null
}

describe('RunPromptRunner', () => {
  it('returns "needs-more-time" when first ticked (no pane key yet)', async () => {
    const runner = new RunPromptRunner({
      openPromptPane: vi.fn().mockResolvedValue({ paneKey: 'tab-1:pane-1' }),
      getAgentStatus: vi.fn().mockReturnValue(undefined),
      now: () => 0
    })
    const ctx: StepRunnerCtx = { runId: 'r1', step: baseStep, state: baseState, context: {} }
    const next = await runner.tick(ctx)
    expect(next.status).toBe('running')
    expect(next.outcome).toBe('needs-more-time')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run --config config/vitest.config.ts src/main/automations/runners/run-prompt-runner.test.ts`
Expected: FAIL — modules not found.

**Step 3: Define the interface**

Create `src/main/automations/step-runner.ts`:

```ts
import type { Step, StepRunState } from '../../shared/automations-types'

export type StepRunnerCtx = {
  runId: string
  step: Step
  state: StepRunState
  context: Record<string, unknown>
}

export type StepRunnerOutcome = 'done' | 'failed' | 'needs-more-time'

export type StepRunnerResult = {
  outcome: StepRunnerOutcome
  status: StepRunState['status']
  output?: unknown
  error?: string | null
  contextPatch?: Record<string, unknown>     // merged into AutomationRun.context on success
}

export interface StepRunner {
  tick(ctx: StepRunnerCtx): Promise<StepRunnerResult>
}
```

Create `src/main/automations/runners/run-prompt-runner.ts`:

```ts
import type { StepRunner, StepRunnerCtx, StepRunnerResult } from '../step-runner'
import type { RunPromptConfig } from '../../../shared/automations-types'
import { resolveTemplate } from '../template'

export type AgentStatusEntry = { state: 'done' | 'working' | 'blocked' | 'waiting'; updatedAt: number }

export type RunPromptDeps = {
  openPromptPane: (params: {
    worktreeId: string
    agentId: string
    prompt: string
  }) => Promise<{ paneKey: string }>
  getAgentStatus: (paneKey: string) => AgentStatusEntry | undefined
  now: () => number
}

type PaneKeyTracker = Map<string, { paneKey: string; firstDoneAt: number | null }>

export class RunPromptRunner implements StepRunner {
  private readonly trackers: PaneKeyTracker = new Map()

  constructor(private readonly deps: RunPromptDeps) {}

  async tick(ctx: StepRunnerCtx): Promise<StepRunnerResult> {
    const config = ctx.step.config as RunPromptConfig
    let tracker = this.trackers.get(ctx.runId + ':' + ctx.step.id)
    if (!tracker) {
      const worktreeId = resolveTemplate(config.worktreeRef, ctx.context)
      const prompt = resolveTemplate(config.prompt, ctx.context)
      const { paneKey } = await this.deps.openPromptPane({
        worktreeId,
        agentId: config.agentId,
        prompt
      })
      tracker = { paneKey, firstDoneAt: null }
      this.trackers.set(ctx.runId + ':' + ctx.step.id, tracker)
      return { outcome: 'needs-more-time', status: 'running' }
    }
    // Status polling lands in Task 6.
    return { outcome: 'needs-more-time', status: 'running' }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run --config config/vitest.config.ts src/main/automations/runners/run-prompt-runner.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/main/automations/step-runner.ts src/main/automations/runners/
git commit -m "feat(automations): StepRunner interface + RunPromptRunner skeleton"
```

---

### Task 4: Persistence migration (read-side upgrade)

**Files:**
- Modify: `src/main/persistence.ts`
- Create: `src/main/persistence-automation-migration.ts` (pure function for unit testing)
- Create: `src/main/persistence-automation-migration.test.ts`

**Goal:** On load, upgrade any legacy automation (one with `rrule`/`prompt` but no `trigger`/`steps`) into the new shape. No disk migration; just transform-on-read. Writes are always in the new shape.

**Step 1: Write the failing test**

Create `src/main/persistence-automation-migration.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { upgradeLegacyAutomation } from './persistence-automation-migration'
import type { Automation } from '../shared/automations-types'

describe('upgradeLegacyAutomation', () => {
  it('returns the input unchanged when trigger + steps are already set', () => {
    const a: Automation = {
      id: 'a1',
      name: 'Already migrated',
      prompt: '',
      agentId: 'claude',
      projectId: 'p',
      executionTargetType: 'local',
      executionTargetId: 'local',
      schedulerOwner: 'local_host_service',
      workspaceMode: 'existing',
      workspaceId: 'ws-1',
      baseBranch: null,
      timezone: 'UTC',
      rrule: '',
      dtstart: 0,
      enabled: true,
      nextRunAt: 0,
      missedRunPolicy: 'run_once_within_grace',
      missedRunGraceMinutes: 30,
      createdAt: 0,
      updatedAt: 0,
      trigger: { kind: 'manual' },
      steps: [
        {
          id: 's1',
          kind: 'run-prompt',
          config: {
            worktreeRef: 'ws-1',
            agentId: 'claude',
            prompt: '',
            doneDebounceSeconds: 15
          },
          onFailure: 'halt',
          timeoutSeconds: null
        }
      ]
    }
    expect(upgradeLegacyAutomation(a)).toBe(a)
  })

  it('upgrades a legacy schedule-driven automation into trigger + one run-prompt step', () => {
    const legacy: Automation = {
      id: 'a2',
      name: 'Legacy',
      prompt: 'Do thing',
      agentId: 'claude',
      projectId: 'p',
      executionTargetType: 'local',
      executionTargetId: 'local',
      schedulerOwner: 'local_host_service',
      workspaceMode: 'existing',
      workspaceId: 'ws-7',
      baseBranch: null,
      timezone: 'UTC',
      rrule: 'FREQ=DAILY',
      dtstart: 1700000000,
      enabled: true,
      nextRunAt: 0,
      missedRunPolicy: 'run_once_within_grace',
      missedRunGraceMinutes: 30,
      createdAt: 0,
      updatedAt: 0
    }
    const upgraded = upgradeLegacyAutomation(legacy)
    // Trigger is 'manual' in Phase 1 (schedule trigger lands in Phase 3 — until then,
    // legacy schedule fields stay on the row but are not the source of truth).
    expect(upgraded.trigger).toEqual({ kind: 'manual' })
    expect(upgraded.steps).toEqual([
      {
        id: expect.any(String),
        kind: 'run-prompt',
        config: {
          worktreeRef: 'ws-7',
          agentId: 'claude',
          prompt: 'Do thing',
          doneDebounceSeconds: 15
        },
        onFailure: 'halt',
        timeoutSeconds: null
      }
    ])
  })

  it('handles workspaceMode = new_per_run by leaving worktreeRef as a placeholder', () => {
    // In Phase 1 we have no create-worktree step yet, so legacy new_per_run rows
    // become single-step chains with a placeholder ref. Phase 2 will reshape them
    // by prepending a real create-worktree step.
    const legacy: Automation = {
      id: 'a3',
      name: 'Legacy new-per-run',
      prompt: 'Do thing',
      agentId: 'claude',
      projectId: 'p',
      executionTargetType: 'local',
      executionTargetId: 'local',
      schedulerOwner: 'local_host_service',
      workspaceMode: 'new_per_run',
      workspaceId: null,
      baseBranch: 'main',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY',
      dtstart: 1700000000,
      enabled: true,
      nextRunAt: 0,
      missedRunPolicy: 'run_once_within_grace',
      missedRunGraceMinutes: 30,
      createdAt: 0,
      updatedAt: 0
    }
    const upgraded = upgradeLegacyAutomation(legacy)
    expect(upgraded.steps?.[0].config).toMatchObject({
      worktreeRef: '{{automation.workspaceId}}'
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run --config config/vitest.config.ts src/main/persistence-automation-migration.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement the migration helper**

Create `src/main/persistence-automation-migration.ts`:

```ts
import { randomUUID } from 'crypto'
import type { Automation, Step, RunPromptConfig } from '../shared/automations-types'

export function upgradeLegacyAutomation(automation: Automation): Automation {
  if (automation.trigger && automation.steps) {
    return automation
  }
  const stepConfig: RunPromptConfig = {
    worktreeRef:
      automation.workspaceMode === 'new_per_run'
        ? '{{automation.workspaceId}}'
        : (automation.workspaceId ?? '{{automation.workspaceId}}'),
    agentId: automation.agentId,
    prompt: automation.prompt,
    doneDebounceSeconds: 15
  }
  const step: Step = {
    id: randomUUID(),
    kind: 'run-prompt',
    config: stepConfig,
    onFailure: 'halt',
    timeoutSeconds: null
  }
  return {
    ...automation,
    trigger: { kind: 'manual' },
    steps: [step]
  }
}
```

**Step 4: Wire the helper into the persistence loader**

In `src/main/persistence.ts`, find the loader that reads `parsed.automations` (around line 420). Map over the array with `upgradeLegacyAutomation`:

```ts
automations: Array.isArray(parsed.automations)
  ? parsed.automations.map(upgradeLegacyAutomation)
  : [],
```

Add the import at the top of `persistence.ts`:

```ts
import { upgradeLegacyAutomation } from './persistence-automation-migration'
```

**Step 5: Run tests + typecheck**

Run: `pnpm vitest run --config config/vitest.config.ts src/main/persistence-automation-migration.test.ts`
Expected: PASS, all 3 cases.

Run: `pnpm vitest run --config config/vitest.config.ts src/main/persistence.test.ts` (existing tests must still pass)
Expected: PASS.

Run: `pnpm tc:node`
Expected: PASS.

**Step 6: Commit**

```bash
git add src/main/persistence-automation-migration.ts src/main/persistence-automation-migration.test.ts src/main/persistence.ts
git commit -m "feat(automations): upgrade legacy automations to chain shape on read"
```

---

### Task 5: Renderer IPC — open prompt pane and return the paneKey

**Files:**
- Modify: `src/main/automations/service.ts` (will own the IPC roundtrip)
- Modify: existing renderer dispatch handler (find via R2)
- Create: `src/main/automations/open-prompt-pane.ts` (small helper)
- Create: `src/main/automations/open-prompt-pane.test.ts`

**Goal:** Replace the fire-and-forget `automations:dispatchRequested` model with a request/response so the main-process executor knows the `paneKey` it should watch.

**Step 1 (research):** Locate the renderer handler that responds to `automations:dispatchRequested`. Grep for the channel name. Read the handler. Identify the renderer-side function that actually creates the tab and sends the prompt.

Run: `grep -rn "automations:dispatchRequested\|dispatchRequested" src/renderer src/preload --include="*.ts" --include="*.tsx"`

**Step 2: Write the failing test**

Create `src/main/automations/open-prompt-pane.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { openPromptPane } from './open-prompt-pane'

describe('openPromptPane', () => {
  it('sends an IPC request and resolves with the renderer-returned paneKey', async () => {
    const webContents = {
      isDestroyed: () => false,
      send: vi.fn(),
      ipc: undefined
    }
    const ipc = {
      handleOnce: vi.fn((channel, handler) => {
        setTimeout(() => handler({ paneKey: 'tab-9:pane-2' }), 0)
      })
    }
    const result = await openPromptPane(
      { worktreeId: 'wt-1', agentId: 'claude', prompt: 'go' },
      { webContents: webContents as never, ipc: ipc as never, requestId: 'req-1' }
    )
    expect(result).toEqual({ paneKey: 'tab-9:pane-2' })
    expect(webContents.send).toHaveBeenCalledWith(
      'automations:openPromptPane',
      expect.objectContaining({ requestId: 'req-1', worktreeId: 'wt-1', prompt: 'go' })
    )
  })

  it('rejects when the renderer is gone', async () => {
    const webContents = { isDestroyed: () => true, send: vi.fn() }
    await expect(
      openPromptPane(
        { worktreeId: 'wt-1', agentId: 'claude', prompt: 'go' },
        { webContents: webContents as never, ipc: {} as never, requestId: 'r' }
      )
    ).rejects.toThrow(/no renderer/i)
  })
})
```

**Step 3: Run test to verify it fails**

Run: `pnpm vitest run --config config/vitest.config.ts src/main/automations/open-prompt-pane.test.ts`
Expected: FAIL.

**Step 4: Implement**

Create `src/main/automations/open-prompt-pane.ts`:

```ts
import type { IpcMain, WebContents } from 'electron'

export type OpenPromptPaneRequest = {
  worktreeId: string
  agentId: string
  prompt: string
}

export type OpenPromptPaneResult = { paneKey: string }

export async function openPromptPane(
  req: OpenPromptPaneRequest,
  deps: { webContents: WebContents; ipc: IpcMain; requestId: string }
): Promise<OpenPromptPaneResult> {
  if (!deps.webContents || deps.webContents.isDestroyed()) {
    throw new Error('No renderer available to open prompt pane.')
  }
  return new Promise<OpenPromptPaneResult>((resolve, reject) => {
    const channel = `automations:openPromptPane:reply:${deps.requestId}`
    const timeout = setTimeout(() => {
      deps.ipc.removeAllListeners(channel)
      reject(new Error('Renderer did not respond to openPromptPane within 30s.'))
    }, 30_000)
    deps.ipc.handleOnce(channel, (_evt, payload: OpenPromptPaneResult) => {
      clearTimeout(timeout)
      resolve(payload)
    })
    deps.webContents.send('automations:openPromptPane', { requestId: deps.requestId, ...req })
  })
}
```

Note: this assumes the renderer responds on a per-request reply channel. If R2 reveals a different convention in this codebase, adjust to match.

**Step 5: Add the renderer-side handler**

In the renderer, find the existing automations dispatch handler (from R2). Add a new handler for `automations:openPromptPane`:

```ts
// In whichever renderer module owns automation dispatching today
window.api.on?.('automations:openPromptPane', async ({ requestId, worktreeId, agentId, prompt }) => {
  const paneKey = await openTabAndSendPrompt({ worktreeId, agentId, prompt })
  window.api.send(`automations:openPromptPane:reply:${requestId}`, { paneKey })
})
```

Wire `openTabAndSendPrompt` using whatever primitive the renderer already uses for dispatch today. **Do not duplicate the dispatch implementation**; refactor the existing dispatch path to expose this primitive.

**Step 6: Verify**

Run: `pnpm vitest run --config config/vitest.config.ts src/main/automations/open-prompt-pane.test.ts`
Expected: PASS.

Run: `pnpm tc`
Expected: PASS.

**Step 7: Commit**

```bash
git add src/main/automations/open-prompt-pane.ts src/main/automations/open-prompt-pane.test.ts src/renderer/...
git commit -m "feat(automations): main↔renderer roundtrip for opening prompt pane"
```

---

### Task 6: Agent status access from main + complete RunPromptRunner

**Files:**
- Modify: existing hook services (`src/main/claude/hook-service.ts`, etc.) — surface a getter
- Create: `src/main/agent-status/registry.ts`
- Create: `src/main/agent-status/registry.test.ts`
- Modify: `src/main/automations/runners/run-prompt-runner.ts` (fill out polling)
- Modify: `src/main/automations/runners/run-prompt-runner.test.ts` (more cases)

**Goal:** Stand up a main-process source of truth for agent status keyed by `paneKey`, fed by the hook services. The runner polls it and applies debounce + failure semantics per the design (§ Agent step lifecycle).

**Step 1: Write the failing registry test**

Create `src/main/agent-status/registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { AgentStatusRegistry } from './registry'

describe('AgentStatusRegistry', () => {
  it('returns undefined for unknown paneKey', () => {
    const r = new AgentStatusRegistry()
    expect(r.get('p1')).toBeUndefined()
  })

  it('stores the most recent state by paneKey', () => {
    const r = new AgentStatusRegistry()
    r.set('p1', { state: 'working', updatedAt: 1 })
    r.set('p1', { state: 'done', updatedAt: 2 })
    expect(r.get('p1')).toEqual({ state: 'done', updatedAt: 2 })
  })

  it('treats entries older than staleAfterMs as stale', () => {
    const r = new AgentStatusRegistry({ staleAfterMs: 100 })
    r.set('p1', { state: 'working', updatedAt: 0 })
    expect(r.isFresh('p1', 50)).toBe(true)
    expect(r.isFresh('p1', 150)).toBe(false)
  })
})
```

**Step 2: Run to verify failure**

Run: `pnpm vitest run --config config/vitest.config.ts src/main/agent-status/registry.test.ts`
Expected: FAIL.

**Step 3: Implement the registry**

Create `src/main/agent-status/registry.ts`:

```ts
export type AgentState = 'done' | 'working' | 'blocked' | 'waiting'
export type AgentStatusEntry = { state: AgentState; updatedAt: number }

const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000

export class AgentStatusRegistry {
  private readonly entries = new Map<string, AgentStatusEntry>()
  private readonly staleAfterMs: number

  constructor(opts: { staleAfterMs?: number } = {}) {
    this.staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  }

  set(paneKey: string, entry: AgentStatusEntry): void {
    const existing = this.entries.get(paneKey)
    if (!existing || existing.updatedAt <= entry.updatedAt) {
      this.entries.set(paneKey, entry)
    }
  }

  get(paneKey: string): AgentStatusEntry | undefined {
    return this.entries.get(paneKey)
  }

  isFresh(paneKey: string, now: number): boolean {
    const entry = this.entries.get(paneKey)
    if (!entry) return false
    return now - entry.updatedAt < this.staleAfterMs
  }
}
```

**Step 4: Wire each hook service to write into the registry**

For each `src/main/<agent>/hook-service.ts`, find the function that writes to `agentStatusByPaneKey` in the renderer store (likely via IPC). Add a `registry.set(paneKey, { state, updatedAt: Date.now() })` call alongside it.

Pass a singleton registry through dependency injection (created in `src/main/index.ts`, handed to each hook service constructor). Existing hook-service tests should keep passing.

**Step 5: Expand `run-prompt-runner.test.ts`**

Add cases that exercise the lifecycle:

```ts
it('keeps running while agent is working', async () => { /* ... */ })

it('fails when agent reports blocked', async () => { /* expect outcome 'failed', error mentions blocked */ })

it('fails when agent reports waiting', async () => { /* same */ })

it('succeeds when done persists past the debounce window', async () => {
  // First tick: status = done at t=0
  // Second tick at t=14_000: still done — outcome 'needs-more-time'
  // Third tick at t=16_000: still done — outcome 'done', output.paneKey set
})

it('resets the debounce if state flips back to working mid-window', async () => { /* ... */ })

it('times out per step.timeoutSeconds', async () => { /* ... */ })
```

**Step 6: Fill in the runner's polling logic**

Update `RunPromptRunner.tick` to use the registry-shaped status (already supported via `deps.getAgentStatus`) and implement the lifecycle transitions per the design doc § Agent step lifecycle.

**Step 7: Verify all runner tests pass**

Run: `pnpm vitest run --config config/vitest.config.ts src/main/automations/runners/run-prompt-runner.test.ts src/main/agent-status/registry.test.ts`
Expected: PASS, all cases.

Run: `pnpm tc`
Expected: PASS.

**Step 8: Commit**

```bash
git add src/main/agent-status/ src/main/automations/runners/ src/main/*/hook-service.ts src/main/index.ts
git commit -m "feat(automations): agent-status registry + run-prompt lifecycle"
```

---

### Task 7: Chain executor — drive runs forward on each tick

**Files:**
- Create: `src/main/automations/chain-executor.ts`
- Create: `src/main/automations/chain-executor.test.ts`
- Modify: `src/main/automations/service.ts` to call the executor on each tick

**Goal:** Given an in-progress `AutomationRun`, advance its `stepStates` by ticking the active step's runner. Halt on failure (per `onFailure`). Mark the run complete when all steps succeed.

**Step 1: Write the failing test**

Create `src/main/automations/chain-executor.test.ts` with cases:

```ts
import { describe, it, expect, vi } from 'vitest'
import { ChainExecutor } from './chain-executor'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { StepRunner, StepRunnerResult } from './step-runner'

const stubAutomation = (steps: Automation['steps']): Automation => ({
  id: 'a1',
  name: 't',
  prompt: '',
  agentId: 'claude',
  projectId: 'p',
  executionTargetType: 'local',
  executionTargetId: 'local',
  schedulerOwner: 'local_host_service',
  workspaceMode: 'existing',
  workspaceId: 'ws-1',
  baseBranch: null,
  timezone: 'UTC',
  rrule: '',
  dtstart: 0,
  enabled: true,
  nextRunAt: 0,
  missedRunPolicy: 'run_once_within_grace',
  missedRunGraceMinutes: 30,
  createdAt: 0,
  updatedAt: 0,
  trigger: { kind: 'manual' },
  steps
})

describe('ChainExecutor', () => {
  it('initializes step states on first tick', async () => {
    /* ... */
  })

  it('advances to the next step when current step returns done', async () => {
    /* ... */
  })

  it('marks the run completed when all steps succeed', async () => {
    /* ... */
  })

  it('halts the run when a step fails with onFailure="halt"', async () => {
    /* ... */
  })

  it('continues past a failing step when onFailure="continue"', async () => {
    /* ... */
  })

  it('writes contextPatch into the run context after a successful step', async () => {
    /* ... */
  })

  it('is a no-op for legacy runs without stepStates', async () => {
    /* ... */
  })
})
```

**Step 2: Run to verify failure**

Run: `pnpm vitest run --config config/vitest.config.ts src/main/automations/chain-executor.test.ts`
Expected: FAIL.

**Step 3: Implement the executor**

Create `src/main/automations/chain-executor.ts`. Sketch:

```ts
import type {
  Automation,
  AutomationRun,
  Step,
  StepRunState
} from '../../shared/automations-types'
import type { StepRunner } from './step-runner'

export type RunnerLookup = (kind: Step['kind']) => StepRunner | undefined

export type ChainExecutorDeps = {
  getRunner: RunnerLookup
  persistRun: (run: AutomationRun) => void
  now: () => number
}

export class ChainExecutor {
  constructor(private readonly deps: ChainExecutorDeps) {}

  async tick(automation: Automation, run: AutomationRun): Promise<AutomationRun> {
    // 1. Initialize stepStates if missing.
    // 2. Find first non-terminal step.
    // 3. Look up runner, call tick.
    // 4. Apply result (status, output, error, contextPatch).
    // 5. If failed + halt: mark run failed.
    // 6. If all succeeded: mark run completed.
    // 7. Persist.
  }
}
```

**Step 4: Wire into `AutomationService`**

In `src/main/automations/service.ts`, on every `evaluateDueRuns` tick, also iterate over `listAutomationRuns()` with `status === 'running'` and call `chainExecutor.tick(automation, run)`. Add a runner registry built once in `service.ts`'s constructor: `{ 'run-prompt': new RunPromptRunner(...) }`.

**Step 5: Verify**

Run: `pnpm vitest run --config config/vitest.config.ts src/main/automations/chain-executor.test.ts src/main/automations/service.test.ts`
Expected: PASS.

Run: `pnpm tc`
Expected: PASS.

**Step 6: Commit**

```bash
git add src/main/automations/chain-executor.ts src/main/automations/chain-executor.test.ts src/main/automations/service.ts
git commit -m "feat(automations): chain executor + service-level tick integration"
```

---

### Task 8: Run-now path uses the chain executor end-to-end

**Files:**
- Modify: `src/main/automations/service.ts` (`runNow` method)
- Modify: store: persist `stepStates` initialization when a chain run is created

**Goal:** A user clicks "Run now" on an automation that has `trigger.kind === 'manual'` and `steps: [...run-prompt...]`. The chain runs end-to-end with no manual intervention. The run row in `orca-data.json` ends up with `status: 'completed'` and per-step success metadata.

**Step 1: Write an integration-style test**

Create `src/main/automations/run-now-integration.test.ts`. Mock `openPromptPane` and `AgentStatusRegistry` so we can deterministically simulate an agent flipping working → done. Assert the run reaches `completed`.

**Step 2: Run to verify failure**

Expected: FAIL (`runNow` still uses the legacy dispatch path).

**Step 3: Implement**

In `service.ts`, branch in `runNow`:

```ts
async runNow(automationId: string): Promise<AutomationRun> {
  const automation = this.store.listAutomations().find(a => a.id === automationId)
  if (!automation) throw new Error('Automation not found.')
  if (automation.trigger && automation.steps) {
    const run = this.store.createAutomationRun(automation, Date.now(), 'manual')
    // Initialize stepStates
    this.store.updateAutomationRun({
      runId: run.id,
      status: 'pending', // or 'running' after first tick
      workspaceId: automation.workspaceId,
      stepStates: automation.steps.map(s => ({
        stepId: s.id,
        status: 'pending',
        startedAt: null,
        finishedAt: null,
        output: null,
        error: null
      }))
    })
    // Kick off the first tick immediately for snappy UX
    await this.chainExecutor.tick(automation, this.store.getAutomationRun(run.id))
    return this.store.getAutomationRun(run.id)
  }
  // Legacy path
  return this.legacyRunNow(automation)
}
```

You may need to add `getAutomationRun(id)` and extend `updateAutomationRun` to accept `stepStates` — those are tiny persistence additions.

**Step 4: Verify**

Run: `pnpm vitest run --config config/vitest.config.ts src/main/automations/`
Expected: PASS.

Run: `pnpm tc`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/main/automations/ src/main/persistence.ts
git commit -m "feat(automations): runNow uses chain executor for new-shape automations"
```

---

### Task 9: Minimal UI surfacing in the existing Automations page

**Files:**
- Modify: `src/renderer/src/components/automations/AutomationsPage.tsx` (run rows)
- Modify: `src/renderer/src/components/automations/AutomationDetail.tsx`

**Goal:** A "new-shape" automation appears in the existing list without any new editor. The detail view shows the step states from `AutomationRun.stepStates` as a vertical list with status pills and per-step timings. The existing single-step editor still works for legacy rows. **The new editor is Phase 5; v1 of the chain happens with manually-edited rows in `orca-data.json` if needed.**

**Step 1: Write the failing component test**

Create `src/renderer/src/components/automations/AutomationDetail.step-states.test.tsx`:

```tsx
// Render AutomationDetail with a run that has stepStates.
// Assert that each step renders with its status pill (pending/running/succeeded/failed).
```

**Step 2: Run to verify failure**

Expected: FAIL.

**Step 3: Implement**

In `AutomationDetail.tsx`, where the per-run summary is rendered, branch on whether the run has `stepStates`:

```tsx
{run.stepStates && run.stepStates.length > 0 ? (
  <ol className="flex flex-col gap-1">
    {run.stepStates.map(s => (
      <li key={s.stepId} className="flex items-center gap-2 text-xs">
        <StatusPill status={s.status} />
        <span className="font-mono text-muted-foreground">{s.stepId}</span>
        {s.error && <span className="text-rose-500">{s.error}</span>}
      </li>
    ))}
  </ol>
) : (
  /* existing legacy run rendering unchanged */
)}
```

Add a minimal `StatusPill` component if one doesn't already exist (likely it does — check `src/renderer/src/components/ui/`).

**Step 4: Verify**

Run: `pnpm vitest run --config config/vitest.config.ts src/renderer/src/components/automations/`
Expected: PASS.

Run: `pnpm tc:web`
Expected: PASS.

**Step 5: Manual smoke test**

Open the app, create a chain-shape automation via the legacy editor (it'll save as legacy and migrate on next read), restart the app to pick up migration, click Run Now, watch the run states advance in the detail view.

**Step 6: Commit**

```bash
git add src/renderer/src/components/automations/
git commit -m "feat(automations): show step states in the run detail view"
```

---

### Task 10: Phase 1 verification

**Step 1: Run the whole test suite**

Run: `pnpm test`
Expected: PASS.

**Step 2: Typecheck everything**

Run: `pnpm tc`
Expected: PASS.

**Step 3: Smoke-test the canonical Phase 1 path manually**

1. Launch dev Orca (`pnpm dev`).
2. Create an existing-style automation pointing at a workspace and a prompt that ends quickly (e.g., "Reply with the word DONE then stop.").
3. Quit and relaunch — the automation now reads as a chain on load.
4. Click Run Now. Confirm the tab opens, the agent runs, the run-detail view shows the step transitioning from `running` → `succeeded`.
5. Try an automation with a never-completing prompt + a short `timeoutSeconds`. Confirm the step times out.

**Step 4: Update the design doc with "Phase 1 ✅" + commit**

Append to `docs/plans/2026-05-19-automations-chain-engine-design.md`:

```markdown
## Status

- 2026-05-19: Design approved.
- 2026-??-??: Phase 1 (foundation) shipped. Re-plan begins for Phase 2.
```

```bash
git add docs/plans/2026-05-19-automations-chain-engine-design.md
git commit -m "docs(automations): mark Phase 1 complete"
```

---

## Phase 2 — Step palette expansion (outline)

Each step kind is its own runner. TDD pattern from Tasks 3/6 applies. Estimated 3 tasks × 5 TDD steps each:

- **`create-worktree` runner.** Reuses existing worktree-create IPC. Output: `{ worktreeId, path, branch }`.
- **`wait-for-setup` runner.** Polls `scriptsByWorktree[wtId].setup.status` from a main-side mirror (mirror lands as part of this phase). Output: `{ exitCode, durationMs }`.
- **`run-command` runner.** Reuses existing `reviewCommands` / `createPrCommands` infrastructure. Captures last 32KB of stdout. Output: `{ exitCode, stdoutTail, stderrTail }`.

Re-plan in detail when Phase 1 lands.

## Phase 3 — Schedule trigger (extended)

Extend `TriggerConfig` with `{ kind: 'schedule', rrule, dtstart, timezone, missedRunGraceMinutes }`. Reuse `RRuleScheduler`. On fire, create a chain run instead of a single dispatch. Migration: legacy schedule-driven automations whose `trigger.kind` is currently `manual` (per Phase 1 migration) get re-upgraded to `schedule` once Phase 3 lands.

## Phase 4 — Linear trigger + Hookdeck

New module `src/main/automations/triggers/linear/`:

- `linear-trigger.ts` — registers with the service, parses incoming events, evaluates `LinearFilter[]`, fires chain runs.
- `hookdeck-supervisor.ts` — spawns `hookdeck listen` as a child process, restart-on-exit, exposes health.
- `local-receiver.ts` — Fastify-ish HTTP server bound to 127.0.0.1, verifies HMAC, hands payloads to `linear-trigger`.
- Settings pane: Integrations → Linear (Hookdeck). Stores Hookdeck source URL + API key in encrypted-at-rest storage.

## Phase 5 — Chain editor UI

Full-screen modal replacing `AutomationEditorDialog`. Vertical card list with `+` inserts. Per-kind config bodies. Drag-reorder. Live template validation.

## Phase 6 — Run viewer UI

Same vertical layout as the editor, decorated with execution state per card. Deep-link to captured `paneKey`. Expandable stdout/stderr tails for `run-command` steps. Trigger payload JSON at the top.

## Phase 7 — Variable picker

`{{` autocomplete popover with type-hinted suggestions, scoped to "what's available at this step's position." Live validation flags unresolved or future-step references in red.

---

## Risks revisited (Phase 1 only)

1. **Renderer IPC roundtrip latency.** If `openPromptPane` regularly takes >5s, the executor will look slow. Profile during smoke testing; bump the timeout in `openPromptPane` if needed.
2. **Hook reporter coverage.** Phase 1 ships with `RunPromptRunner` watching the existing `agentStatusByPaneKey`. Some agents may not report `done` reliably; manual timeout configuration is the v1 escape hatch.
3. **Concurrency.** Phase 1 has no `maxConcurrentRuns` enforcement yet — Run Now is one-at-a-time by user, so the issue is theoretical. Wire enforcement in Phase 3 when scheduled chains can fire on their own.
4. **Migration safety.** The on-read migration is idempotent and non-destructive. The first write back to disk loses the legacy fields. Make a backup of `orca-data.json` before the first Phase 1 launch on a real profile (the `pnpm sync:dev-from-prod` script can stage a test against a snapshot).
