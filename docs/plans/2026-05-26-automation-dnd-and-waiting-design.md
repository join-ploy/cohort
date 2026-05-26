# Automation: Drag-to-Group & Agent Input Waiting

## Feature 1: Drag-to-Group

### Problem
The chain editor supports parallel step groups, but the only way to create them is via the "Add parallel step" button which creates a *new* step. There's no way to group two *existing* steps into a parallel group by dragging.

### Design
The existing `AddParallelButton` (`+` next to each step) becomes a drop target. When dragging a step, hovering over a `+` button highlights it. Dropping moves the dragged step out of its current position and groups it with the adjacent step.

### Implementation

**AddParallelButton changes:**
- Add `useDroppable` from dnd-kit with id `parallel-drop-{topIndex}`
- When `isOver && active`, show accent border/background as visual feedback

**ChainEditorModal.handleDragEnd changes:**
- If `over.id` starts with `parallel-drop-`, extract target `topIndex`
- Remove dragged step from its current position
- Call `groupStepAt` to merge it with the step at the target index
- Set dirty flag

**Edge cases:**
- Dragging a step onto its own `+` button → no-op
- Future-reference validation runs automatically via existing `computeAllErrors`
- Steps inside parallel groups have `disableDrag` so only top-level solo steps are draggable

---

## Feature 2: Agent Input Waiting

### Problem
When an agent is waiting for user input (`blocked` or `waiting` state) during automation execution, the runner immediately fails with "Agent needs human input. Chain halted." This should instead pause execution and resume after the user provides input.

### Design

**New status: `waiting`**
- Added to `StepRunStatus`: `'pending' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'skipped' | 'timed-out'`
- Added to `AutomationRunStatus`: `'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'`
- `waiting` is NOT terminal — the executor keeps ticking the step

**Runner behavior (run-prompt-runner, run-command-runner):**
- When agent state is `blocked`/`waiting`: return `{ outcome: 'needs-more-time', status: 'waiting' }`
- Track `waitStartedAt` on the runner's tracker
- When agent transitions back to `working`/`done`: compute elapsed wait time, shift `openedAt` forward by that amount (pausing the timeout timer)
- Clear `waitStartedAt`

**Executor changes (chain-executor.ts):**
- `waiting` is not in `TERMINAL_STEP_STATUSES` — step stays alive
- When any step in the run has status `waiting`, the run-level status becomes `waiting`
- Run-level `waiting` status drives UI display

**UI changes (AutomationDetail):**
- Step card shows "Waiting for input" badge when status is `waiting`
- Run header shows "Waiting" instead of "Running"

**Timeout behavior:**
- Timeout timer pauses while in `waiting` state
- Only active execution time counts toward the step's `timeoutSeconds`
