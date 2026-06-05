# Variable picker descriptions — design

## Goal

Show a short, human-readable description under each variable in the automation
variable picker so authors understand what each variable means without leaving
the editor. The same variable list also appears in the read-only "Available
variables" footer panel; both surfaces get descriptions and stay consistent.

## Surfaces affected

Both consume the same pipeline (`buildPaths` → `PathEntry[]` → row render):

- `src/renderer/src/components/automations/editor/VariablePickerPopover.tsx`
  — the interactive insertion dropdown (`{{`-triggered).
- `src/renderer/src/components/automations/editor/AvailableVariablesPanel.tsx`
  — the read-only footer summary.

## Decisions

- **Layout:** stacked second line. Top line unchanged (mono `path` on the left,
  `type` on the right); a muted second line carries the description. The line is
  omitted when no description exists.
- **Storage:** a separate, renderer-only descriptions module. Descriptions are
  UI documentation, not runtime schema, so the runtime schema, template engine,
  and dry-run validation stay untouched. Lowest-risk option.
- **Step precision:** descriptions for step outputs are keyed by `StepKind` +
  leaf (not just leaf), so kind-specific copy is possible
  (e.g. `run-prompt.outputTail` vs `run-command.outputTail`).

## Data flow changes

The kind of each step is needed at description-lookup time, but
`AvailableVariables.steps` only carries `stepId → schema` — it dropped the kind.
Thread it through additively:

1. `AvailableVariables` (in `template-dry-run.ts`): add optional
   `stepKinds?: Record<string, StepKind>`. Optional + additive, so
   `dryRunTemplate` and existing producers/tests are unaffected.
2. `getAvailableVariablesAtStep` (in `chain-editor-modal-state.ts`): populate
   `stepKinds` — it already iterates earlier steps and knows `s.kind`.
3. `PathEntry` (in `available-variables-tree.ts`): add optional `kind?: StepKind`.
   `buildPaths` stamps it on `steps`-namespace entries from `available.stepKinds`.

## New module: `variable-descriptions.ts`

`src/renderer/src/lib/variable-descriptions.ts`, exporting
`describeVariable(entry: PathEntry): string | undefined`. Backed by three maps:

- **Full-path map** for `automation.*`, `trigger.*` (incl. the Linear overlay),
  and `group.id` / `group.parentPath` — these paths are stable.
- **Group-member leaf map** for `group.members.<folder>.*` — the folder segment
  is dynamic, so key on the leaf. Detected via the `group.members.` prefix.
- **Step map** `Record<StepKind, Record<leaf, string>>` — looked up by
  `entry.kind` + `entry.leaf` for `steps`-namespace entries.

Lookup order in `describeVariable`:
1. `namespace === 'steps'` → step map by `kind` + `leaf`.
2. `namespace === 'group'` and path starts with `group.members.` → member leaf map.
3. Otherwise → full-path map by `entry.path`.

Returns `undefined` when nothing matches; callers skip the second line.

## Rendering

Each `renderRow` becomes a vertical stack:

- Line 1 (unchanged): `flex items-center justify-between`, mono `path` +
  `text-[10px] text-muted-foreground` `type`.
- Line 2 (new, conditional): `describeVariable(entry)` in
  `text-[11px] text-muted-foreground` using the sans family (Geist) — per the
  styleguide, mono is reserved for literal/path text; prose uses sans.

`VariablePickerPopover` keeps its `<button>` row (with highlight state);
`AvailableVariablesPanel` keeps its `<div>` row. Both call `describeVariable`.

## Testing (TDD)

- New `variable-descriptions.test.ts` — **completeness guard**: build an
  `AvailableVariables` covering every namespace, the Linear overlay, a group with
  a member, and all 7 step kinds; run `buildPaths`; assert `describeVariable`
  returns a non-empty string for every entry. Catches "added a variable, forgot
  the description" drift.
- Extend `available-variables-tree.test.ts` — assert `buildPaths` stamps `kind`
  onto `steps`-namespace entries when `stepKinds` is supplied.

## Out of scope

- No change to the runtime schema, template engine, or `dryRunTemplate`.
- No tooltip/hover behavior — descriptions are always visible.
