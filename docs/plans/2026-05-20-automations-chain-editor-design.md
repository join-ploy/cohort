# Chain Editor (Phase 5 + 7) — Design

**Status:** Approved (brainstorming → design); ready for implementation plan.
**Date:** 2026-05-20

## Goal

Replace `AutomationEditorDialog` with a full-screen modal chain editor so users can compose, edit, and run multi-step chain-shape automations without hand-editing `orca-data.json`. Includes the variable-picker autocomplete (`{{` → typed suggestions) originally scoped as Phase 7.

This is the surface that finally makes Phase 1 + Phase 2's chain engine usable in-app.

## Scope and what disappears

- `AutomationEditorDialog.tsx` is deleted. The new `ChainEditorModal` replaces it.
- All existing automations are already chain-shape in memory (Phase 1's `upgradeLegacyAutomation` runs on read), so the new editor only edits chain shape.
- Legacy fields (`prompt`, `agentId`, `workspaceMode`, `rrule`, `dtstart`, `timezone`, `missedRunGraceMinutes`) stay on the `Automation` row as dormant data. Phase 3 will resurrect them via a `schedule` trigger config. They do not appear in the editor UI.
- `AutomationsPage.tsx` mounts `ChainEditorModal` from its existing "+ New Automation" and per-row Edit affordances.
- Run Now lives in the editor footer (next to Save/Cancel) and stays in the list view.

## Out of scope (v1)

- Chain templates / "start from canonical Linear → PR" button.
- Trigger configuration UI for Schedule (Phase 3) or Linear (Phase 4). The editor shows a read-only "Trigger: Manual" pill as a placeholder slot.
- Variable picker for non-template fields (e.g., `agentId`). Pickers are template-text-only.
- Accessibility audit beyond shadcn baselines.
- Deletion UI inside the editor (existing list-view affordance is enough).

## Architecture overview

`ChainEditorModal` is a full-screen modal (built on shadcn `Dialog`, set to full-bleed, or `Sheet` if `Dialog` full-bleed is awkward — implementer judgment). It mounts from `AutomationsPage.tsx`. State is local to the modal — a "draft" automation that mirrors the persisted `Automation` shape and is committed via the existing `window.api.automations.save()` IPC.

The variable picker uses schema-driven discovery: each step kind exports a `getOutputSchema()` describing its produced variables and their types. The editor maintains a `getAvailableVariables(stepIndex)` selector that composes `automation.*`, `trigger.*`, and `steps.<prior-id>.*` from those schemas.

Validation is dry-run schema-walking (not value-walking) — every template field's `{{...}}` tokens are parsed and walked against the available-variables schema on every keystroke (debounced ~150ms). Save is disabled while any error is present.

The editor uses existing infrastructure:
- shadcn `Dialog`, `Button`, `Input`, `Textarea`, `Select`, `Switch`, `Badge` primitives.
- The existing `window.api.automations.save` / `runNow` IPC.
- The existing chain-engine runtime (Phase 1/2) — no main-process changes required.

## Data flow + state

Opening the editor seeds a local **draft** from the persisted automation row (or from a blank `{ name: '', trigger: { kind: 'manual' }, steps: [] }` for "New"). Mutations go through a small reducer.

Saving commits the draft via the existing IPC. Closing with unsaved changes shows a "Discard changes?" confirm.

### Step IDs

Auto-generated on add as `<kebab-case kind>-<counter>` (e.g., `create-worktree-1`, `run-prompt-2`). Inline-editable via a small icon next to the step header. Validation: kebab-case, unique within the chain, non-empty.

Renaming a step ID scans all template fields downstream and offers "rewrite N references to match" before committing.

### Adding a step

`+` button between cards (and after the last) opens a popover with the four kind options. Selecting a kind inserts a step at that position with default field values (e.g., new `run-prompt` defaults to `agentId: 'claude'`, `doneDebounceSeconds: 15`).

### Reordering

Drag handle on each card (using `@dnd-kit` if it's already a dep; otherwise lightweight up/down buttons — implementer decides). When a reorder would cause an upstream step to reference a downstream one, the operation is blocked with an inline warning.

## Layout

```
┌──────────────────────────────────────────────────────────────┐
│  [Name input        ]  [Enabled toggle]  [Trigger: Manual]  [Run Now]  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ ⋮⋮  ▸ [create-worktree-1]  [create-worktree]      ×    │  │
│  │  baseBranch   [main____________________]  { }          │  │
│  │  branchName   [{{trigger.title}}_______]  { }          │  │
│  │  displayName  [{{trigger.title}}_______]  { }          │  │
│  │  linkLinearIssue  ◯                                    │  │
│  │  onFailure: [Halt|Continue]  timeout: [____]s          │  │
│  └────────────────────────────────────────────────────────┘  │
│                          [+]                                 │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ ⋮⋮  ▸ [run-prompt-2]  [run-prompt]                ×    │  │
│  │  worktreeRef  [{{steps.create-worktree-1.worktreeId}}] │  │
│  │  agentId      [claude ▾]                                │  │
│  │  prompt       ┌──────────────────────────┐             │  │
│  │               │ Implement: {{trigger.tit │             │  │
│  │               └──────────────────────────┘             │  │
│  │  doneDebounceSeconds  [15]                              │  │
│  │  onFailure: [Halt|Continue]  timeout: [____]s          │  │
│  └────────────────────────────────────────────────────────┘  │
│                          [+]                                 │
│                                                              │
│  ▾ Available variables (4)                                  │
│    automation.projectId, automation.workspaceId,            │
│    trigger.firedAt, trigger.actorEmail                      │
├──────────────────────────────────────────────────────────────┤
│   3 issues                       [Cancel]   [Save]           │
└──────────────────────────────────────────────────────────────┘
```

### Per-kind config bodies

| Kind | Fields |
| --- | --- |
| `create-worktree` | `baseBranch` (template), `branchName` (template), `displayName` (template), `linkLinearIssue` (switch) |
| `wait-for-setup` | `worktreeRef` (template + ref-picker), `requireSuccess` (switch) |
| `run-prompt` | `worktreeRef`, `agentId` (select: claude/codex/droid known-good allowlist), `prompt` (multiline template), `doneDebounceSeconds` (number) |
| `run-command` | `worktreeRef`, `source` (segmented: Review/CreatePR/Custom), conditionally `commandId` (select from configured commands) or `customCommand` (template input) |

Template inputs render with monospace font, a `{ }` icon in the corner, and a yellow ring when they contain unresolved references.

The `worktreeRef` field also gets a "ref picker" shortcut button that lists prior `create-worktree` step outputs so the user doesn't have to remember the template path.

## Variable picker + validation

### Schema-driven discovery

Each step kind exports a `getOutputSchema()`:

```ts
export const CREATE_WORKTREE_OUTPUT_SCHEMA = {
  worktreeId: 'string',
  path: 'string',
  branch: 'string'
} as const

export const WAIT_FOR_SETUP_OUTPUT_SCHEMA = {
  exitCode: 'number',
  durationMs: 'number'
} as const

export const RUN_PROMPT_OUTPUT_SCHEMA = {
  paneKey: 'string',
  durationMs: 'number'
} as const

export const RUN_COMMAND_OUTPUT_SCHEMA = {
  ptyId: 'string',
  paneKey: 'string',
  exitCode: 'number',
  durationMs: 'number'
} as const
```

The trigger has a schema too. Phase 5 only knows `manual`:

```ts
export const MANUAL_TRIGGER_SCHEMA = {
  firedAt: 'number',
  actorEmail: 'string'
} as const
```

`getAvailableVariables(stepIndex)` composes `automation.*`, `trigger.*`, and `steps.<prior-id>.*` (only steps BEFORE `stepIndex`) into a single tree.

### Autocomplete UX

Typing `{{` in any template field opens a popover anchored at the cursor:

- Tree of paths from `getAvailableVariables(currentStepIndex)`.
- Each leaf shows its type and a brief description.
- Arrow keys navigate; Enter inserts `{{full.path}}` and closes the popover; `.` continues path narrowing; Esc closes.

### Live validation

Every template field runs through a dry-run resolver on every keystroke (debounced ~150ms). The resolver:

- Parses `{{...}}` tokens.
- Walks each token's path against the schema (not actual values).
- Returns errors: `unknown.path` → "Unknown variable"; `steps.future-step.x` → "Cannot reference a later step"; empty `{{}}` → "Empty token".

Errors surface as a red ring + tooltip on the offending field. The footer shows a summary count ("3 issues"); clicking it scrolls to the first error. Save is disabled while any error exists.

### Reorder + rename safeguards

- Reorder that would cause an upstream step to reference a downstream step is blocked with an inline warning.
- Renaming a step ID scans all template fields and offers "rewrite N references to match" before committing.

## Migration + testing

### Files deleted/rewritten

- Delete `src/renderer/src/components/automations/AutomationEditorDialog.tsx`.
- Delete any `AutomationEditorDialog.*.test.*` files (contracts were tied to legacy fields).
- Update `AutomationsPage.tsx` to mount `ChainEditorModal` in place of `AutomationEditorDialog`.

### Files added

- `src/renderer/src/components/automations/ChainEditorModal.tsx` — modal shell.
- `src/renderer/src/components/automations/step-cards/CreateWorktreeStepCard.tsx`
- `src/renderer/src/components/automations/step-cards/WaitForSetupStepCard.tsx`
- `src/renderer/src/components/automations/step-cards/RunPromptStepCard.tsx`
- `src/renderer/src/components/automations/step-cards/RunCommandStepCard.tsx`
- `src/renderer/src/components/automations/StepCardChrome.tsx` — shared header/footer for all kinds.
- `src/renderer/src/components/automations/TemplateInput.tsx` — `<input>` with `{{` autocomplete.
- `src/renderer/src/components/automations/VariablePickerPopover.tsx`.
- `src/renderer/src/components/automations/AvailableVariablesPanel.tsx`.
- `src/shared/automation-step-schemas.ts` — `getOutputSchema()` for each kind + manual trigger schema.
- `src/renderer/src/lib/template-dry-run.ts` — schema-walking validator.
- `src/renderer/src/lib/chain-editor-state.ts` — draft reducer + helpers (default-id generation, rename-reference rewrite).

### IPC

Unchanged. Editor uses existing `window.api.automations.save()` / `runNow()`.

### Testing strategy

1. **Pure-function tests** (highest correctness risk, cheapest):
   - `template-dry-run`: every error case from the validator section.
   - `chain-editor-state`: default-id generation, dedupe, rename-reference rewrite, reorder-blocks-future-ref.
   - `automation-step-schemas`: each schema exists and matches the runtime's output shape (cross-check via a small `produces<K>()` type-level test).

2. **Component tests** via `renderToStaticMarkup`:
   - Each step card renders its config fields.
   - The modal shell renders header + footer with the right buttons.
   - Validation errors render on bad templates.

3. **Integration test:** open the editor → add 3 steps with templates wiring `{{steps.cw1.worktreeId}}` between them → save → assert persisted automation matches the expected shape. The existing `run-now-chain-integration.test.ts` proves the engine runs; this test proves the editor produces what the engine expects.

4. **Manual smoke (final task):** create the canonical Linear → PR chain (with manual trigger), click Run Now, watch it execute step-by-step in the detail view.

## Risks

1. **`{{` popover positioning at cursor** is a known UI rabbit hole (input-vs-textarea, multiline, scrolling). Recommend a small spike with a known-good library (e.g., Floating UI) or extracting an existing autocomplete primitive from the codebase if there is one.
2. **Live validation cost.** Debounce keeps it cheap, but a chain with 10 templated fields × 150ms × N keystrokes can hit React reconciliation cost. If the editor feels laggy, push validation into a `useDeferredValue`/`useTransition` or off-thread.
3. **Reorder + rename safeguards** are complex enough to deserve their own test surface. They're the most likely place for "I clicked save and lost my templates" bugs.
4. **shadcn `Dialog` full-bleed** may not behave perfectly with the variable-picker popover (popovers inside dialogs can have z-index / focus-trap issues). Implementer should verify early.
