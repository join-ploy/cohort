# Parallel Steps in Automations

## Problem

Automation chains execute steps sequentially. Some workflows have independent steps that could run concurrently (e.g. running prompts on two worktrees, or creating a worktree while updating a Linear issue). Today the only option is serial execution, which wastes time when steps don't depend on each other.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Data model | Nested array (`StepOrGroup = Step \| Step[]`) | Self-describing, zero new types, `Array.isArray` discriminates, existing data is valid without migration |
| Failure mode | Wait-for-all, then decide | Simplest executor logic, avoids partial-cancel complexity in runners |
| UI layout | Horizontal row for parallel siblings | Vertical = sequence, horizontal = parallel — natural reading direction |
| Group creation | "+" button on right edge + drag beside | Two complementary affordances: discoverable button + powerful drag |

## Data Model

### Type change

```ts
// New union type
export type StepOrGroup = Step | Step[]

// Automation.steps changes from Step[] to StepOrGroup[]
// ChainDraft.steps changes from Step[] to StepOrGroup[]
```

Example: `[stepA, [stepB, stepC], stepD]` means run A, then B+C in parallel (wait for both), then D.

### Migration

None. Existing persisted `Step[]` is already valid `StepOrGroup[]` — a `Step` object is never an array, so the discriminator works on legacy data.

### StepRunState

The flat `StepRunState[]` on `AutomationRun` stays flat. When the executor reaches a parallel group, it appends one `StepRunState` per sibling (all `running`). Multiple entries with `status: 'running'` is the signal that a parallel group is in progress.

## Chain Executor

### Tick logic

`tickOnce` changes to handle two shapes at each position in `StepOrGroup[]`:

**Single step** (unchanged): one runner, one tick, advance when terminal.

**Parallel group** (`Step[]`): When reached, append a `StepRunState` for every sibling (all `running`). On each tick, poll every non-terminal runner in the group. Return `needs-more-time` if any sibling is still running. When all are terminal, the group is done.

### Failure policy

Wait-for-all: if sibling B fails while C is running, C continues. Once all siblings are terminal, check if any sibling with `onFailure: 'halt'` failed. If so, the run halts (`run.status = 'failed'`). If all failures have `onFailure: 'continue'`, the chain proceeds.

### Context merging

Each parallel sibling's `contextPatch` merges into `run.context` when that sibling finishes. Deep-merge on the `steps` sub-object (same as today). Since parallel siblings have distinct step IDs, their `steps.<id>` patches don't collide.

### Loop safety

`maxIterations` changes from `steps.length * 2 + 1` to total flat step count * 2 + 1 (summing group sizes).

### Finalization

`finalizeRun` already iterates `stepStates` looking for halt-policy failures. The only change is that `automation.steps[i]` lookup needs to account for groups — use a flat-step-to-index mapping instead of positional indexing.

## Editor UI

### Layout

```
     ┌─────────────┐
     │   Step A     │
     └──────┬──────┘
            │
   ┌────────┼────────┐
   │        │        │
┌──┴───┐ ┌─┴────┐   │
│Step B│ │Step C│  [+]
└──┬───┘ └──┬───┘
   │        │
   └────────┼────────┘
            │
     ┌──────┴──────┐
     │   Step D     │
     └─────────────┘
```

Solo steps render full-width. Parallel siblings sit side-by-side in a horizontal row with equal widths and a small gap. A `[+]` button appears to the right of the last card in each row (solo or group).

### Connector lines

CSS pseudo-elements: vertical line between sequential items, horizontal fan-out/fan-in for groups. Decorative only.

### Creating parallel groups

1. **"+" button**: On a solo step, wraps it into `[existingStep, newStep]`. On an existing group, appends a new sibling. Opens the step-kind picker, same as the existing "Add step" control.

2. **Drag beside**: When dragging a step near the left/right edge of another step (not above/below), a vertical drop indicator appears. Dropping creates or extends a parallel group.

3. **Drag out**: Dragging a step from a parallel group to above/below (outside the group) removes it. If one sibling remains, the group auto-unwraps to a solo step.

### dnd-kit structure

The outer `SortableContext` uses `verticalListSortingStrategy` over the top-level `StepOrGroup[]` items. Each parallel group gets a nested `SortableContext` with `horizontalListSortingStrategy`. The `handleDragEnd` inspects whether the drop target is within a group or between groups.

### Step card width

Solo: full width (`max-w-3xl`). Parallel: equal share of the row with `min-w-[280px]`. At 3+ siblings, the row allows horizontal scroll.

## Editor State

### Helper functions

New functions in `chain-editor-state.ts`:

- **`flattenSteps(steps: StepOrGroup[]): Step[]`** — Flattens groups into a single array. Used for validation, variable resolution, ID generation, and anywhere the current code iterates `draft.steps`.

- **`groupStepAt(steps: StepOrGroup[], index: number, newStep: Step): StepOrGroup[]`** — Wraps the solo step at top-level `index` into a parallel group with `newStep`, or appends `newStep` to an existing group at that index.

- **`ungroupStep(steps: StepOrGroup[], groupIndex: number, innerIndex: number): StepOrGroup[]`** — Pulls a step out of a group. Auto-unwraps to solo step if one sibling remains.

- **`reorderWithinGroup(steps: StepOrGroup[], groupIndex: number, fromInner: number, toInner: number): StepOrGroup[]`** — Reorder siblings within a parallel group.

### Rename/rewrite

`renameStepWithRewrites` uses `flattenSteps` internally instead of iterating the top-level array. The regex rewrite logic is unchanged.

### Future-reference detection

All siblings in a parallel group share the same logical position. A step referencing a sibling within the same group is a future-reference violation (the output isn't available yet — they run concurrently). A step after the group can reference any sibling.

### Variable availability

- **Step inside a parallel group**: Sees outputs from steps before the group. Does NOT see sibling outputs.
- **Step after a parallel group**: Sees all siblings' outputs.
- Current `getAvailableVariablesAtStep` updated to use position-aware logic on `StepOrGroup[]`.

## Files to Change

### Shared types
- `src/shared/automations-types.ts` — Add `StepOrGroup` type, change `Automation.steps` and related types

### Main process (executor)
- `src/main/automations/chain-executor.ts` — Handle parallel groups in `tick`/`tickOnce`, update `finalizeRun`
- `src/main/automations/service.ts` — Update any flat step iteration to use `flattenSteps`

### Renderer (editor)
- `src/renderer/src/lib/chain-editor-state.ts` — New helpers (`flattenSteps`, `groupStepAt`, `ungroupStep`, `reorderWithinGroup`), update existing functions
- `src/renderer/src/components/automations/editor/ChainEditorModal.tsx` — Nested DndContext structure, horizontal group layout, "+" button on step rows, drag-to-parallelize logic
- `src/renderer/src/components/automations/editor/StepCardChrome.tsx` — Adapt width for parallel context
- `src/renderer/src/components/automations/editor/ChainEditorStepCardRouter.tsx` — Handle group rendering
- `src/renderer/src/components/automations/editor/AvailableVariablesPanel.tsx` — Position-aware variable filtering

### Renderer (run detail)
- `src/renderer/src/components/automations/AutomationDetail.tsx` — Render parallel step states in run history

### IPC / persistence
- `src/main/ipc/automations.ts` — Type updates (transparent, JSON handles nested arrays)
- `src/renderer/src/store/slices/automations.ts` — Type updates

### Validation
- `src/renderer/src/lib/template-dry-run.ts` — Use `flattenSteps` for template validation
- `src/shared/automation-step-schemas.ts` — No change (per-step schemas are shape-agnostic)
