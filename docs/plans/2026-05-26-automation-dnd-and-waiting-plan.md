# Automation: Drag-to-Group & Agent Input Waiting — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add drag-to-group for automation steps and pause-on-agent-input instead of failing.

**Architecture:** Feature 1 wires `useDroppable` onto the existing `AddParallelButton` and extends `handleDragEnd` to detect drops on `parallel-drop-*` targets. Feature 2 adds `'waiting'` to `StepRunStatus` and `AutomationRunStatus`, changes the runners to return `needs-more-time` with `status: 'waiting'` instead of failing, and pauses the timeout timer while waiting.

**Tech Stack:** React, @dnd-kit/core (`useDroppable`), @dnd-kit/sortable, Vitest, Electron main-process runners.

---

### Task 1: Add `'waiting'` to shared types

**Files:**
- Modify: `src/shared/automations-types.ts:7-24` (AutomationRunStatus) and `:368` (StepRunStatus)

**Step 1: Add `'waiting'` to `StepRunStatus`**

In `src/shared/automations-types.ts:368`, change:
```typescript
export type StepRunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'timed-out'
```
to:
```typescript
export type StepRunStatus = 'pending' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'skipped' | 'timed-out'
```

**Step 2: Add `'waiting'` to `AutomationRunStatus`**

In `src/shared/automations-types.ts:7-24`, add `| 'waiting'` after `| 'running'`:
```typescript
export type AutomationRunStatus =
  | 'pending'
  | 'dispatching'
  | 'dispatched'
  | 'running'
  | 'waiting'
  | 'failed'
  ...
```

**Step 3: Run typecheck**

Run: `pnpm tc`
Expected: Type errors in files that exhaustively match on these types (AutomationDetail, automation-page-parts, etc.) — that's expected and will be fixed in later tasks.

**Step 4: Commit**

```
feat: add 'waiting' status to StepRunStatus and AutomationRunStatus
```

---

### Task 2: Update UI to handle `'waiting'` status

**Files:**
- Modify: `src/renderer/src/components/automations/AutomationDetail.tsx:174-181` (STEP_STATUS_BADGE_CLASS)
- Modify: `src/renderer/src/components/automations/AutomationDetail.tsx:70-71` (RESTARTABLE_STATUSES)
- Modify: `src/renderer/src/components/automations/AutomationDetail.tsx:631` (canRetry guard)
- Modify: `src/renderer/src/components/automations/AutomationDetail.tsx:913` (running indicator)
- Modify: `src/renderer/src/components/automations/automation-page-parts.tsx:55-101` (status variant + label)

**Step 1: Add `waiting` to `STEP_STATUS_BADGE_CLASS`**

After the `running` entry at line 176, add:
```typescript
waiting: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
```

**Step 2: Add `'waiting'` to run status label and variant**

In `automation-page-parts.tsx`, `getAutomationRunStatusVariant`:
Add before the `return 'dot'` fallback:
```typescript
if (status === 'waiting') {
  return 'dot'
}
```

In `getAutomationRunStatusLabel`, add case:
```typescript
case 'waiting':
  return 'Waiting'
```

**Step 3: Update running indicator guard**

At line 913, the condition checks `run.status === 'running' || run.status === 'pending' || run.status === 'dispatching'`. Add `|| run.status === 'waiting'` so the spinner/indicator also shows for waiting runs.

**Step 4: Update canRetry guard**

At line 631, `step.status !== 'running' && step.status !== 'pending'` — add `&& step.status !== 'waiting'` so waiting steps can't be retried mid-wait.

**Step 5: Run typecheck**

Run: `pnpm tc`
Expected: PASS (or only errors from main-process files, fixed in next tasks)

**Step 6: Commit**

```
feat: display 'waiting' status in automation UI
```

---

### Task 3: Update chain-executor to propagate `'waiting'` to run status

**Files:**
- Modify: `src/main/automations/chain-executor.ts:20-25` (TERMINAL_STEP_STATUSES)
- Modify: `src/main/automations/chain-executor.ts` (tickOnce — propagate waiting to run)

**Step 1: Confirm `'waiting'` is NOT in `TERMINAL_STEP_STATUSES`**

The existing array at line 20-25 is `['succeeded', 'failed', 'skipped', 'timed-out']`. `'waiting'` is absent, so `isTerminal()` already returns `false` for it — no change needed.

**Step 2: Propagate `'waiting'` to run-level status**

In `tickOnce`, after the runner result is applied to `state.status` (line 195) and before the `outcome === 'failed'` halt check (line 207), add run-level waiting propagation. Find the `needs-more-time` return path (the implicit fall-through at line 221 where `result.outcome` is not `done` or `failed`). Before `this.deps.persistRun(run)` at line 220, add:

```typescript
// When any step is waiting for human input, surface that on the run so
// the UI can show "Waiting" instead of "Running".
const anyWaiting = run.stepStates!.some((s) => s.status === 'waiting')
run.status = anyWaiting ? 'waiting' : 'running'
```

Do the same in `tickParallelGroup` before its persist call — after the group siblings are ticked and before checking group completion, set:
```typescript
const anyWaiting = run.stepStates!.some((s) => s.status === 'waiting')
run.status = anyWaiting ? 'waiting' : 'running'
```

Also ensure: when a waiting step transitions back to `running` (agent resumes), the run status reverts from `'waiting'` to `'running'` — the `anyWaiting` check handles this automatically.

**Step 3: Run typecheck**

Run: `pnpm tc:node`
Expected: PASS

**Step 4: Commit**

```
feat: propagate step-level 'waiting' to run-level status
```

---

### Task 4: Update run-prompt-runner to pause on agent input

**Files:**
- Modify: `src/main/automations/runners/run-prompt-runner.ts:72-101` (Tracker type)
- Modify: `src/main/automations/runners/run-prompt-runner.ts:270-304` (tick polling)

**Step 1: Write failing test**

In existing test file for run-prompt-runner (or create `src/main/automations/runners/run-prompt-runner.test.ts`), add:
```typescript
it('returns waiting instead of failing when agent is blocked', async () => {
  // Set up tracker with an open pane, then set agent status to 'blocked'
  // First tick to create tracker (agent working)
  // Second tick with agent 'blocked' → should return needs-more-time + waiting
  // Third tick with agent 'working' → should return needs-more-time + running
})
```

**Step 2: Add `waitStartedAt` to Tracker type**

At `src/main/automations/runners/run-prompt-runner.ts`, add to the `Tracker` type (after `unsubscribe` at line 100):
```typescript
/** Wall-clock when the agent entered waiting/blocked state. Used to pause
 *  the timeout timer — elapsed wait time is added to openedAt when the
 *  agent resumes so only active execution counts toward timeoutSeconds. */
waitStartedAt: number | null
```

Initialize it to `null` where trackers are created (in the startup phase).

**Step 3: Replace fail-on-blocked with pause-on-blocked**

At lines 295-304, replace:
```typescript
if (status.state === 'blocked' || status.state === 'waiting') {
  return {
    outcome: 'failed',
    status: 'failed',
    error: `Agent needs human input (${status.state}). Chain halted.`
  }
}
```
with:
```typescript
if (status.state === 'blocked' || status.state === 'waiting') {
  if (tracker.waitStartedAt == null) {
    tracker.waitStartedAt = now
  }
  return { outcome: 'needs-more-time', status: 'waiting' }
}

// Agent resumed — adjust timeout anchor to exclude wait duration.
if (tracker.waitStartedAt != null) {
  tracker.openedAt += now - tracker.waitStartedAt
  tracker.waitStartedAt = null
}
```

**Step 4: Run tests**

Run: `pnpm test -- --testPathPattern run-prompt-runner`
Expected: PASS

**Step 5: Commit**

```
feat: pause automation on agent input instead of failing (run-prompt)
```

---

### Task 5: Update run-command-runner to pause on agent input

**Files:**
- Modify: `src/main/automations/runners/run-command-runner.ts:66-101` (Tracker type)
- Modify: `src/main/automations/runners/run-command-runner.ts:196-202` (pre-send wait gate)
- Modify: `src/main/automations/runners/run-command-runner.ts:352-361` (polling branch)

**Step 1: Add `waitStartedAt` to Tracker type**

At line 100 (after `workingSeen`), add:
```typescript
waitStartedAt: number | null
```

Initialize to `null` where trackers are created.

**Step 2: Replace fail-on-blocked in pre-send wait gate (lines 196-202)**

Replace:
```typescript
if (preStatus?.state === 'blocked' || preStatus?.state === 'waiting') {
  return {
    outcome: 'failed',
    status: 'failed',
    error: `Agent needs human input (${preStatus.state}). Chain halted.`
  }
}
```
with:
```typescript
if (preStatus?.state === 'blocked' || preStatus?.state === 'waiting') {
  return { outcome: 'needs-more-time', status: 'waiting' }
}
```

(No timeout adjustment needed here — this is the pre-send phase before the tracker's `openedAt` is set.)

**Step 3: Replace fail-on-blocked in polling branch (lines 352-361)**

Replace:
```typescript
if (agentStatus?.state === 'blocked' || agentStatus?.state === 'waiting') {
  this.cleanup(tracker)
  return {
    outcome: 'failed',
    status: 'failed',
    error: `Agent needs human input (${agentStatus.state}). Chain halted.`
  }
}
```
with:
```typescript
if (agentStatus?.state === 'blocked' || agentStatus?.state === 'waiting') {
  if (tracker.waitStartedAt == null) {
    tracker.waitStartedAt = now
  }
  return { outcome: 'needs-more-time', status: 'waiting' }
}

if (tracker.waitStartedAt != null) {
  tracker.openedAt += now - tracker.waitStartedAt
  tracker.waitStartedAt = null
}
```

Note: remove the `this.cleanup(tracker)` call — we're NOT done with the tracker, the step is still alive.

**Step 4: Run typecheck and tests**

Run: `pnpm tc:node && pnpm test`
Expected: PASS

**Step 5: Commit**

```
feat: pause automation on agent input instead of failing (run-command)
```

---

### Task 6: Make AddParallelButton a drop target

**Files:**
- Modify: `src/renderer/src/components/automations/editor/ChainEditorModal.tsx:758-799` (AddParallelButton)

**Step 1: Add `useDroppable` to AddParallelButton**

Update the props type to accept a droppable id:
```typescript
type AddParallelButtonProps = {
  open: boolean
  kinds: StepKind[]
  droppableId: string
  onToggle: () => void
  onPick: (kind: StepKind) => void
}
```

Import `useDroppable` from `@dnd-kit/core` (already imported for `DndContext`).

Inside the component, add:
```typescript
const { setNodeRef, isOver } = useDroppable({ id: props.droppableId })
```

Wrap the outer `div` with `ref={setNodeRef}` and add a visual indicator when `isOver`:
```typescript
<div
  ref={setNodeRef}
  className={cn(
    'relative flex shrink-0 items-center',
    isOver && 'rounded-md ring-2 ring-ring'
  )}
>
```

**Step 2: Pass `droppableId` from parent**

In ChainEditorModal, where `AddParallelButton` is rendered for solo steps (around line 528) and inside groups (around line 496), pass `droppableId={`parallel-drop-${topIndex}`}`.

**Step 3: Run typecheck**

Run: `pnpm tc:web`
Expected: PASS

**Step 4: Commit**

```
feat: make AddParallelButton a droppable target
```

---

### Task 7: Handle drop-to-group in handleDragEnd

**Files:**
- Modify: `src/renderer/src/components/automations/editor/ChainEditorModal.tsx:355-369` (handleDragEnd)
- Modify: `src/renderer/src/lib/chain-editor-state.ts` (add `moveStepIntoGroup` helper)

**Step 1: Write failing test**

In `ChainEditorModal.dnd.test.tsx`, add a test that fires a synthetic `DragEndEvent` with `over.id` = `'parallel-drop-1'` and `active.id` = step id at index 0. Assert that after the event, the draft's steps contain a parallel group with both steps.

**Step 2: Add `moveStepIntoGroup` to chain-editor-state.ts**

```typescript
/**
 * Removes the step at `fromIndex` and merges it into the step/group at
 * `targetIndex`. If targetIndex is a solo step, wraps both into a new
 * group. If it's already a group, appends the moved step.
 * Adjusts targetIndex when fromIndex < targetIndex (splice shifts left).
 */
export function moveStepIntoGroup(
  steps: StepOrGroup[],
  fromIndex: number,
  targetIndex: number
): StepOrGroup[] {
  const next = steps.slice()
  const [moved] = next.splice(fromIndex, 1)
  // Adjust target after splice
  const adjustedTarget = fromIndex < targetIndex ? targetIndex - 1 : targetIndex
  const movedStep = Array.isArray(moved) ? moved : [moved]
  const existing = next[adjustedTarget]
  next[adjustedTarget] = Array.isArray(existing)
    ? [...existing, ...movedStep]
    : [existing, ...movedStep]
  return next
}
```

**Step 3: Update handleDragEnd**

Replace the `handleDragEnd` callback (lines 355-369) with:
```typescript
const handleDragEnd = React.useCallback(
  (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) {
      return
    }
    const overId = String(over.id)

    if (overId.startsWith('parallel-drop-')) {
      const targetTopIndex = Number(overId.slice('parallel-drop-'.length))
      const fromIndex = topLevelIds.indexOf(String(active.id))
      if (fromIndex === -1 || fromIndex === targetTopIndex) {
        return
      }
      setDraft((current) => ({
        ...current,
        steps: moveStepIntoGroup(current.steps, fromIndex, targetTopIndex)
      }))
      setDirty(true)
      return
    }

    const fromIndex = topLevelIds.indexOf(String(active.id))
    const toIndex = topLevelIds.indexOf(overId)
    if (fromIndex === -1 || toIndex === -1) {
      return
    }
    moveStep(fromIndex, toIndex)
  },
  [topLevelIds, moveStep]
)
```

**Step 4: Run tests**

Run: `pnpm test -- --testPathPattern ChainEditorModal`
Expected: PASS

**Step 5: Commit**

```
feat: drag existing steps onto + button to create parallel groups
```

---

### Task 8: Final typecheck and integration test

**Step 1: Full typecheck**

Run: `pnpm tc`
Expected: PASS — no type errors across all three projects

**Step 2: Run full test suite**

Run: `pnpm test`
Expected: PASS

**Step 3: Commit any remaining fixes**

```
chore: fix any remaining type errors from waiting/dnd features
```
