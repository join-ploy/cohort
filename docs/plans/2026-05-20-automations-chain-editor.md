# Chain Editor (Phase 5 + 7) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the full-screen chain editor with `{{` variable autocomplete so users can compose, edit, and run multi-step chain-shape automations in-app without hand-editing `orca-data.json`.

**Architecture:** Schema-driven design. Each step kind exports an output schema; the trigger exports a schema; `getAvailableVariables(stepIndex)` composes them into a typed tree. The variable picker reads the tree; the dry-run validator walks `{{...}}` paths against it on every keystroke (debounced). The editor's state is a local "draft" that commits via the existing `window.api.automations.save()` IPC — no main-process changes needed. Builds on Phase 1 + 2's chain engine.

**Tech Stack:** React + TypeScript (renderer); shadcn primitives (Dialog, Button, Input, Textarea, Select, Switch, Badge, Popover); zustand store (for cross-component reads of repo / settings data); vitest + `renderToStaticMarkup` for component tests; existing chain-engine IPC.

**Design doc:** `docs/plans/2026-05-20-automations-chain-editor-design.md`

**Prior phases (this builds on):**
- Phase 1: types, template resolver, runners, chain executor, agent-status registry, IPC, run-detail UI.
- Phase 2: full step palette (create-worktree, wait-for-setup, run-prompt, run-command).

---

## Task ordering + dependencies

1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11

Tasks 4 and 5 (TemplateInput + VariablePickerPopover) are tightly coupled; the popover ships in Task 5. Step cards (Task 7) use the chrome + TemplateInput; the modal shell (Task 8) composes everything.

---

## Pre-task: Confirm shadcn primitives

Before Task 1, verify the renderer already imports `Dialog`, `Popover`, `Switch`, and friends from `src/renderer/src/components/ui/`. If `Dialog` doesn't support full-bleed, decide between (a) custom modal wrapper, (b) `Sheet` primitive, or (c) extending `Dialog` styles. This is a quick research check; don't write code yet.

Run: `ls src/renderer/src/components/ui/ | grep -E "^(dialog|popover|switch|select|textarea|input|button|badge)\.tsx$"`

If `popover.tsx` is missing — `@dnd-kit` is missing — etc., note it; install with `pnpm add` only what's truly missing.

---

## Task 1: Output schemas + manual trigger schema

**Files:**
- Create: `src/shared/automation-step-schemas.ts`
- Create: `src/shared/automation-step-schemas.test.ts`

**Goal:** Each step kind exports a `getOutputSchema(): Record<string, 'string' | 'number' | 'boolean'>`. The manual trigger exports its own schema. These drive both the variable picker and the dry-run validator.

**Step 1: Failing test**

```ts
import { describe, it, expect, expectTypeOf } from 'vitest'
import {
  getOutputSchemaForKind,
  MANUAL_TRIGGER_SCHEMA,
  CREATE_WORKTREE_OUTPUT_SCHEMA,
  WAIT_FOR_SETUP_OUTPUT_SCHEMA,
  RUN_PROMPT_OUTPUT_SCHEMA,
  RUN_COMMAND_OUTPUT_SCHEMA,
  type SchemaLeafType
} from './automation-step-schemas'

describe('automation step schemas', () => {
  it('SchemaLeafType is the union of supported primitives', () => {
    expectTypeOf<SchemaLeafType>().toEqualTypeOf<'string' | 'number' | 'boolean'>()
  })

  it('create-worktree produces worktreeId/path/branch as strings', () => {
    expect(CREATE_WORKTREE_OUTPUT_SCHEMA).toEqual({
      worktreeId: 'string',
      path: 'string',
      branch: 'string'
    })
  })

  it('wait-for-setup produces exitCode + durationMs as numbers', () => {
    expect(WAIT_FOR_SETUP_OUTPUT_SCHEMA).toEqual({
      exitCode: 'number',
      durationMs: 'number'
    })
  })

  it('run-prompt produces paneKey (string) + durationMs (number)', () => {
    expect(RUN_PROMPT_OUTPUT_SCHEMA).toEqual({
      paneKey: 'string',
      durationMs: 'number'
    })
  })

  it('run-command produces ptyId/paneKey + exitCode/durationMs', () => {
    expect(RUN_COMMAND_OUTPUT_SCHEMA).toEqual({
      ptyId: 'string',
      paneKey: 'string',
      exitCode: 'number',
      durationMs: 'number'
    })
  })

  it('MANUAL_TRIGGER_SCHEMA has firedAt (number) + actorEmail (string)', () => {
    expect(MANUAL_TRIGGER_SCHEMA).toEqual({
      firedAt: 'number',
      actorEmail: 'string'
    })
  })

  it('getOutputSchemaForKind returns the schema for each kind', () => {
    expect(getOutputSchemaForKind('create-worktree')).toBe(CREATE_WORKTREE_OUTPUT_SCHEMA)
    expect(getOutputSchemaForKind('wait-for-setup')).toBe(WAIT_FOR_SETUP_OUTPUT_SCHEMA)
    expect(getOutputSchemaForKind('run-prompt')).toBe(RUN_PROMPT_OUTPUT_SCHEMA)
    expect(getOutputSchemaForKind('run-command')).toBe(RUN_COMMAND_OUTPUT_SCHEMA)
  })
})
```

**Step 2: Run test, expect FAIL** — module not found.

**Step 3: Implement**

```ts
// src/shared/automation-step-schemas.ts
import type { StepKind } from './automations-types'

export type SchemaLeafType = 'string' | 'number' | 'boolean'
export type OutputSchema = Record<string, SchemaLeafType>

export const CREATE_WORKTREE_OUTPUT_SCHEMA: OutputSchema = {
  worktreeId: 'string',
  path: 'string',
  branch: 'string'
}

export const WAIT_FOR_SETUP_OUTPUT_SCHEMA: OutputSchema = {
  exitCode: 'number',
  durationMs: 'number'
}

export const RUN_PROMPT_OUTPUT_SCHEMA: OutputSchema = {
  paneKey: 'string',
  durationMs: 'number'
}

export const RUN_COMMAND_OUTPUT_SCHEMA: OutputSchema = {
  ptyId: 'string',
  paneKey: 'string',
  exitCode: 'number',
  durationMs: 'number'
}

export const MANUAL_TRIGGER_SCHEMA: OutputSchema = {
  firedAt: 'number',
  actorEmail: 'string'
}

const SCHEMA_BY_KIND: Record<StepKind, OutputSchema> = {
  'create-worktree': CREATE_WORKTREE_OUTPUT_SCHEMA,
  'wait-for-setup': WAIT_FOR_SETUP_OUTPUT_SCHEMA,
  'run-prompt': RUN_PROMPT_OUTPUT_SCHEMA,
  'run-command': RUN_COMMAND_OUTPUT_SCHEMA
}

export function getOutputSchemaForKind(kind: StepKind): OutputSchema {
  return SCHEMA_BY_KIND[kind]
}
```

**Step 4: Verify** — tests pass; `pnpm tc` clean (only pre-existing failure).

**Step 5: Commit** — `feat(automations): output schemas for chain step kinds + manual trigger`. NO co-author trailer.

---

## Task 2: Dry-run template validator

**Files:**
- Create: `src/renderer/src/lib/template-dry-run.ts`
- Create: `src/renderer/src/lib/template-dry-run.test.ts`

**Goal:** Pure function that walks template `{{...}}` tokens against a schema (not against values) and returns errors. Used live in the editor for every template field.

**Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest'
import {
  dryRunTemplate,
  type AvailableVariables,
  type TemplateError
} from './template-dry-run'

const SCHEMA: AvailableVariables = {
  automation: {
    projectId: 'string',
    workspaceId: 'string'
  },
  trigger: {
    firedAt: 'number',
    actorEmail: 'string'
  },
  steps: {
    'create-worktree-1': {
      worktreeId: 'string',
      path: 'string',
      branch: 'string'
    }
  }
}

describe('dryRunTemplate', () => {
  it('returns no errors for a template with all valid references', () => {
    expect(dryRunTemplate('hello {{trigger.actorEmail}}', SCHEMA)).toEqual([])
    expect(
      dryRunTemplate('wt={{steps.create-worktree-1.worktreeId}}', SCHEMA)
    ).toEqual([])
  })

  it('returns no errors for templates with no tokens', () => {
    expect(dryRunTemplate('plain text', SCHEMA)).toEqual([])
  })

  it('flags unknown top-level paths', () => {
    const errors = dryRunTemplate('{{foo}}', SCHEMA)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ path: 'foo', code: 'unknown-path' })
  })

  it('flags unknown nested paths', () => {
    const errors = dryRunTemplate('{{automation.foo}}', SCHEMA)
    expect(errors[0]).toMatchObject({ path: 'automation.foo', code: 'unknown-path' })
  })

  it('flags unknown step output keys', () => {
    const errors = dryRunTemplate('{{steps.create-worktree-1.foo}}', SCHEMA)
    expect(errors[0]).toMatchObject({
      path: 'steps.create-worktree-1.foo',
      code: 'unknown-path'
    })
  })

  it('flags references to a step not in scope', () => {
    const errors = dryRunTemplate('{{steps.run-prompt-2.paneKey}}', SCHEMA)
    expect(errors[0]).toMatchObject({
      path: 'steps.run-prompt-2.paneKey',
      code: 'unknown-step'
    })
  })

  it('flags empty tokens', () => {
    const errors = dryRunTemplate('hello {{}} world', SCHEMA)
    expect(errors[0]).toMatchObject({ code: 'empty-token' })
  })

  it('flags whitespace-only tokens with the same error', () => {
    const errors = dryRunTemplate('{{   }}', SCHEMA)
    expect(errors[0]).toMatchObject({ code: 'empty-token' })
  })

  it('returns ALL errors, not just the first', () => {
    const errors = dryRunTemplate('{{foo}} {{bar.baz}}', SCHEMA)
    expect(errors).toHaveLength(2)
  })

  it('respects the escape sequence — \\{{ is a literal', () => {
    expect(dryRunTemplate('\\{{not-a-token}}', SCHEMA)).toEqual([])
  })
})
```

**Step 2: Run, expect FAIL.**

**Step 3: Implement**

```ts
// src/renderer/src/lib/template-dry-run.ts
import type { SchemaLeafType, OutputSchema } from '../../../shared/automation-step-schemas'

export type AvailableVariables = {
  automation: OutputSchema
  trigger: OutputSchema
  steps: Record<string, OutputSchema>
}

export type TemplateErrorCode = 'unknown-path' | 'unknown-step' | 'empty-token'

export type TemplateError = {
  path: string
  code: TemplateErrorCode
  message: string
}

const TOKEN = /\\\{\{|\{\{([^}\n]*)\}\}/g

export function dryRunTemplate(
  input: string,
  available: AvailableVariables
): TemplateError[] {
  const errors: TemplateError[] = []
  let match: RegExpExecArray | null
  const re = new RegExp(TOKEN.source, 'g')
  while ((match = re.exec(input)) !== null) {
    if (match[0] === '\\{{') continue
    const raw = match[1] ?? ''
    const trimmed = raw.trim()
    if (trimmed === '') {
      errors.push({
        path: '',
        code: 'empty-token',
        message: 'Empty template token.'
      })
      continue
    }
    const err = validatePath(trimmed, available)
    if (err) errors.push(err)
  }
  return errors
}

function validatePath(
  path: string,
  available: AvailableVariables
): TemplateError | null {
  const parts = path.split('.')
  const head = parts[0]
  if (head === 'automation') {
    return walkLeaf(parts.slice(1), available.automation, path)
  }
  if (head === 'trigger') {
    return walkLeaf(parts.slice(1), available.trigger, path)
  }
  if (head === 'steps') {
    if (parts.length < 2) {
      return { path, code: 'unknown-path', message: `${path} is incomplete.` }
    }
    const stepId = parts[1]
    const stepSchema = available.steps[stepId]
    if (!stepSchema) {
      return { path, code: 'unknown-step', message: `Step '${stepId}' is not in scope.` }
    }
    return walkLeaf(parts.slice(2), stepSchema, path)
  }
  return { path, code: 'unknown-path', message: `Unknown top-level path '${head}'.` }
}

function walkLeaf(
  parts: string[],
  schema: OutputSchema,
  originalPath: string
): TemplateError | null {
  if (parts.length !== 1) {
    return {
      path: originalPath,
      code: 'unknown-path',
      message: `${originalPath} is not a leaf path.`
    }
  }
  const key = parts[0]
  if (!(key in schema)) {
    return {
      path: originalPath,
      code: 'unknown-path',
      message: `${originalPath} is not a known field.`
    }
  }
  return null
}
```

**Step 4: Verify + Step 5: Commit** — `feat(automations): dry-run template validator for editor`.

---

## Task 3: Draft state reducer + step-id helpers

**Files:**
- Create: `src/renderer/src/lib/chain-editor-state.ts`
- Create: `src/renderer/src/lib/chain-editor-state.test.ts`

**Goal:** Pure helpers for the draft reducer. Default ID generation, dedupe, reorder, rename + rewrite-references, reorder-blocks-future-ref guard. The reducer itself is tiny once these helpers exist.

**Step 1: Failing test (key cases)**

```ts
import { describe, it, expect } from 'vitest'
import {
  generateDefaultStepId,
  isValidStepId,
  renameStepWithRewrites,
  reorderSteps,
  detectFutureReferences,
  type ChainDraft
} from './chain-editor-state'
import type { Step } from '../../../shared/automations-types'

const baseDraft: ChainDraft = {
  id: 'a1',
  name: 'test',
  projectId: 'p',
  trigger: { kind: 'manual' },
  enabled: true,
  steps: []
}

describe('generateDefaultStepId', () => {
  it('uses kind + counter starting at 1 in an empty chain', () => {
    expect(generateDefaultStepId('create-worktree', [])).toBe('create-worktree-1')
  })

  it('increments past existing ids of the same kind', () => {
    const steps: Step[] = [
      { id: 'create-worktree-1', kind: 'create-worktree', config: {} as never, onFailure: 'halt', timeoutSeconds: null },
      { id: 'create-worktree-2', kind: 'create-worktree', config: {} as never, onFailure: 'halt', timeoutSeconds: null }
    ]
    expect(generateDefaultStepId('create-worktree', steps)).toBe('create-worktree-3')
  })

  it('does not collide with renamed step ids of the same prefix', () => {
    const steps: Step[] = [
      { id: 'create-worktree-1', kind: 'run-prompt', config: {} as never, onFailure: 'halt', timeoutSeconds: null }
    ]
    expect(generateDefaultStepId('create-worktree', steps)).toBe('create-worktree-2')
  })
})

describe('isValidStepId', () => {
  it('accepts kebab-case', () => {
    expect(isValidStepId('create-worktree-1')).toBe(true)
    expect(isValidStepId('foo')).toBe(true)
  })
  it('rejects empty / whitespace / spaces / underscores / uppercase', () => {
    expect(isValidStepId('')).toBe(false)
    expect(isValidStepId(' foo')).toBe(false)
    expect(isValidStepId('foo bar')).toBe(false)
    expect(isValidStepId('foo_bar')).toBe(false)
    expect(isValidStepId('FooBar')).toBe(false)
  })
})

describe('renameStepWithRewrites', () => {
  it('rewrites template references in downstream steps', () => {
    const steps: Step[] = [
      { id: 'cw1', kind: 'create-worktree', config: { baseBranch: 'main', branchName: 'b', displayName: 'd', linkLinearIssue: false } as never, onFailure: 'halt', timeoutSeconds: null },
      { id: 'rp1', kind: 'run-prompt', config: { worktreeRef: '{{steps.cw1.worktreeId}}', agentId: 'claude', prompt: 'p', doneDebounceSeconds: 15 } as never, onFailure: 'halt', timeoutSeconds: null }
    ]
    const next = renameStepWithRewrites(steps, 'cw1', 'create-wt')
    expect(next[0].id).toBe('create-wt')
    expect((next[1].config as { worktreeRef: string }).worktreeRef).toBe('{{steps.create-wt.worktreeId}}')
  })
  it('throws if the new id is invalid', () => {
    expect(() => renameStepWithRewrites([], 'cw1', 'Bad ID')).toThrow(/invalid/i)
  })
  it('throws if the new id collides with another step', () => {
    const steps: Step[] = [
      { id: 'a', kind: 'create-worktree', config: {} as never, onFailure: 'halt', timeoutSeconds: null },
      { id: 'b', kind: 'run-prompt', config: {} as never, onFailure: 'halt', timeoutSeconds: null }
    ]
    expect(() => renameStepWithRewrites(steps, 'a', 'b')).toThrow(/already in use/i)
  })
})

describe('reorderSteps', () => {
  it('moves a step from one index to another', () => {
    const steps: Step[] = [
      { id: 'a', kind: 'create-worktree', config: {} as never, onFailure: 'halt', timeoutSeconds: null },
      { id: 'b', kind: 'run-prompt', config: {} as never, onFailure: 'halt', timeoutSeconds: null },
      { id: 'c', kind: 'run-command', config: {} as never, onFailure: 'halt', timeoutSeconds: null }
    ]
    expect(reorderSteps(steps, 0, 2).map((s) => s.id)).toEqual(['b', 'c', 'a'])
    expect(reorderSteps(steps, 2, 0).map((s) => s.id)).toEqual(['c', 'a', 'b'])
  })
})

describe('detectFutureReferences', () => {
  it('returns empty for a chain with no future references', () => {
    const steps: Step[] = [
      { id: 'a', kind: 'create-worktree', config: { baseBranch: '{{trigger.actorEmail}}', branchName: 'b', displayName: 'd', linkLinearIssue: false } as never, onFailure: 'halt', timeoutSeconds: null },
      { id: 'b', kind: 'run-prompt', config: { worktreeRef: '{{steps.a.worktreeId}}', agentId: 'claude', prompt: '', doneDebounceSeconds: 15 } as never, onFailure: 'halt', timeoutSeconds: null }
    ]
    expect(detectFutureReferences(steps)).toEqual([])
  })

  it('finds a step that references a later step', () => {
    const steps: Step[] = [
      { id: 'a', kind: 'create-worktree', config: { baseBranch: '{{steps.b.worktreeId}}', branchName: '', displayName: '', linkLinearIssue: false } as never, onFailure: 'halt', timeoutSeconds: null },
      { id: 'b', kind: 'create-worktree', config: {} as never, onFailure: 'halt', timeoutSeconds: null }
    ]
    const violations = detectFutureReferences(steps)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ fromStepId: 'a', toStepId: 'b' })
  })
})
```

**Step 2: Run, expect FAIL.**

**Step 3: Implement** — straight-line code per the test cases. Key helpers:

- `generateDefaultStepId(kind, steps)`: find max counter for `${kind}-<n>` prefix; return `${kind}-${max+1}`.
- `isValidStepId(id)`: regex `/^[a-z0-9][a-z0-9-]*$/` and non-empty.
- `renameStepWithRewrites(steps, oldId, newId)`: validate; scan all step configs for `{{steps.<oldId>.*}}` and replace.
- `reorderSteps(steps, fromIdx, toIdx)`: pure array splice.
- `detectFutureReferences(steps)`: for each step at index i, scan its config strings for `{{steps.<id>.*}}` references where `<id>` belongs to a step at index >= i+1; collect violations.

You'll need a small `walkStepConfigStrings(config, visit)` helper that handles each kind's template fields. Defining this once and reusing across `renameStepWithRewrites` and `detectFutureReferences` is DRY.

**Step 4: Verify + Step 5: Commit** — `feat(automations): chain editor draft state helpers`.

---

## Task 4: TemplateInput component (without picker yet)

**Files:**
- Create: `src/renderer/src/components/automations/editor/TemplateInput.tsx`
- Create: `src/renderer/src/components/automations/editor/TemplateInput.test.tsx`

**Goal:** A controlled `<input>`/`<textarea>` component that accepts a template string, runs `dryRunTemplate` on every change (debounced ~150ms), and surfaces errors. No autocomplete popover yet — that lands in Task 5.

**Component API:**

```ts
type TemplateInputProps = {
  value: string
  onChange: (value: string) => void
  available: AvailableVariables
  placeholder?: string
  multiline?: boolean
  monospace?: boolean
  // Used for ref-picker shortcut (out of scope here; appears in Task 7d/7e)
  className?: string
}
```

Renders the input with:
- Monospace font (always; templates are code).
- A small `{ }` icon in the top-right of the input.
- A red ring + tooltip when `dryRunTemplate` returns at least one error.

**Step 1: Component test** (renderToStaticMarkup pattern):

```ts
it('renders the value as-is', async () => {
  const markup = renderToStaticMarkup(
    <TemplateInput value="hello" onChange={() => {}} available={EMPTY_AVAIL} />
  )
  expect(markup).toContain('value="hello"')
})

it('shows a red ring marker when the value has an unresolved reference', async () => {
  const markup = renderToStaticMarkup(
    <TemplateInput value="{{missing}}" onChange={() => {}} available={EMPTY_AVAIL} />
  )
  expect(markup).toMatch(/ring-rose|border-rose/)
})

it('does not show error styling for plain text', async () => {
  const markup = renderToStaticMarkup(
    <TemplateInput value="plain" onChange={() => {}} available={EMPTY_AVAIL} />
  )
  expect(markup).not.toMatch(/ring-rose|border-rose/)
})
```

**Step 2: Run, expect FAIL.**

**Step 3: Implement** — `<input>` or `<textarea>` (based on `multiline` prop), wired to `dryRunTemplate` via `useMemo` (no debounce needed for the dry-run computation itself — it's pure). Apply Tailwind classes to indicate error state. For the popover trigger detection: track caret position via `selectionStart`; when the user types `{{`, *set* a `pickerOpen` boolean. The popover itself lands in Task 5; for now just track the state and expose it via a temporary `data-picker-open` attribute (tested later).

**Step 4: Verify + Step 5: Commit** — `feat(automations): TemplateInput with live dry-run validation`.

---

## Task 5: VariablePickerPopover + integrate with TemplateInput

**Files:**
- Create: `src/renderer/src/components/automations/editor/VariablePickerPopover.tsx`
- Create: `src/renderer/src/components/automations/editor/VariablePickerPopover.test.tsx`
- Modify: `src/renderer/src/components/automations/editor/TemplateInput.tsx` (mount the popover)

**Goal:** When the user types `{{` in a TemplateInput, a popover opens at the cursor showing available variables grouped by namespace (automation / trigger / steps). Arrow keys navigate, Enter inserts `{{full.path}}`, Esc closes.

**Component API:**

```ts
type VariablePickerPopoverProps = {
  open: boolean
  anchor: HTMLElement | null
  available: AvailableVariables
  onSelect: (fullPath: string) => void  // selected path WITHOUT braces
  onClose: () => void
}
```

**Step 1: Component test cases:**

1. Renders nothing when `open: false`.
2. When `open: true`, renders one section per namespace (automation/trigger/steps) and one leaf per field.
3. Each leaf shows the type (`string`/`number`/`boolean`).
4. Clicking a leaf calls `onSelect` with the full path.

**Step 2: Run, expect FAIL.**

**Step 3: Implement** — shadcn `Popover` anchored to the input. Body is a flat list (no fancy tree; vertical scroll handles many entries). Keyboard navigation via `useEffect` listening to `keydown` on `document` while open. On Enter: call `onSelect(currentHighlightedPath)` and `onClose()`. Path format: `automation.projectId`, `trigger.firedAt`, `steps.create-worktree-1.worktreeId`, etc. — NO braces.

**Step 4: Integrate with TemplateInput** — when the user types `{{` (detected via the input's `onChange` and caret position), open the popover anchored to the input. On select, splice the chosen path into the value: replace the just-typed `{{` with `{{<path>}}` at the caret position. On close, leave the input as-is.

Add a test to `TemplateInput.test.tsx`:

```ts
it('triggers picker open after the user types {{', async () => {
  // Render with `useState` wrapper; simulate typing '{{'; expect picker open.
})
```

**Step 5: Verify + Step 6: Commit** — `feat(automations): variable picker popover wired to TemplateInput`.

---

## Task 6: AvailableVariablesPanel (collapsible footer)

**Files:**
- Create: `src/renderer/src/components/automations/editor/AvailableVariablesPanel.tsx`
- Create: `src/renderer/src/components/automations/editor/AvailableVariablesPanel.test.tsx`

**Goal:** A collapsible panel rendered below the step list in the modal. Shows the available variables at the END of the current chain (i.e., what the next-added step could reference). Pure display — no interaction.

**API:**

```ts
type AvailableVariablesPanelProps = {
  available: AvailableVariables
}
```

**Step 1: Test cases:**

1. Renders a count (e.g., "4 variables") when collapsed.
2. When expanded, renders one row per leaf with type.

**Step 2: FAIL → Step 3: Implement → Step 4: Verify → Step 5: Commit.**

Simple component. Uses shadcn `Collapsible` or `Accordion` (whichever exists).

`feat(automations): AvailableVariablesPanel for editor`.

---

## Task 7: StepCardChrome + four step cards

**Files:**
- Create: `src/renderer/src/components/automations/editor/StepCardChrome.tsx`
- Create: `src/renderer/src/components/automations/editor/CreateWorktreeStepCard.tsx`
- Create: `src/renderer/src/components/automations/editor/WaitForSetupStepCard.tsx`
- Create: `src/renderer/src/components/automations/editor/RunPromptStepCard.tsx`
- Create: `src/renderer/src/components/automations/editor/RunCommandStepCard.tsx`
- Tests: one `*.test.tsx` per file, focused on "renders the right fields for the right config."

**Goal:** All four cards share a chrome (header, footer, drag handle, delete). Each card's body renders kind-specific fields via `TemplateInput`, selects, switches, etc.

### StepCardChrome

API:

```ts
type StepCardChromeProps = {
  step: Step
  stepIndex: number
  onIdChange: (newId: string) => void
  onConfigChange: (config: StepConfig) => void
  onOnFailureChange: (val: 'halt' | 'continue') => void
  onTimeoutChange: (val: number | null) => void
  onDelete: () => void
  available: AvailableVariables
  dragHandleProps?: SyntheticEventHandlers // for @dnd-kit when ready
  children: React.ReactNode  // the per-kind body
}
```

Renders:
- Top row: drag handle | kind icon + kind badge | step ID inline-editable | delete button.
- Middle: `{children}` (the per-kind body).
- Footer: `onFailure` segmented control + `timeoutSeconds` input.

**TDD per part** — start with chrome, then each card body.

### Per-kind cards (each ~50–80 lines)

`CreateWorktreeStepCard` body:

```tsx
<TemplateInput label="Base branch" value={config.baseBranch} onChange={...} available={...} />
<TemplateInput label="Branch name" value={config.branchName} onChange={...} available={...} />
<TemplateInput label="Display name" value={config.displayName} onChange={...} available={...} />
<SwitchRow label="Link Linear issue" checked={config.linkLinearIssue} onChange={...} />
```

`WaitForSetupStepCard` body:

```tsx
<TemplateInput label="Worktree ref" value={config.worktreeRef} onChange={...} available={...} />
<SwitchRow label="Require success" checked={config.requireSuccess} onChange={...} />
```

`RunPromptStepCard` body:

```tsx
<TemplateInput label="Worktree ref" value={config.worktreeRef} onChange={...} available={...} />
<Select label="Agent" value={config.agentId} options={['claude', 'codex', 'droid']} onChange={...} />
<TemplateInput label="Prompt" value={config.prompt} onChange={...} available={...} multiline />
<NumberInput label="Done debounce seconds" value={config.doneDebounceSeconds} onChange={...} />
```

`RunCommandStepCard` body:

```tsx
<TemplateInput label="Worktree ref" value={config.worktreeRef} onChange={...} available={...} />
<Segmented label="Source" options={['review', 'create-pr', 'custom']} value={config.source} onChange={...} />
{config.source === 'custom'
  ? <TemplateInput label="Command" value={config.customCommand ?? ''} onChange={...} available={...} />
  : <Select label="Command" value={config.commandId} options={loadCommandsFromSettings(config.source)} onChange={...} />}
```

Each card test asserts: renders the right input labels, passes through `value` correctly, invokes `onConfigChange` on input change.

**Five tasks worth of TDD** (chrome + 4 cards), but commit them in batches: chrome first, then create-worktree + wait-for-setup, then run-prompt + run-command.

Commits:
- `feat(automations): StepCardChrome shared header/footer for step cards`
- `feat(automations): create-worktree + wait-for-setup step card bodies`
- `feat(automations): run-prompt + run-command step card bodies`

---

## Task 8: ChainEditorModal — the shell

**Files:**
- Create: `src/renderer/src/components/automations/editor/ChainEditorModal.tsx`
- Create: `src/renderer/src/components/automations/editor/ChainEditorModal.test.tsx`

**Goal:** Compose everything into the full-screen modal. Local draft state, save/cancel/run-now actions, add-step popover, reorder via drag handles.

**Component API:**

```ts
type ChainEditorModalProps = {
  open: boolean
  automation: Automation | null  // null = "New"
  onClose: () => void
  onSave: (automation: Automation) => Promise<void>
  onRunNow: (automationId: string) => void
}
```

State (local to the modal):
- `draft: ChainDraft` — seeded from `automation` or a blank.
- `dirty: boolean` — true if any field changed from the seed.
- `errors: TemplateError[]` — flattened across all template fields.

Renders:
- Header: name `Input` + enabled `Switch` + read-only "Trigger: Manual" `Badge` + Run Now `Button`.
- Body: vertical list of step cards (Task 7), `+` insert buttons between (and after the last), `AvailableVariablesPanel` collapsible at the bottom.
- Footer: error count + Cancel + Save.

**Step 1: Test cases:**

1. Renders nothing when `open: false`.
2. Renders an empty body when `automation === null`.
3. Clicking `+` opens a kind-picker; selecting a kind appends a step with default config + auto-generated id.
4. Editing a template field updates the draft.
5. Save calls `onSave` with a chain-shape `Automation` (Phase 1 fields + new step list).
6. Save is disabled when there are template errors.
7. Cancel calls `onClose` (and triggers a "discard?" confirm when dirty — implementer detail, use `window.confirm` or a shadcn `AlertDialog`).
8. Renaming a step id rewrites template references in downstream steps (use `renameStepWithRewrites` from Task 3).
9. Reordering blocks when it would create a future reference (use `detectFutureReferences` from Task 3).

**Step 2: FAIL → Step 3: Implement → Step 4: Verify → Step 5: Commit** — `feat(automations): ChainEditorModal composing the chain editor shell`.

---

## Task 9: Integrate into AutomationsPage; delete legacy editor

**Files:**
- Modify: `src/renderer/src/components/automations/AutomationsPage.tsx`
- Delete: `src/renderer/src/components/automations/AutomationEditorDialog.tsx`
- Delete: any `AutomationEditorDialog.*.test.*` files
- Modify/delete: any other file that imports `AutomationEditorDialog`

**Goal:** Replace the legacy editor mount with `ChainEditorModal`. Delete unused files.

**Step 1: Update `AutomationsPage.tsx`:**

Find the existing usage of `AutomationEditorDialog` and replace with:

```tsx
import { ChainEditorModal } from './editor/ChainEditorModal'

// ... in the page component:
const [editorState, setEditorState] = useState<{
  open: boolean
  automation: Automation | null
}>({ open: false, automation: null })

// On "+ New Automation":
setEditorState({ open: true, automation: null })

// On per-row Edit:
setEditorState({ open: true, automation: row })

// Render:
<ChainEditorModal
  open={editorState.open}
  automation={editorState.automation}
  onClose={() => setEditorState({ open: false, automation: null })}
  onSave={async (a) => {
    await window.api.automations.save(a)
    setEditorState({ open: false, automation: null })
  }}
  onRunNow={(id) => window.api.automations.runNow(id)}
/>
```

**Step 2: Delete `AutomationEditorDialog.tsx`.**

**Step 3: Delete any orphaned tests.** Find them with: `grep -rln "AutomationEditorDialog" src/`.

**Step 4: Run `pnpm tc` + `pnpm tc:web`.** Fix any imports.

**Step 5: Run the full automations test suite. Expect:**
- `AutomationEditorDialog.*` tests gone.
- Other automation tests green.

**Step 6: Commit** — `feat(automations): mount ChainEditorModal + delete legacy editor`.

---

## Task 10: End-to-end editor integration test

**Files:**
- Create: `src/renderer/src/components/automations/editor/ChainEditorModal.e2e.test.tsx`

**Goal:** Drive the editor as a user would, in a Testing Library-style flow, asserting the final Automation shape sent to `onSave` matches what the chain engine expects.

**Step 1: Test:**

```ts
it('composes a 3-step chain (create-worktree → wait-for-setup → run-prompt) via the editor', async () => {
  const onSave = vi.fn().mockResolvedValue(undefined)
  const onClose = vi.fn()
  const onRunNow = vi.fn()

  render(<ChainEditorModal open={true} automation={null} onClose={onClose} onSave={onSave} onRunNow={onRunNow} />)

  // Set the name
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My chain' } })

  // Add create-worktree step
  fireEvent.click(screen.getByRole('button', { name: '+' })) // bottom +
  fireEvent.click(screen.getByText('create-worktree'))

  // Fill in baseBranch and branchName
  const baseBranchInputs = screen.getAllByPlaceholderText(/Base branch/i)
  fireEvent.change(baseBranchInputs[0], { target: { value: 'main' } })
  // ... etc for branchName, displayName

  // Add wait-for-setup step
  fireEvent.click(screen.getByRole('button', { name: '+' }))
  fireEvent.click(screen.getByText('wait-for-setup'))
  fireEvent.change(screen.getAllByPlaceholderText(/Worktree ref/i)[0], {
    target: { value: '{{steps.create-worktree-1.worktreeId}}' }
  })

  // Add run-prompt step
  fireEvent.click(screen.getByRole('button', { name: '+' }))
  fireEvent.click(screen.getByText('run-prompt'))
  // ... fill in worktreeRef + prompt

  // Save
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))

  await waitFor(() => expect(onSave).toHaveBeenCalled())
  const saved = onSave.mock.calls[0][0]
  expect(saved.steps).toHaveLength(3)
  expect(saved.steps[0]).toMatchObject({ kind: 'create-worktree' })
  expect(saved.steps[1]).toMatchObject({ kind: 'wait-for-setup' })
  expect(saved.steps[2]).toMatchObject({ kind: 'run-prompt' })
})
```

You may need to add `@testing-library/react` if it isn't already a dev dep. Verify before installing.

**Step 2: FAIL → Step 3: Get it green → Step 4: Commit** — `test(automations): end-to-end chain editor flow`.

---

## Task 11: Verification + design-doc update

Run `pnpm test` and `pnpm tc`. Expected: only the documented pre-existing failures plus zero new ones.

If the `AutomationDetail.step-states.test.tsx` button-alias failure (flagged at the end of Phase 2) is in scope to fix, fix it. Otherwise note in the follow-ups.

Append a Phase 5+7 status entry to `docs/plans/2026-05-19-automations-chain-engine-design.md` with the deliverables list and any follow-ups.

Commit: `docs(automations): mark chain editor (Phase 5+7) complete`.

---

## Risks revisited

1. **`{{` popover positioning** — the trickiest UI bit. If it gets hairy, fallback: a "Variables" button next to each TemplateInput that opens a side popover. Less in-flow but simpler.
2. **Live validation cost** — debouncing is in place; if the editor feels laggy with 10+ template fields, push validation into a `useDeferredValue`.
3. **Reorder + rename safeguards** are the most likely place for "I clicked save and lost my templates" bugs. The unit tests for those helpers are intentionally comprehensive.
4. **shadcn Dialog full-bleed** — may need a custom modal wrapper. Verify early in Task 8.
5. **`@dnd-kit` may not be installed** — if not, fall back to up/down arrow buttons for v1. Drag is polish.

## What's NOT in Phase 5+7 (explicit)

- Chain templates ("start from canonical" button).
- Schedule trigger UI (Phase 3).
- Linear trigger UI (Phase 4).
- Variable picker for non-template fields (e.g., `agentId`).
- Accessibility audit beyond shadcn baselines.
- In-editor delete (existing list-view affordance is enough).
