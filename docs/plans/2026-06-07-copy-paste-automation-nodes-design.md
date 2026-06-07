# Copy & Paste Automation Nodes — Design

Date: 2026-06-07

## Goal

Let users copy an automation node (step) and paste it via any "add node"
affordance. The pasted node carries the exact same values as the original; any
validation errors it introduces block saving exactly as they do today.

## Decisions

- **Copy trigger**: right-click the node's **header bar only** (kind badge /
  step-id / drag-handle row) → "Copy node". The body's text inputs keep their
  native right-click menu, so text editing is unaffected.
- **Paste trigger**: right-click any "add node" affordance → "Paste node".
- **Pasted id**: keep the original id verbatim. Pasting into the same chain
  yields a duplicate-id validation error, which correctly blocks save — matching
  the existing "validation errors mean it can't be saved" behavior.
- **Clipboard scope**: the real OS clipboard, as JSON. Works across windows and
  app sessions. Routed through the existing Electron clipboard IPC
  (`window.api.ui.readClipboardText` / `writeClipboardText`) — no renderer
  `navigator.clipboard` (focus/permission quirks in modals) and no new IPC.
- **Secrets**: cleared at copy time. Never write real or masked secret values to
  the OS clipboard.

## Clipboard format

A tagged envelope so paste can distinguish an Orca node from arbitrary text:

```ts
{ kind: 'orca/automation-step', version: 1, step: Step }
```

New pure module `src/renderer/src/lib/chain-editor-clipboard.ts`:

- `clearStepSecrets(step): Step` — deep-copies the step and blanks secret values.
- `serializeStepForClipboard(step): string` — clears secrets, wraps in the
  envelope, `JSON.stringify`.
- `parseStepFromClipboard(text): Step | null` — `JSON.parse` in try/catch;
  validates `kind`/`version`, that `step.kind` is a known `StepKind`, and that
  `id` / `config` / `onFailure` / `timeoutSeconds` are well-formed. Returns
  `null` on anything malformed.

## Secret clearing

Only `http-request` configs carry secrets. `clearStepSecrets`, on a deep copy:

- `config.request.headers[]` / `query[]` → `value = ''` where `secret === true`
- `config.request.body` → `''` where `bodySecret === true`

Everything else (incl. `connectionId`, `sampleResponse`, `fields`, `itemsPath`)
copies verbatim. A blank required secret surfaces as a normal validation issue. A
`connectionId` whose connection is absent on paste is already covered by the
existing connection-existence validation.

## Copy flow

- `StepCardChrome` gains an `onCopy` prop. Its header bar is wrapped in a shadcn
  `ContextMenu` with one item, "Copy node".
- The modal passes `copyStep(stepId)`: find the step, `serializeStepForClipboard`,
  `window.api.ui.writeClipboardText(...)`, then a "Node copied" toast.

## Paste flow

Both add affordances wrap their trigger in a shadcn `ContextMenu` with a single
"Paste node" item. Left-click still opens the existing kind dropdown; right-click
opens "Paste node".

- `AddStepControl` (bottom) → paste appends to the top-level chain (mirrors
  `addStep`).
- `AddParallelButton` (per step) → paste adds into that step's parallel group via
  `groupStepAt` (mirrors `addParallelStep`).

The modal's `pasteStep(position)`:

1. `await window.api.ui.readClipboardText()` → `parseStepFromClipboard`.
2. `null` → toast "No automation node on the clipboard"; no-op.
3. Else insert the parsed step verbatim (same id; secrets already cleared on the
   copy side), `setDirty(true)`, toast "Node pasted".

"Paste node" is always enabled; validity is checked on click (robust against the
async clipboard read).

## Testing (TDD)

Unit tests for `chain-editor-clipboard.ts`:

- round-trips a non-http step preserving id and all values;
- secret header / query / body values cleared on copy; non-secret values kept;
- `parseStepFromClipboard` returns `null` for bad JSON, wrong envelope, unknown
  kind, and missing fields.

Verify with `pnpm tc:node`, `pnpm tc:web`, and targeted vitest.

## Out of scope

- Keyboard shortcuts (⌘C/⌘V) and node selection state.
- Rewriting `{{steps.<id>.*}}` template references on paste — kept verbatim;
  dangling references surface through existing validation.
- Persisting a clipboard across machines beyond what the OS clipboard provides.
