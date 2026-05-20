# Manual Linear/Worktree Trigger + Pane Reuse Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Three additive capabilities — Linear-ticket-aware Run Now, worktree picker at Run Now, and `paneRef` for `run-prompt` so review output can feed back into Claude's existing session. Plus the deferred `stdoutTail` capture for `run-command` that makes the pane-reuse story useful.

**Architecture:** All additive optional fields on existing types. Reuses existing Linear infrastructure (LinearClient, LinearIssue picker primitive in NewWorkspaceComposerCard). New IPC `sendPromptToPane` mirrors `openPromptPane`. `RunCommandRunner` gains a `subscribePtyData` dep + ring buffers for stdout/stderr capture.

**Tech Stack:** Same as prior phases — main-process TypeScript, renderer React + zustand + shadcn primitives, vitest + `renderToStaticMarkup` + `@testing-library/react`, existing PTY infra, existing Linear SDK + cache.

**Design doc:** `docs/plans/2026-05-20-automations-manual-payload-design.md`

**Prior phases:** Phase 1 (foundation), Phase 2 (step palette), Phase 5+7 (editor + variable picker).

---

## Task ordering

1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10

Tasks 6 (pickers), 7 (editor UX), and 8 (Run Now modal) form the UI block. Tasks 1–5 are the data/runtime foundation that the UI consumes.

---

## Pre-task: confirm picker reusability

Before Task 1, verify two assumptions:

**P1.** `NewWorkspaceComposerCard`'s Linear picker is extractable. Read `src/renderer/src/components/NewWorkspaceComposerCard.tsx` around the `onSmartLinearIssueSelect` prop. Identify:
- The picker UI component (likely a sub-component or inline JSX).
- Its data dependencies (which store selectors it reads, which IPC it calls).
- Whether extracting it into `LinearIssuePicker.tsx` is mechanical or invasive.

If extraction is invasive, the implementer can either (a) extract a smaller primitive (the search input + result list), or (b) build a fresh picker that calls the same store/IPC. Note the path chosen in the Task 6 commit message.

**P2.** PTY data events flow through an interceptable channel in main. Read `src/main/ipc/pty.ts` and find the data-dispatch site. We need a way to fan out PTY data to BOTH the renderer (existing flow) AND a new in-process subscriber (the `RunCommandRunner`). Identify the file:line where renderer broadcasts happen so Task 4 has a target.

---

## Task 1: Types + schemas + variable overlay

**Files:**
- Modify: `src/shared/automations-types.ts`
- Modify: `src/shared/automation-step-schemas.ts`
- Modify: `src/shared/automation-step-schemas.test.ts`
- Modify: `src/shared/automations-types.test.ts`
- Modify: `src/renderer/src/components/automations/editor/chain-editor-modal-state.ts` (the `getAvailableVariablesAtStep` helper)
- Modify: `src/renderer/src/lib/template-dry-run.test.ts` if new schema affects existing tests (probably doesn't — schemas are passed in)

**Goal:** All schema/type changes from the design land in one task. No runtime behavior changes yet — those come in Tasks 3-5.

### Step 1: Failing tests

**`automations-types.test.ts`** — add assertions:

```ts
import type {
  TriggerConfig,
  RunPromptConfig,
  RunCommandConfig,
  LinearIssuePayload
} from './automations-types'

describe('manual payload types', () => {
  it('TriggerConfig manual variant accepts the two optional booleans', () => {
    const t1: TriggerConfig = { kind: 'manual' }
    const t2: TriggerConfig = { kind: 'manual', acceptsLinearTicket: true }
    const t3: TriggerConfig = { kind: 'manual', acceptsWorktreeSelection: true }
    const t4: TriggerConfig = { kind: 'manual', acceptsLinearTicket: true, acceptsWorktreeSelection: true }
    expectTypeOf(t1).toMatchTypeOf<TriggerConfig>()
    expectTypeOf(t2).toMatchTypeOf<TriggerConfig>()
    expectTypeOf(t3).toMatchTypeOf<TriggerConfig>()
    expectTypeOf(t4).toMatchTypeOf<TriggerConfig>()
  })

  it('RunPromptConfig gains optional paneRef', () => {
    expectTypeOf<RunPromptConfig['paneRef']>().toEqualTypeOf<string | undefined>()
  })

  it('LinearIssuePayload has the documented fields', () => {
    expectTypeOf<LinearIssuePayload['id']>().toEqualTypeOf<string>()
    expectTypeOf<LinearIssuePayload['identifier']>().toEqualTypeOf<string>()
    expectTypeOf<LinearIssuePayload['title']>().toEqualTypeOf<string>()
    expectTypeOf<LinearIssuePayload['description']>().toEqualTypeOf<string>()
    expectTypeOf<LinearIssuePayload['url']>().toEqualTypeOf<string>()
    expectTypeOf<LinearIssuePayload['assigneeEmail']>().toEqualTypeOf<string>()
    expectTypeOf<LinearIssuePayload['stateName']>().toEqualTypeOf<string>()
    expectTypeOf<LinearIssuePayload['priority']>().toEqualTypeOf<number>()
  })
})
```

**`automation-step-schemas.test.ts`** — add assertions for the grown `RUN_COMMAND_OUTPUT_SCHEMA`:

```ts
it('run-command schema now includes stdoutTail + stderrTail', () => {
  expect(RUN_COMMAND_OUTPUT_SCHEMA).toEqual({
    paneKey: 'string',
    exitCode: 'number',
    durationMs: 'number',
    stdoutTail: 'string',
    stderrTail: 'string'
  })
})
```

Plus a new schema constant `LINEAR_TICKET_TRIGGER_OVERLAY` and `WORKTREE_TRIGGER_OVERLAY`:

```ts
it('LINEAR_TICKET_TRIGGER_OVERLAY shape', () => {
  expect(LINEAR_TICKET_TRIGGER_OVERLAY).toEqual({
    'linear.issue.id': 'string',
    'linear.issue.identifier': 'string',
    'linear.issue.title': 'string',
    'linear.issue.description': 'string',
    'linear.issue.url': 'string',
    'linear.issue.assigneeEmail': 'string',
    'linear.issue.stateName': 'string',
    'linear.issue.priority': 'number'
  })
})

it('WORKTREE_TRIGGER_OVERLAY shape', () => {
  expect(WORKTREE_TRIGGER_OVERLAY).toEqual({
    worktreeId: 'string',
    worktreeBranch: 'string',
    worktreePath: 'string'
  })
})
```

**Note:** the schema uses flat dotted keys (e.g. `'linear.issue.id'`). The dry-run validator already walks dotted paths; we just need the OutputSchema type to allow that pattern. Confirm by reading `OutputSchema` — if it's `Record<string, SchemaLeafType>`, this works as-is. If it requires nested objects, adjust the overlay to nest properly and update `getAvailableVariablesAtStep` to merge nested.

(Pick whichever fits the existing `dryRunTemplate` walker. Look at `template-dry-run.ts` first; the current walker handles `automation.x`, `trigger.x`, `steps.<id>.x` — flat with one level under each namespace. So flat dotted keys WON'T work — we need to either extend the walker to handle nested paths under trigger, or stash linear data as flat keys like `trigger.linearIssueId`, `trigger.linearIssueTitle`, etc.)

**Decision:** EXTEND `dryRunTemplate` to handle nested paths under `trigger` (since the design uses `trigger.linear.issue.title`). Add a test for the validator covering nested paths. This is a small change to the existing walker.

### Step 2: Implement types + schemas

Update `automations-types.ts`:

```ts
export type TriggerConfig = {
  kind: 'manual'
  acceptsLinearTicket?: boolean
  acceptsWorktreeSelection?: boolean
}

export type RunPromptConfig = {
  worktreeRef: string
  agentId: TuiAgent
  prompt: string
  doneDebounceSeconds: number
  paneRef?: string
}

export type LinearIssuePayload = {
  id: string
  identifier: string
  title: string
  description: string
  url: string
  assigneeEmail: string
  stateName: string
  priority: number
}
```

Update `automation-step-schemas.ts`:

```ts
export const RUN_COMMAND_OUTPUT_SCHEMA: OutputSchema = {
  paneKey: 'string',
  exitCode: 'number',
  durationMs: 'number',
  stdoutTail: 'string',
  stderrTail: 'string'
}

export const LINEAR_TICKET_TRIGGER_OVERLAY: OutputSchema = {
  // (see test for exact shape — flat dotted keys or nested objects depending on the validator's capability)
}

export const WORKTREE_TRIGGER_OVERLAY: OutputSchema = {
  worktreeId: 'string',
  worktreeBranch: 'string',
  worktreePath: 'string'
}
```

### Step 3: Extend `dryRunTemplate` for nested trigger paths

In `src/renderer/src/lib/template-dry-run.ts`, the `validatePath` function currently splits paths like `automation.x` / `trigger.x` / `steps.<id>.x`. Extend the `trigger` branch to walk further into nested objects:

```ts
if (head === 'trigger') {
  return walkNested(parts.slice(1), available.trigger, path)
}
```

Add a `walkNested(parts, schema, originalPath)` helper that handles arbitrary depth. The schema type for trigger may need to allow nested objects:

```ts
type NestedSchema = OutputSchema | { [key: string]: NestedSchema | SchemaLeafType }
```

Update `AvailableVariables.trigger` to use `NestedSchema`. Add a dry-run test covering nested paths (`trigger.linear.issue.title`).

### Step 4: Update `getAvailableVariablesAtStep`

In `src/renderer/src/components/automations/editor/chain-editor-modal-state.ts`, the existing helper composes the available-vars tree. Extend it:

```ts
function getAvailableVariablesAtStep(draft: ChainDraft, stepIndex: number): AvailableVariables {
  const triggerSchema: NestedSchema = {
    ...MANUAL_TRIGGER_SCHEMA,
    ...(draft.trigger.acceptsLinearTicket ? { linear: { issue: { /* per LINEAR_TICKET_TRIGGER_OVERLAY */ } } } : {}),
    ...(draft.trigger.acceptsWorktreeSelection ? WORKTREE_TRIGGER_OVERLAY : {})
  }
  return {
    automation: { /* unchanged */ },
    trigger: triggerSchema,
    steps: { /* prior steps unchanged */ }
  }
}
```

Tests for this helper (component test or extracted pure function) cover the four combinations: neither flag, Linear only, worktree only, both.

### Step 5: Verify + commit

- `pnpm vitest run --config config/vitest.config.ts src/shared/ src/renderer/src/lib/template-dry-run.test.ts src/renderer/src/components/automations/editor/` — all green.
- `pnpm tc` — only the pre-existing failure.

```
git commit -m "feat(automations): trigger flag overlays + paneRef config + stdoutTail schema"
```

NO co-author trailer.

---

## Task 2: `sendPromptToPane` IPC roundtrip

**Files:**
- Create: `src/main/automations/send-prompt-to-pane.ts`
- Create: `src/main/automations/send-prompt-to-pane.test.ts`
- Modify: `src/preload/index.ts` (add `onSendPromptToPane` + `replySendPromptToPane`)
- Modify: `src/preload/api-types.ts`
- Create: `src/renderer/src/hooks/useAutomationSendPromptToPaneEvents.ts`
- Modify: `src/renderer/src/App.tsx` (mount the new hook)

**Goal:** Mirror `openPromptPane` exactly. Main asks renderer to write text + Enter to a PTY identified by paneKey. Reply is a discriminated union `{ ok: true } | { ok: false, error }`.

Pattern is identical to Phase 1's `openPromptPane`. Read `src/main/automations/open-prompt-pane.ts` and mirror its structure. Same error class pattern (`SendPromptToPaneError` or share `OpenPromptPaneError`).

### Step 1: Failing tests

5 cases mirroring `open-prompt-pane.test.ts`:

1. Sends the request and resolves on `{ ok: true }`.
2. Rejects when webContents is destroyed.
3. Rejects with timeout error after timeoutMs.
4. Rejects with `SendPromptToPaneError` on structured `{ ok: false, error }`.
5. Listener cleanup after structured failure.

### Step 2: Implement

`send-prompt-to-pane.ts` mirrors `open-prompt-pane.ts` shape:

```ts
export type SendPromptToPaneRequest = { paneKey: string; prompt: string }
export type SendPromptToPaneReply = { ok: true } | { ok: false; error: string }
export class SendPromptToPaneError extends Error { /* same pattern as OpenPromptPaneError */ }

export function sendPromptToPane(
  req: SendPromptToPaneRequest,
  deps: { webContents: WebContents; ipc: Pick<IpcMain, 'once' | 'removeAllListeners'>; requestId: string; timeoutMs?: number }
): Promise<void>
```

### Step 3: Preload + api-types

Add `automations.onSendPromptToPane` + `automations.replySendPromptToPane` mirroring `onOpenPromptPane` / `replyOpenPromptPane`.

### Step 4: Renderer hook

`useAutomationSendPromptToPaneEvents.ts`:

- Subscribe to `automations:sendPromptToPane`.
- On event: look up the PTY by paneKey via the store (`paneKey = '<tabId>:<paneId>'` → look up `tabsByWorktree` for `tabId`, then `ptyIdsByTabId[tabId]`).
- Call `window.api.pty.write(ptyId, prompt + '\n')`.
- Reply `{ ok: true }` on success, `{ ok: false, error }` on any throw.

Mount the hook in `App.tsx` alongside the existing automation hooks.

### Step 5: Verify + commit

- All 5 helper tests pass.
- `pnpm tc:web` clean.

```
git commit -m "feat(automations): sendPromptToPane IPC for reusing existing panes"
```

---

## Task 3: `RunPromptRunner` paneRef branch

**Files:**
- Modify: `src/main/automations/runners/run-prompt-runner.ts`
- Modify: `src/main/automations/runners/run-prompt-runner.test.ts`
- Modify: `src/main/automations/service.ts` (wire `sendPromptToPane` dep)

**Goal:** First-tick branches on whether `config.paneRef` resolves to a non-empty string. When set: send the prompt to that pane via the dep, record paneKey from the resolved value. When unset: existing `openPromptPane` flow. Subsequent ticks: identical lifecycle.

Plus the pre-send-wait risk mitigation from the design: if `paneRef` is set AND the current `agentStatusByPaneKey[paneRef]` shows the agent is `working`, the runner returns `needs-more-time` WITHOUT sending the prompt yet. Wait until the prior turn is `done` before sending.

### Step 1: New deps shape

```ts
export type RunPromptDeps = {
  openPromptPane: (...) => Promise<{ paneKey: string }>
  sendPromptToPane: (req: { paneKey: string; prompt: string }) => Promise<void>  // NEW
  getAgentStatus: (paneKey: string) => AgentStatusEntry | undefined
  now: () => number
}
```

### Step 2: Failing tests

Add cases:

1. With `paneRef` resolved: calls `sendPromptToPane` (not `openPromptPane`); tracker records the resolved paneKey.
2. Pre-send wait: when `paneRef` is set AND `getAgentStatus(ref).state === 'working'`, return `needs-more-time` and DO NOT send. On the next tick when status flips to `done`, send.
3. Existing happy path (paneRef unset) still passes.
4. `paneRef` set but pane no longer exists → `sendPromptToPane` throws `SendPromptToPaneError` → step fails fast.
5. Template error in `paneRef` → fail fast.

### Step 3: Implement the branch

In `tick`:

```ts
if (!tracker) {
  let paneKey: string
  let prompt: string
  let worktreeId: string
  try {
    prompt = resolveTemplate(config.prompt, ctx.context)
    if (config.paneRef && resolveTemplate(config.paneRef, ctx.context).trim() !== '') {
      paneKey = resolveTemplate(config.paneRef, ctx.context)
    } else {
      worktreeId = resolveTemplate(config.worktreeRef, ctx.context)
    }
  } catch (e) {
    if (e instanceof TemplateResolutionError) return { outcome: 'failed', status: 'failed', error: e.message }
    throw e
  }

  // Branch
  if (paneKey) {
    // Pre-send wait: if the existing pane's agent is currently working, hold.
    const currentStatus = this.deps.getAgentStatus(paneKey)
    if (currentStatus?.state === 'working') {
      return { outcome: 'needs-more-time', status: 'running' }
    }
    if (currentStatus?.state === 'blocked' || currentStatus?.state === 'waiting') {
      return {
        outcome: 'failed',
        status: 'failed',
        error: `Pane ${paneKey} agent is ${currentStatus.state} — cannot send prompt.`
      }
    }
    try {
      await this.deps.sendPromptToPane({ paneKey, prompt })
    } catch (e) {
      if (e instanceof SendPromptToPaneError) return { outcome: 'failed', status: 'failed', error: e.message }
      throw e
    }
    // Record tracker with openedAt = now
    tracker = { paneKey, openedAt: this.deps.now(), firstDoneAt: null }
    /* store tracker */
    return { outcome: 'needs-more-time', status: 'running' }
  }

  // Existing openPromptPane branch unchanged
  /* ... */
}
```

### Step 4: Wire `sendPromptToPane` dep in service

`AutomationService` constructor accepts a `sendPromptToPane` factory same shape as `openPromptPane`. `index.ts` provides it via a closure over `getWebContents` + `getIpcMain` + a fresh requestId per call.

### Step 5: Verify + commit

```
git commit -m "feat(automations): paneRef for run-prompt with pre-send wait gate"
```

---

## Task 4: `RunCommandRunner` stdoutTail capture

**Files:**
- Create: `src/main/automations/output-tail.ts` (ring buffer)
- Create: `src/main/automations/output-tail.test.ts`
- Modify: `src/main/automations/runners/run-command-runner.ts`
- Modify: `src/main/automations/runners/run-command-runner.test.ts`
- Modify: `src/main/ipc/pty.ts` (add subscribe/unsubscribe API for PTY data)
- Modify: `src/main/automations/service.ts` (wire the data-subscribe dep)
- Modify: `src/main/index.ts` (provide the dep)

**Goal:** RunCommandRunner subscribes to PTY data for the spawned PTY, fills two ring buffers (~32 KB each), attaches them to `result.output.stdoutTail` / `stderrTail` on exit, applies `contextPatch`.

### Step 1: Ring buffer

`output-tail.ts`:

```ts
export class OutputTail {
  private chunks: string[] = []
  private size = 0
  constructor(private readonly maxBytes: number) {}
  append(chunk: string): void { /* push + evict oldest while size > maxBytes */ }
  read(): string { return this.chunks.join('') }
}
```

5 tests: empty read, single chunk, eviction past limit, exact-fit boundary, unicode safety (don't split mid-codepoint when evicting).

### Step 2: PTY data subscription site

In `src/main/ipc/pty.ts`, find where PTY data events are broadcast to the renderer. Add a subscriber-list mechanism so other main-process modules can attach a listener without going through IPC.

```ts
type PtyDataSubscriber = (ptyId: string, stream: 'stdout' | 'stderr', chunk: string) => void
const subscribers = new Set<PtyDataSubscriber>()
export function subscribePtyData(listener: PtyDataSubscriber): () => void {
  subscribers.add(listener)
  return () => subscribers.delete(listener)
}
// Inside the existing data-broadcast site, also do:
for (const sub of subscribers) sub(ptyId, stream, chunk)
```

If the existing PTY data path is daemon → main → renderer, the subscriber tap goes in main right before the renderer broadcast. Add a test for `subscribePtyData` that asserts the subscriber receives data when the PTY emits.

### Step 3: Runner integration

`RunCommandRunner`'s tracker grows:

```ts
type Tracker = {
  ptyId: string
  paneKey: string
  openedAt: number
  stdout: OutputTail
  stderr: OutputTail
  unsubscribe: () => void
}
```

First tick: spawn the PTY (existing), create tail buffers, subscribe via dep, store unsubscribe in tracker. Subsequent ticks: existing exit-watch logic. On exit, populate `result.output.stdoutTail` and `stderrTail` from the tails. Tear down subscription in `try/finally`.

### Step 4: Failing tests + verification

Add 3 cases to runner tests:

1. stdoutTail captured: PTY emits "hello\n"; on exit, output.stdoutTail === "hello\n".
2. Tail limit: 100 KB of data → only last 32 KB in stdoutTail.
3. Subscription cleanup on timeout: mock the exit-check to never resolve; advance time past timeout; assert unsubscribe was called.

### Step 5: Verify + commit

```
git commit -m "feat(automations): stdoutTail/stderrTail capture for run-command"
```

---

## Task 5: `runNow` accepts payload

**Files:**
- Modify: `src/shared/automations-types.ts` (RunNowPayload type)
- Modify: `src/main/automations/service.ts` (runNow signature)
- Modify: `src/main/ipc/automations.ts` (extend the IPC handler)
- Modify: `src/preload/index.ts` (typed payload on runNow)
- Modify: `src/preload/api-types.ts`
- Modify: `src/main/automations/run-now-chain-integration.test.ts` (add a case)

**Goal:** `runNow` accepts an optional payload `{ linear?: { issue: LinearIssuePayload }, worktreeId?: string }`. The service seeds `run.context.trigger.*` from the payload. Worktree branch/path are looked up from the store at runtime.

### Step 1: Type + signature

```ts
export type RunNowPayload = {
  linear?: { issue: LinearIssuePayload }
  worktreeId?: string
}

// service.ts
async runNow(automationId: string, payload?: RunNowPayload): Promise<AutomationRun>
```

### Step 2: Seed context

When seeding `run.context`:

```ts
const trigger: Record<string, unknown> = {}
if (payload?.linear) trigger.linear = payload.linear
if (payload?.worktreeId) {
  const wt = this.store.listWorktrees().find((w) => w.id === payload.worktreeId)
  if (!wt) throw new Error(`Worktree ${payload.worktreeId} not found.`)
  trigger.worktreeId = wt.id
  trigger.worktreeBranch = wt.branch
  trigger.worktreePath = wt.path
}
run.context = { automation: { projectId: ..., workspaceId: ... }, trigger }
```

### Step 3: Failing test + verify

Add an integration test: runNow with `{ linear: { issue: { id: 'lin-1', title: 'T', ... } }, worktreeId: 'wt-1' }`. Set up the store with a worktree. After runNow, assert run.context.trigger matches the expected shape.

### Step 4: Commit

```
git commit -m "feat(automations): runNow accepts Linear + worktree payload"
```

---

## Task 6: Linear + Worktree picker primitives

**Files:**
- Create: `src/renderer/src/components/automations/editor/LinearIssuePicker.tsx` (extract or new)
- Create: `src/renderer/src/components/automations/editor/LinearIssuePicker.test.tsx`
- Create: `src/renderer/src/components/automations/editor/WorktreePicker.tsx`
- Create: `src/renderer/src/components/automations/editor/WorktreePicker.test.tsx`

**Goal:** Two reusable picker components that the Run Now modal mounts.

### LinearIssuePicker

API: `{ onSelect: (issue: LinearIssuePayload) => void; onCancel: () => void }`. Implementation depends on P1 research:
- If `NewWorkspaceComposerCard`'s primitive is extractable, extract it.
- Otherwise, build a minimal picker: a search input + result list calling the same `linearSearch` IPC the existing picker uses. Cache via the same `linearIssueCache` slice if accessible.

3-4 tests: renders search input + empty state, renders results when given data, calls onSelect with mapped `LinearIssuePayload` when a row is clicked, calls onCancel.

### WorktreePicker

API: `{ projectId: string; onSelect: (worktreeId: string) => void; onCancel: () => void }`. Reads from `useAppStore((s) => s.worktreesByRepo[projectId])`. Renders a combobox / list of `displayName + branch`.

3 tests: renders all worktrees for the project, calls onSelect with the picked id, calls onCancel.

### Commit

```
git commit -m "feat(automations): LinearIssuePicker + WorktreePicker for Run Now"
```

---

## Task 7: Editor UX additions

**Files:**
- Modify: `src/renderer/src/components/automations/editor/ChainEditorModal.tsx` (trigger pill popover)
- Modify: `src/renderer/src/components/automations/editor/RunPromptStepCard.tsx` (paneRef field + agentId dim)
- Add tests for both changes.

**Goal:** Editor UX to compose the new shapes.

### Trigger pill popover

In the modal header, the read-only "Trigger: Manual" badge becomes a clickable pill that opens a small popover with two checkboxes (per design § Editor UX). Toggling either updates `draft.trigger`. Pill label updates: "Manual", "Manual + Linear", "Manual + Worktree", "Manual (2 prompts)".

3 tests: renders pill with current label; clicking opens popover; toggling updates draft.

### `RunPromptStepCard` paneRef field

Add a `<TemplateInput label="Reuse pane (optional)" value={config.paneRef ?? ''} ... />` row between `worktreeRef` and `agentId`. When `paneRef` is non-empty, the `agentId` select renders disabled with a small note: "Pane already has an agent."

3 tests: renders the new field; agentId dims when paneRef is set; selecting an agent when paneRef empty still works.

### Commit

```
git commit -m "feat(automations): editor UX for trigger flags + paneRef"
```

---

## Task 8: Run Now confirm modal

**Files:**
- Create: `src/renderer/src/components/automations/editor/RunNowConfirmModal.tsx`
- Create: `src/renderer/src/components/automations/editor/RunNowConfirmModal.test.tsx`
- Modify: `src/renderer/src/components/automations/editor/ChainEditorModal.tsx` (wire Run Now button to open the new modal when trigger flags require it)
- Modify: `src/renderer/src/components/automations/AutomationsPage.tsx` (same wiring at the list-view "Run now" button)

**Goal:** Sticky modal that mounts both pickers inline, gated on the trigger's flags. "Run" button disabled until all enabled pickers have a value.

### API

```ts
type RunNowConfirmModalProps = {
  open: boolean
  automation: Automation
  onClose: () => void
  onRun: (payload: RunNowPayload) => Promise<void>
}
```

The modal reads `automation.trigger` flags to decide which pickers to mount. Both off → the modal shouldn't even open (caller should fire runNow directly with empty payload).

### Behavior

- Renders title with automation name.
- For each enabled flag, renders the corresponding picker inline.
- "Run" button disabled until every enabled picker has a value.
- Click Run → calls `onRun(payload)`, closes modal.
- Click Cancel → closes modal.

### Caller logic

In `ChainEditorModal` (and `AutomationsPage`'s row action), the Run Now click handler becomes:

```ts
const handleRunNow = () => {
  const needsPayload = draft.trigger.acceptsLinearTicket || draft.trigger.acceptsWorktreeSelection
  if (needsPayload) {
    setRunConfirmOpen(true)
  } else {
    props.onRunNow(draft.id, {})
  }
}
```

5-6 tests: opens when flags require; renders only enabled pickers; Run disabled until pickers filled; fires onRun with assembled payload; Cancel closes without firing.

### Commit

```
git commit -m "feat(automations): RunNowConfirmModal with Linear + worktree pickers"
```

---

## Task 9: Run detail Linear surface

**Files:**
- Modify: `src/renderer/src/components/automations/AutomationDetail.tsx`
- Modify: `src/renderer/src/components/automations/AutomationDetail.step-states.test.tsx` (add a case)

**Goal:** When a run has `context.trigger.linear.issue`, the run-detail header shows a small "Linear: ORC-123 — Issue title" pill linking to `issue.url`. Click opens in default browser via `window.api.shell.openPath` or existing equivalent.

1-2 tests: renders the pill when present, doesn't render when absent.

### Commit

```
git commit -m "feat(automations): show Linear issue in run detail header"
```

---

## Task 10: End-to-end integration test + Phase verification

**Files:**
- Create: `src/renderer/src/components/automations/editor/RunNowConfirmModal.e2e.test.tsx` (testing-library)
- Modify: `src/main/automations/run-now-chain-integration.test.ts` (extend the existing e2e)
- Modify: `docs/plans/2026-05-19-automations-chain-engine-design.md` (Phase status)

**Goal:** Prove the whole flow end-to-end. Plus the standard verification commit.

### Editor-side e2e

`testing-library/react`-driven test:

1. Render the editor with a 2-step chain (run-prompt → run-command).
2. Enable both trigger flags.
3. Click Run Now → confirm modal opens.
4. Pick a Linear ticket from the mock picker → onRun called with `{ linear: { issue: {...} }, worktreeId: ... }`.

### Main-process e2e

Extend `run-now-chain-integration.test.ts` with a chain that uses:
- `paneRef` in step 2 (sends a follow-up to step 1's paneKey).
- `stdoutTail` template in step 3's prompt (reads from step 2's run-command output — though wait, paneRef + stdoutTail need different setups; pick one realistic chain shape and assert).

Realistic shape: run-prompt step 1 (opens claude) → run-command step 2 (runs a reviewer, captures stdoutTail) → run-prompt step 3 (paneRef set to step 1's paneKey, prompt templates `stdoutTail` from step 2). Assert the chain reaches `completed`.

### Phase verification

`pnpm test` + `pnpm tc` + `pnpm tc:web`. Same baseline failures expected. Append Phase status to the chain-engine design doc:

```
- 2026-05-??: Manual Linear/worktree trigger + pane reuse + stdoutTail capture shipped on branch <branch>.
```

### Commit

```
git commit -m "test(automations): end-to-end manual payload + pane reuse + stdoutTail"
git commit -m "docs(automations): mark manual-payload phase complete"
```

---

## Risks revisited

1. **PTY data subscription leak.** Tracker `try/finally` cleanup is the safety net. Task 4's tests cover the timeout path. Worth manual smoke-testing too.
2. **Pre-send-wait deadlock.** If the prior pane's agent never reports `done`, the chain hangs. `step.timeoutSeconds` is the escape hatch; the test in Task 3 should exercise this.
3. **Linear picker latency.** Loading skeleton; don't block the modal.
4. **Worktree picker with empty projectId.** Disable Run Now (or force project selection first) when `acceptsWorktreeSelection: true` and `projectId === ''`. Add a test.
5. **Template engine schema change.** Extending `dryRunTemplate` for nested trigger paths could regress existing tests. Run the full `template-dry-run.test.ts` after Task 1.

## What's NOT in this phase

- Full Linear webhook trigger (Phase 4 proper).
- Worktree creation from the Run Now modal (use `create-worktree` step).
- More than 2 pre-run user-input prompts (refactor when needed).
- Run viewer enhancements beyond the Linear pill (Phase 6).
- Per-step retry policy.
