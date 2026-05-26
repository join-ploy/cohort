# Parallel Steps Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow automation steps to run in parallel within a group, with the chain only advancing after all parallel siblings complete.

**Architecture:** Extend `Automation.steps` from `Step[]` to `StepOrGroup[]` where `StepOrGroup = Step | Step[]`. The chain executor handles groups by ticking all non-terminal runners per group on each cycle, using wait-for-all failure semantics. The editor renders parallel groups as horizontal rows with drag-to-parallelize and a "+" button.

**Tech Stack:** TypeScript, Vitest, React, dnd-kit, Tailwind CSS, Electron IPC

---

### Task 1: Add `StepOrGroup` type and `flattenSteps` helper

**Files:**
- Modify: `src/shared/automations-types.ts`
- Modify: `src/renderer/src/lib/chain-editor-state.ts`
- Test: `src/renderer/src/lib/chain-editor-state.test.ts`

**Step 1: Write the failing test for `flattenSteps`**

In `src/renderer/src/lib/chain-editor-state.test.ts`, add:

```ts
import { flattenSteps } from './chain-editor-state'
import type { StepOrGroup } from '../../../shared/automations-types'

describe('flattenSteps', () => {
  it('returns the same steps for a flat array', () => {
    const steps: Step[] = [
      { id: 'a', kind: 'run-prompt', config: {} as never, onFailure: 'halt', timeoutSeconds: null },
      { id: 'b', kind: 'run-command', config: {} as never, onFailure: 'halt', timeoutSeconds: null },
    ]
    expect(flattenSteps(steps).map(s => s.id)).toEqual(['a', 'b'])
  })

  it('flattens parallel groups into a single array', () => {
    const a: Step = { id: 'a', kind: 'run-prompt', config: {} as never, onFailure: 'halt', timeoutSeconds: null }
    const b: Step = { id: 'b', kind: 'run-command', config: {} as never, onFailure: 'halt', timeoutSeconds: null }
    const c: Step = { id: 'c', kind: 'run-prompt', config: {} as never, onFailure: 'halt', timeoutSeconds: null }
    const d: Step = { id: 'd', kind: 'run-command', config: {} as never, onFailure: 'halt', timeoutSeconds: null }
    const steps: StepOrGroup[] = [a, [b, c], d]
    expect(flattenSteps(steps).map(s => s.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- src/renderer/src/lib/chain-editor-state.test.ts`
Expected: FAIL — `flattenSteps` is not exported

**Step 3: Add `StepOrGroup` type and `flattenSteps`**

In `src/shared/automations-types.ts`, after the `Step` type, add:

```ts
export type StepOrGroup = Step | Step[]
```

Change the `steps` field on `Automation` from `steps?: Step[]` to `steps?: StepOrGroup[]`. Do the same on `AutomationCreateInput` and `AutomationUpdateInput`.

In `src/renderer/src/lib/chain-editor-state.ts`, add and export:

```ts
import type { StepOrGroup } from '../../../shared/automations-types'

export function flattenSteps(steps: StepOrGroup[]): Step[] {
  const result: Step[] = []
  for (const item of steps) {
    if (Array.isArray(item)) {
      result.push(...item)
    } else {
      result.push(item)
    }
  }
  return result
}
```

Update `ChainDraft.steps` from `Step[]` to `StepOrGroup[]`.

**Step 4: Run test to verify it passes**

Run: `pnpm test -- src/renderer/src/lib/chain-editor-state.test.ts`
Expected: PASS

**Step 5: Run typechecker to check for cascading type errors**

Run: `pnpm tc`
Expected: Errors in files that consume `draft.steps` as `Step[]` — these are fixed in subsequent tasks. Note the list for Task 3.

**Step 6: Commit**

```bash
git add src/shared/automations-types.ts src/renderer/src/lib/chain-editor-state.ts src/renderer/src/lib/chain-editor-state.test.ts
git commit -m "feat(automations): add StepOrGroup type and flattenSteps helper"
```

---

### Task 2: Add group manipulation helpers

**Files:**
- Modify: `src/renderer/src/lib/chain-editor-state.ts`
- Test: `src/renderer/src/lib/chain-editor-state.test.ts`

**Step 1: Write failing tests for `groupStepAt`, `ungroupStep`, `reorderWithinGroup`**

```ts
describe('groupStepAt', () => {
  it('wraps a solo step into a parallel group with a new step', () => {
    const a: Step = { id: 'a', kind: 'run-prompt', config: {} as never, onFailure: 'halt', timeoutSeconds: null }
    const b: Step = { id: 'b', kind: 'run-command', config: {} as never, onFailure: 'halt', timeoutSeconds: null }
    const newStep: Step = { id: 'n', kind: 'run-prompt', config: {} as never, onFailure: 'halt', timeoutSeconds: null }
    const steps: StepOrGroup[] = [a, b]
    const result = groupStepAt(steps, 0, newStep)
    expect(result.length).toBe(2)
    expect(Array.isArray(result[0])).toBe(true)
    expect((result[0] as Step[]).map(s => s.id)).toEqual(['a', 'n'])
  })

  it('appends to an existing parallel group', () => {
    const a: Step = { id: 'a', kind: 'run-prompt', config: {} as never, onFailure: 'halt', timeoutSeconds: null }
    const b: Step = { id: 'b', kind: 'run-command', config: {} as never, onFailure: 'halt', timeoutSeconds: null }
    const newStep: Step = { id: 'n', kind: 'run-prompt', config: {} as never, onFailure: 'halt', timeoutSeconds: null }
    const steps: StepOrGroup[] = [[a, b]]
    const result = groupStepAt(steps, 0, newStep)
    expect((result[0] as Step[]).map(s => s.id)).toEqual(['a', 'b', 'n'])
  })
})

describe('ungroupStep', () => {
  it('removes a step from a group and unwraps if one remains', () => {
    const a: Step = { id: 'a', kind: 'run-prompt', config: {} as never, onFailure: 'halt', timeoutSeconds: null }
    const b: Step = { id: 'b', kind: 'run-command', config: {} as never, onFailure: 'halt', timeoutSeconds: null }
    const steps: StepOrGroup[] = [[a, b]]
    const result = ungroupStep(steps, 0, 0)
    // b stays, but group unwraps to solo
    expect(result.length).toBe(1)
    expect(Array.isArray(result[0])).toBe(false)
    expect((result[0] as Step).id).toBe('b')
  })

  it('keeps the group if 2+ siblings remain', () => {
    const a: Step = { id: 'a', kind: 'run-prompt', config: {} as never, onFailure: 'halt', timeoutSeconds: null }
    const b: Step = { id: 'b', kind: 'run-command', config: {} as never, onFailure: 'halt', timeoutSeconds: null }
    const c: Step = { id: 'c', kind: 'run-prompt', config: {} as never, onFailure: 'halt', timeoutSeconds: null }
    const steps: StepOrGroup[] = [[a, b, c]]
    const result = ungroupStep(steps, 0, 1)
    expect(Array.isArray(result[0])).toBe(true)
    expect((result[0] as Step[]).map(s => s.id)).toEqual(['a', 'c'])
  })
})

describe('reorderWithinGroup', () => {
  it('reorders siblings within a parallel group', () => {
    const a: Step = { id: 'a', kind: 'run-prompt', config: {} as never, onFailure: 'halt', timeoutSeconds: null }
    const b: Step = { id: 'b', kind: 'run-command', config: {} as never, onFailure: 'halt', timeoutSeconds: null }
    const c: Step = { id: 'c', kind: 'run-prompt', config: {} as never, onFailure: 'halt', timeoutSeconds: null }
    const steps: StepOrGroup[] = [[a, b, c]]
    const result = reorderWithinGroup(steps, 0, 0, 2)
    expect((result[0] as Step[]).map(s => s.id)).toEqual(['b', 'c', 'a'])
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/renderer/src/lib/chain-editor-state.test.ts`
Expected: FAIL — functions not exported

**Step 3: Implement the helpers**

In `src/renderer/src/lib/chain-editor-state.ts`:

```ts
export function groupStepAt(steps: StepOrGroup[], index: number, newStep: Step): StepOrGroup[] {
  const next = steps.slice()
  const existing = next[index]
  if (Array.isArray(existing)) {
    next[index] = [...existing, newStep]
  } else {
    next[index] = [existing, newStep]
  }
  return next
}

export function ungroupStep(steps: StepOrGroup[], groupIndex: number, innerIndex: number): StepOrGroup[] {
  const next = steps.slice()
  const group = next[groupIndex]
  if (!Array.isArray(group)) {
    return next
  }
  const remaining = group.filter((_, i) => i !== innerIndex)
  if (remaining.length <= 1) {
    next[groupIndex] = remaining[0]
  } else {
    next[groupIndex] = remaining
  }
  return next
}

export function reorderWithinGroup(
  steps: StepOrGroup[],
  groupIndex: number,
  fromInner: number,
  toInner: number
): StepOrGroup[] {
  const next = steps.slice()
  const group = next[groupIndex]
  if (!Array.isArray(group)) {
    return next
  }
  const children = group.slice()
  const [moved] = children.splice(fromInner, 1)
  children.splice(toInner, 0, moved)
  next[groupIndex] = children
  return next
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/renderer/src/lib/chain-editor-state.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/lib/chain-editor-state.ts src/renderer/src/lib/chain-editor-state.test.ts
git commit -m "feat(automations): add groupStepAt, ungroupStep, reorderWithinGroup helpers"
```

---

### Task 3: Update existing chain-editor-state functions for `StepOrGroup[]`

**Files:**
- Modify: `src/renderer/src/lib/chain-editor-state.ts`
- Modify: `src/renderer/src/lib/chain-editor-state.test.ts`
- Modify: `src/renderer/src/components/automations/editor/chain-editor-modal-state.ts`

This task fixes all the existing functions that iterate `draft.steps` as if it were `Step[]`. The key change: they must use `flattenSteps()` wherever they need a flat step list, and position-aware logic where order matters.

**Step 1: Update `generateDefaultStepId` to accept `StepOrGroup[]`**

Change the signature from `(kind: StepKind, steps: Step[])` to `(kind: StepKind, steps: StepOrGroup[])` and use `flattenSteps(steps)` inside. Existing tests still pass unchanged since `Step[]` is a valid `StepOrGroup[]`.

**Step 2: Update `renameStepWithRewrites`**

Change signature from `(steps: Step[], oldId, newId)` to `(steps: StepOrGroup[], oldId, newId): StepOrGroup[]`. Internally, iterate the nested structure — for each top-level item, if it's a `Step[]`, map over the inner array applying the same rename + rewrite logic. The collision check uses `flattenSteps`.

**Step 3: Update `reorderSteps`**

Change signature from `(steps: Step[], from, to)` to `(steps: StepOrGroup[], from, to): StepOrGroup[]`. The splice logic is the same — it moves top-level items (which may be solo steps or groups).

**Step 4: Update `detectFutureReferences`**

Change signature to accept `StepOrGroup[]`. Build the `indexById` map with position-aware logic: all steps in a parallel group at top-level index `i` share position `i`. A step referencing a sibling in the same group is a future-reference violation (same position = concurrent, output not available).

Add test:

```ts
it('flags a sibling reference within a parallel group as a future reference', () => {
  const a: Step = { id: 'a', kind: 'run-prompt', config: {
    worktreeRef: '{{steps.b.paneKey}}', agentId: 'claude', prompt: '', doneDebounceSeconds: 5
  } as never, onFailure: 'halt', timeoutSeconds: null }
  const b: Step = { id: 'b', kind: 'run-prompt', config: {} as never, onFailure: 'halt', timeoutSeconds: null }
  const steps: StepOrGroup[] = [[a, b]]
  const violations = detectFutureReferences(steps)
  expect(violations).toHaveLength(1)
  expect(violations[0]).toMatchObject({ fromStepId: 'a', toStepId: 'b' })
})

it('allows referencing a parallel group sibling from a step after the group', () => {
  const a: Step = { id: 'a', kind: 'run-prompt', config: {} as never, onFailure: 'halt', timeoutSeconds: null }
  const b: Step = { id: 'b', kind: 'run-prompt', config: {} as never, onFailure: 'halt', timeoutSeconds: null }
  const c: Step = { id: 'c', kind: 'run-prompt', config: {
    worktreeRef: '{{steps.a.paneKey}}', agentId: 'claude', prompt: '', doneDebounceSeconds: 5
  } as never, onFailure: 'halt', timeoutSeconds: null }
  const steps: StepOrGroup[] = [[a, b], c]
  expect(detectFutureReferences(steps)).toEqual([])
})
```

**Step 5: Update `walkStepConfigStrings` — no change needed**

This function takes a single `StepConfig` + `StepKind`, not the steps array. No changes required.

**Step 6: Update `chain-editor-modal-state.ts` functions**

Functions in this file that iterate `draft.steps`:

- `getAvailableVariablesAtStep`: Change the loop to iterate `StepOrGroup[]` with position awareness. Steps inside a group at the same top-level index as `stepIndex` are NOT available. Steps in groups before `stepIndex` ARE available.
- `computeAllErrors`: Use `flattenSteps` + position-aware indexing.
- `chainHasStep`: Use `flattenSteps`.
- `chainReferencesAutomationProjectId`: Use `flattenSteps`.
- `isProjectRequired`: No change (delegates to helpers).
- `pickDefaultWorktreeRef`: Accept `StepOrGroup[]`, use `flattenSteps` internally.
- `seedDraft`: No change (just copies `automation.steps`).

**Step 7: Run all tests**

Run: `pnpm test -- src/renderer/src/lib/chain-editor-state.test.ts`
Expected: PASS

**Step 8: Run typechecker**

Run: `pnpm tc`
Expected: Remaining errors only in UI components (fixed in later tasks)

**Step 9: Commit**

```bash
git add src/renderer/src/lib/chain-editor-state.ts src/renderer/src/lib/chain-editor-state.test.ts src/renderer/src/components/automations/editor/chain-editor-modal-state.ts
git commit -m "feat(automations): update editor state functions for StepOrGroup[]"
```

---

### Task 4: Update ChainExecutor for parallel groups

**Files:**
- Modify: `src/main/automations/chain-executor.ts`
- Test: `src/main/automations/chain-executor.test.ts`

**Step 1: Write failing tests for parallel group execution**

In `chain-executor.test.ts`, add:

```ts
import type { StepOrGroup } from '../../shared/automations-types'

// Update the `automation` helper to accept StepOrGroup[]
function automation(steps: StepOrGroup[]): Automation {
  // ... same body, just change the param type
}

describe('parallel groups', () => {
  it('ticks all siblings in a parallel group', async () => {
    const tick = vi.fn().mockResolvedValue({ outcome: 'needs-more-time', status: 'running' })
    const runner: StepRunner = { tick }
    const executor = new ChainExecutor({
      getRunner: () => runner,
      persistRun: vi.fn(),
      now: () => 0,
    })
    const s1: Step = { ...sampleStep, id: 's1' }
    const s2: Step = { ...sampleStep, id: 's2' }
    const r = run('a1')
    await executor.tick(automation([[s1, s2]]), r)
    expect(r.stepStates).toHaveLength(2)
    expect(r.stepStates![0]).toMatchObject({ stepId: 's1', status: 'running' })
    expect(r.stepStates![1]).toMatchObject({ stepId: 's2', status: 'running' })
    expect(tick).toHaveBeenCalledTimes(2)
  })

  it('waits for all siblings before advancing past the group', async () => {
    const tick = vi.fn()
      .mockResolvedValueOnce({ outcome: 'done', status: 'succeeded' }) // s1 done
      .mockResolvedValueOnce({ outcome: 'needs-more-time', status: 'running' }) // s2 still going
    const runner: StepRunner = { tick }
    const executor = new ChainExecutor({
      getRunner: () => runner,
      persistRun: vi.fn(),
      now: () => 0,
    })
    const s1: Step = { ...sampleStep, id: 's1' }
    const s2: Step = { ...sampleStep, id: 's2' }
    const s3: Step = { ...sampleStep, id: 's3' }
    const r = run('a1')
    await executor.tick(automation([[s1, s2], s3]), r)
    // s3 should NOT have started yet
    expect(r.stepStates).toHaveLength(2)
    expect(r.stepStates![0].status).toBe('succeeded')
    expect(r.stepStates![1].status).toBe('running')
  })

  it('advances past the group when all siblings are terminal', async () => {
    const tick = vi.fn()
      .mockResolvedValueOnce({ outcome: 'done', status: 'succeeded' }) // s1
      .mockResolvedValueOnce({ outcome: 'done', status: 'succeeded' }) // s2
      .mockResolvedValueOnce({ outcome: 'needs-more-time', status: 'running' }) // s3
    const runner: StepRunner = { tick }
    const executor = new ChainExecutor({
      getRunner: () => runner,
      persistRun: vi.fn(),
      now: () => 0,
    })
    const s1: Step = { ...sampleStep, id: 's1' }
    const s2: Step = { ...sampleStep, id: 's2' }
    const s3: Step = { ...sampleStep, id: 's3' }
    const r = run('a1')
    await executor.tick(automation([[s1, s2], s3]), r)
    expect(r.stepStates).toHaveLength(3)
    expect(r.stepStates![2]).toMatchObject({ stepId: 's3', status: 'running' })
  })

  it('halts the run when a halt-policy sibling fails (after all finish)', async () => {
    const tick = vi.fn()
      .mockResolvedValueOnce({ outcome: 'failed', status: 'failed', error: 'boom' }) // s1
      .mockResolvedValueOnce({ outcome: 'done', status: 'succeeded' }) // s2
    const runner: StepRunner = { tick }
    const executor = new ChainExecutor({
      getRunner: () => runner,
      persistRun: vi.fn(),
      now: () => 0,
    })
    const s1: Step = { ...sampleStep, id: 's1', onFailure: 'halt' }
    const s2: Step = { ...sampleStep, id: 's2' }
    const s3: Step = { ...sampleStep, id: 's3' }
    const r = run('a1')
    await executor.tick(automation([[s1, s2], s3]), r)
    expect(r.status).toBe('failed')
    expect(r.stepStates).toHaveLength(2) // s3 never started
  })

  it('continues past a group when all failures are continue-policy', async () => {
    const tick = vi.fn()
      .mockResolvedValueOnce({ outcome: 'failed', status: 'failed', error: 'oops' }) // s1
      .mockResolvedValueOnce({ outcome: 'done', status: 'succeeded' }) // s2
      .mockResolvedValueOnce({ outcome: 'done', status: 'succeeded' }) // s3
    const runner: StepRunner = { tick }
    const executor = new ChainExecutor({
      getRunner: () => runner,
      persistRun: vi.fn(),
      now: () => 0,
    })
    const s1: Step = { ...sampleStep, id: 's1', onFailure: 'continue' }
    const s2: Step = { ...sampleStep, id: 's2' }
    const s3: Step = { ...sampleStep, id: 's3' }
    const r = run('a1')
    await executor.tick(automation([[s1, s2], s3]), r)
    expect(r.stepStates).toHaveLength(3)
    expect(r.status).toBe('completed')
  })

  it('merges context patches from parallel siblings without clobbering', async () => {
    const tick = vi.fn()
      .mockResolvedValueOnce({
        outcome: 'done', status: 'succeeded',
        contextPatch: { steps: { s1: { out: 'a' } } }
      })
      .mockResolvedValueOnce({
        outcome: 'done', status: 'succeeded',
        contextPatch: { steps: { s2: { out: 'b' } } }
      })
    const runner: StepRunner = { tick }
    const executor = new ChainExecutor({
      getRunner: () => runner,
      persistRun: vi.fn(),
      now: () => 0,
    })
    const s1: Step = { ...sampleStep, id: 's1' }
    const s2: Step = { ...sampleStep, id: 's2' }
    const r = run('a1')
    await executor.tick(automation([[s1, s2]]), r)
    expect(r.context).toMatchObject({
      steps: { s1: { out: 'a' }, s2: { out: 'b' } }
    })
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/main/automations/chain-executor.test.ts`
Expected: FAIL — type errors and logic not yet updated

**Step 3: Implement parallel group support in ChainExecutor**

Key changes to `chain-executor.ts`:

1. Import `StepOrGroup` type. Change internal references from `automation.steps` (as `Step[]`) to `StepOrGroup[]`.

2. Add a helper to count total flat steps for `maxIterations`:

```ts
function countFlatSteps(steps: StepOrGroup[]): number {
  let count = 0
  for (const item of steps) {
    count += Array.isArray(item) ? item.length : 1
  }
  return count
}
```

3. Rewrite `tickOnce` to detect whether the current position holds a `Step` or `Step[]`:

For a parallel group:
- If no step states exist for the group yet, append one `StepRunState` per sibling (all `running`).
- Tick every non-terminal sibling's runner. Apply context patch on each terminal result.
- After ticking all, check: if any sibling is still non-terminal, return `false` (wait).
- If all terminal: check halt policy — any halt-configured failure halts the run. Otherwise advance.
- Return `true` if all siblings just became terminal and there's more chain.

4. Update `finalizeRun` to build a step-id-to-Step lookup from the flattened `StepOrGroup[]` instead of using positional indexing.

**Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/main/automations/chain-executor.test.ts`
Expected: PASS (all existing tests + new parallel tests)

**Step 5: Commit**

```bash
git add src/main/automations/chain-executor.ts src/main/automations/chain-executor.test.ts
git commit -m "feat(automations): parallel group support in ChainExecutor"
```

---

### Task 5: Update AutomationService for `StepOrGroup[]`

**Files:**
- Modify: `src/main/automations/service.ts`

**Step 1: Update `service.ts` for `StepOrGroup[]` compatibility**

The service has several places that reference `automation.steps`:

1. `runNow` — checks `automation.steps && automation.steps.length > 0`. This still works for `StepOrGroup[]` since both solo steps and groups are truthy array elements.

2. `dispatchRun` — same length check. No change needed.

3. `retryRunFromStep` — uses `stepIndex` against `automation.steps`. This needs to be updated: the `stepIndex` refers to the flat `stepStates` array position, which needs to be mapped back to the right position in the `StepOrGroup[]` structure. Add a `flattenSteps` import and use it for the bounds check.

4. `cancelRun` — iterates `run.stepStates` directly. No change needed (stepStates is always flat).

**Step 2: Run existing service tests**

Run: `pnpm test -- src/main/automations/service.test.ts`
Expected: PASS (no behavioral change)

**Step 3: Run typechecker**

Run: `pnpm tc:node`
Expected: PASS for main process files

**Step 4: Commit**

```bash
git add src/main/automations/service.ts
git commit -m "feat(automations): update AutomationService for StepOrGroup[]"
```

---

### Task 6: Update ChainEditorModal for parallel group rendering

**Files:**
- Modify: `src/renderer/src/components/automations/editor/ChainEditorModal.tsx`
- Modify: `src/renderer/src/components/automations/editor/ChainEditorStepCardRouter.tsx`
- Modify: `src/renderer/src/components/automations/editor/StepCardChrome.tsx`

**Step 1: Add a `ParallelGroupRow` component**

In `ChainEditorModal.tsx`, create a new component that renders a horizontal row of step cards:

```tsx
type ParallelGroupRowProps = {
  group: Step[]
  groupIndex: number
  // ... same callback props as individual step cards, but scoped to group
}

function ParallelGroupRow(props: ParallelGroupRowProps): React.JSX.Element {
  // Renders: horizontal flex row of step cards + [+] button on the right
  // Each card gets min-w-[280px] and equal flex share
  // Horizontal SortableContext with horizontalListSortingStrategy for intra-group reorder
}
```

**Step 2: Update the main editor body to render `StepOrGroup[]`**

Replace the existing `draft.steps.map((step, index) => ...)` with logic that checks each item:

```tsx
{draft.steps.map((item, index) => {
  if (Array.isArray(item)) {
    return <ParallelGroupRow key={item.map(s => s.id).join(',')} group={item} groupIndex={index} ... />
  }
  return (
    <div key={(item as Step).id} className="flex items-center gap-2">
      <div className="flex-1">
        <ChainEditorStepCardRouter step={item as Step} ... />
      </div>
      <AddParallelButton onClick={() => handleAddParallel(index)} />
    </div>
  )
})}
```

**Step 3: Add the `[+]` button component for adding parallel siblings**

```tsx
function AddParallelButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Add parallel step"
      onClick={onClick}
      className="shrink-0 text-muted-foreground hover:text-foreground"
    >
      <Plus className="size-3.5" />
    </Button>
  )
}
```

Clicking it opens the step-kind picker and calls `groupStepAt(draft.steps, index, newStep)`.

**Step 4: Update DnD handling**

The existing `handleDragEnd` handles vertical reorder. Extend it:

- Use unique IDs that encode position: e.g. `group-${groupIdx}-${step.id}` for steps inside groups.
- On drag end: if source and target are in the same group → `reorderWithinGroup`. If source is in a group and target is outside → `ungroupStep` + insert at new position. If source is outside and target is inside a group → remove from position + `groupStepAt`.
- For drag from outside onto left/right edge of a step: create a group via `groupStepAt`.

**Step 5: Add connector line styling**

Between sequential items, add a vertical connector:

```tsx
{index > 0 && (
  <div className="flex justify-center py-1">
    <div className="h-4 w-px bg-border" />
  </div>
)}
```

For parallel groups, add horizontal fan-out/fan-in lines above and below the row using CSS pseudo-elements or thin divs.

**Step 6: Update `StepCardChrome` to support parallel context**

Add an optional `inParallelGroup` prop. When true, the card uses a slightly narrower style (no max-width constraint, allowing flex layout to control width).

**Step 7: Run typechecker**

Run: `pnpm tc:web`
Expected: PASS

**Step 8: Run the app and visually verify**

Run: `pnpm dev`
- Create a new automation
- Add 2 steps
- Click [+] on the first step → should wrap into parallel group
- Verify horizontal layout with both cards side by side
- Verify the [+] button on the group adds a third sibling
- Verify the "Add step" button at the bottom still adds sequential steps
- Drag a step within a group → reorder works
- Save and reopen → parallel structure preserved

**Step 9: Commit**

```bash
git add src/renderer/src/components/automations/editor/ChainEditorModal.tsx src/renderer/src/components/automations/editor/ChainEditorStepCardRouter.tsx src/renderer/src/components/automations/editor/StepCardChrome.tsx
git commit -m "feat(automations): parallel group rendering in chain editor"
```

---

### Task 7: Update DnD to support drag-to-parallelize and drag-out-of-group

**Files:**
- Modify: `src/renderer/src/components/automations/editor/ChainEditorModal.tsx`

**Step 1: Implement drop zone detection for parallel creation**

Use dnd-kit's `DragOverlay` and custom collision detection to determine whether a drop should:
- Reorder vertically (drop above/below a step)
- Create/extend a parallel group (drop left/right of a step)
- Remove from group (drop above/below from inside a group)

Key approach: use `rectIntersection` collision detection. On `onDragOver`, check the pointer position relative to the drop target's bounding rect:
- If within the center 60% vertically → vertical reorder (existing behavior)
- If within the left/right 20% → parallel group creation

**Step 2: Add visual drop indicators**

- Vertical drop: horizontal line between steps (existing pattern)
- Parallel drop: vertical highlight bar on the left or right edge of the target card

```tsx
// Inside the step card wrapper, conditionally show drop indicator
{isParallelDropTarget && (
  <div className="absolute inset-y-0 right-0 w-0.5 bg-ring" />
)}
```

**Step 3: Implement drag-out-of-group**

When a step inside a parallel group is dragged to a position above/below the group:
1. `ungroupStep` to remove it from the group
2. Insert it at the new top-level position
3. If the group has only 1 sibling left, auto-unwrap

**Step 4: Test in the app**

Run: `pnpm dev`
- Drag a solo step onto the right side of another solo step → creates parallel group
- Drag a step from a parallel group to above/below → removes from group
- Drag from a group with only 2 members → group auto-unwraps
- Verify keyboard reorder still works within groups

**Step 5: Commit**

```bash
git add src/renderer/src/components/automations/editor/ChainEditorModal.tsx
git commit -m "feat(automations): drag-to-parallelize and drag-out-of-group"
```

---

### Task 8: Update AutomationDetail run history for parallel step rendering

**Files:**
- Modify: `src/renderer/src/components/automations/AutomationDetail.tsx`

**Step 1: Update `ChainStepRow` and step summary rendering**

The `ChainStepRow` currently renders a numbered list of steps. Update it to:
- Iterate `StepOrGroup[]` from `automation.steps`
- For solo steps: same as today
- For parallel groups: render a sub-row with horizontal layout showing all siblings, with a visual indicator (e.g. "Parallel" badge)

**Step 2: Update `StepRunRow` rendering in run history**

The `stepStates` flat array needs to be correlated back to the `automation.steps` structure to show which steps were parallel. Build a mapping from step ID to its group membership, then render parallel step states side-by-side:

```tsx
// Group consecutive step states that belong to the same parallel group
function groupStepStates(
  stepStates: StepRunState[],
  automationSteps: StepOrGroup[]
): (StepRunState | StepRunState[])[] {
  // Build a set of step IDs that are in parallel groups
  // Walk stepStates and group consecutive ones that share a group
}
```

**Step 3: Visual treatment for parallel run states**

Show parallel step states in a horizontal row with the same fan-out/fan-in connector pattern used in the editor, but read-only. Add a subtle "parallel" indicator.

**Step 4: Test in the app**

Run: `pnpm dev`
- Create an automation with a parallel group
- Run it
- Check the run history shows parallel steps side-by-side
- Retry-from-step still works for individual steps in a group

**Step 5: Commit**

```bash
git add src/renderer/src/components/automations/AutomationDetail.tsx
git commit -m "feat(automations): parallel step states in run history view"
```

---

### Task 9: Final type fixes and integration testing

**Files:**
- Possibly modify: `src/main/ipc/automations.ts`, `src/renderer/src/store/slices/automations.ts`, `src/renderer/src/store/slices/automation-runs.ts`

**Step 1: Run full typechecker**

Run: `pnpm tc`

Fix any remaining type errors. The most likely spots:
- IPC handlers that pass `automation.steps` to functions expecting `Step[]`
- Store slices that type `steps` as `Step[]`
- Any file that does `automation.steps[i]` positional access (needs to account for groups)

**Step 2: Run full test suite**

Run: `pnpm test`

Fix any failures. Pay attention to:
- `chain-editor-modal-state.test.ts` — may need updates for `StepOrGroup[]`
- `service.test.ts` — should pass without changes
- Integration tests like `three-step-chain-integration.test.ts`

**Step 3: Run the app end-to-end**

Run: `pnpm dev`

Test the full flow:
1. Create new automation
2. Add 3 steps: create-worktree, then parallel [run-prompt, run-command], then update-linear-issue
3. Verify template variables: run-prompt and run-command can both reference `{{steps.create-worktree-1.worktreeId}}`
4. Verify run-prompt and run-command CANNOT reference each other
5. Verify update-linear-issue CAN reference both parallel steps' outputs
6. Save → reopen → structure preserved
7. Run Now → watch the run: parallel steps show as running simultaneously
8. Verify run completes correctly

**Step 4: Commit**

```bash
git add -A
git commit -m "feat(automations): final type fixes for parallel steps"
```
