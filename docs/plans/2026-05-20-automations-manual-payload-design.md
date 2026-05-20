# Manual Linear/Worktree Trigger + Pane Reuse — Design

**Status:** Approved (brainstorming → design); ready for implementation plan.
**Date:** 2026-05-20

## Goal

Add three capabilities to the chain engine that let users compose richer multi-turn agent workflows without building a Linear webhook trigger first:

1. **Linear-ticket-aware manual trigger.** Each automation can opt into prompting the user for a Linear ticket at Run Now time. The picked issue lands in `trigger.linear.issue.*` for templates.
2. **Worktree selection at Run Now.** Each automation can opt into a worktree picker. The picked worktree lands in `trigger.worktreeId` / `worktreeBranch` / `worktreePath`.
3. **Reuse an existing pane from `run-prompt`.** `run-prompt`'s config gains an optional `paneRef`. When set, the runner sends the prompt to that existing pane instead of opening a new one. Lifecycle (debounce, blocked/waiting fail, timeout) is unchanged. Lets review output feed back into Claude's working session.

Plus the deferred prerequisite: **`stdoutTail` capture for `run-command`.** Required for the pane-reuse flow's typical use case (review verdict → Claude's existing session).

## Out of scope (this phase)

- Full Linear webhook trigger (Phase 4 proper) — builds on this manual flow.
- Per-step retry on transient failures.
- Worktree creation from the Run Now modal (use a `create-worktree` step instead).
- More than two pre-run user-input prompts (refactor `acceptsX/Y` booleans into a `runtimePrompts: PromptKind[]` array when a third kind appears — e.g. GitHub PR picker, free-text input).
- Variable picker enhancements for the new schema fields beyond what the existing dry-run validator + autocomplete already handle.

## Architecture overview

All three changes build on existing Phase 1/2/5 infrastructure. No new main-process services.

- **Linear picker:** `NewWorkspaceComposerCard` already drives Linear issue selection via `onSmartLinearIssueSelect` and reads from `linearSearch` + `LinearIssue` cache. Smallest path: extract the picker primitive into a standalone `LinearIssuePicker` the editor mounts independently.
- **Worktree picker:** `useAppStore((s) => s.worktreesByRepo[projectId])` already exposes the list. A small combobox over `displayName + branch`.
- **Pane reuse:** `RunPromptRunner` adds a branch to its first-tick — instead of `openPromptPane(...)`, it calls a new `sendPromptToPane(...)` IPC. The renderer-side primitive is one line — `window.api.pty.write(ptyId, prompt + '\n')` against the PTY owning the paneKey.
- **stdoutTail capture:** `RunCommandRunner` subscribes to PTY data via a new `subscribePtyData(ptyId, onData)` dep, fills ring buffers, attaches them to the step output on exit.

## Data model

```ts
// TriggerConfig — gains two optional booleans
export type TriggerConfig = {
  kind: 'manual'
  acceptsLinearTicket?: boolean
  acceptsWorktreeSelection?: boolean
}

// RunPromptConfig — gains optional paneRef
export type RunPromptConfig = {
  worktreeRef: string
  agentId: TuiAgent
  prompt: string
  doneDebounceSeconds: number
  paneRef?: string                              // template; when set, reuses an existing pane
}

// RunCommandConfig output — gains stdoutTail + stderrTail
export type RunCommandOutput = {
  paneKey: string
  exitCode: number
  durationMs: number
  stdoutTail: string                            // last ~32 KB
  stderrTail: string                            // last ~32 KB
}

// New shared Linear payload type
export type LinearIssuePayload = {
  id: string
  identifier: string                            // e.g. "ORC-123"
  title: string
  description: string                           // may be empty
  url: string
  assigneeEmail: string                         // empty if unassigned
  stateName: string                             // workflow state name
  priority: number                              // 0-4
}
```

### Variable picker schema growth

`MANUAL_TRIGGER_SCHEMA` stays as the baseline (`firedAt`, `actorEmail`). New conditional overlays:

- `acceptsLinearTicket: true` → adds `trigger.linear.issue.{id,identifier,title,description,url,assigneeEmail,stateName,priority}`.
- `acceptsWorktreeSelection: true` → adds `trigger.worktreeId`, `trigger.worktreeBranch`, `trigger.worktreePath`.

`getAvailableVariablesAtStep` selects the right overlay set based on the draft's trigger flags.

`run-command`'s output schema grows two `string` fields: `stdoutTail`, `stderrTail`. Templates downstream can finally do `{{steps.review-1.stdoutTail}}`.

### Migration

None. All changes are additive optional fields. Existing chains and runs load and run unchanged.

## Editor + Run Now UX

### Trigger pill becomes a small popover

Today the editor header shows a read-only "Trigger: Manual" badge. It becomes a clickable pill that opens a popover with two checkboxes:

```
Trigger: Manual ▾
  ──────────────────────────────────
  ☐ Accept Linear ticket on Run
  ☐ Accept worktree selection on Run
```

Pill label reflects selections: "Manual", "Manual + Linear", "Manual + Worktree", or "Manual (2 prompts)".

Phase 3's "Schedule" trigger and Phase 4's "Linear webhook" trigger will graduate this popover into a real trigger-kind selector later. For now it stays a flag set on `manual`.

### `run-prompt` card adds the `paneRef` row

A new optional template field between `worktreeRef` and `agentId`. Labelled "Reuse pane (optional)". When non-empty, the `agentId` select dims with a note: "Pane already has an agent." The "Done debounce seconds" field stays — the lifecycle is unchanged.

### Run Now flow

- Both flags off → unchanged. Click Run Now, chain starts with empty payload.
- One or both flags on → click Run Now opens a sticky modal with both pickers inline (single modal, not sequential dialogs):

  ```
  Run "My chain"
  ──────────────────────────────────
  Linear ticket    [pick…]
  Worktree         [pick…]
              [Cancel]  [Run]
  ```

  Only the enabled pickers render. "Run" is disabled until all enabled pickers have a value.

### Run detail view

When a run was triggered with a Linear payload, the run-detail header surfaces the linked issue (icon + identifier + title) so you can see at a glance which ticket a run is for. Small addition, big legibility win.

## Execution

### `RunPromptRunner` with `paneRef`

First-tick branch:

```ts
let paneKey: string
const ref = config.paneRef && resolveTemplate(config.paneRef, ctx.context).trim()
if (ref) {
  await this.deps.sendPromptToPane({ paneKey: ref, prompt })
  paneKey = ref
} else {
  const result = await this.deps.openPromptPane({ worktreeId, agentId, prompt })
  paneKey = result.paneKey
}
```

Tracker records `paneKey` either way. From tick two onwards the polling lifecycle is identical — agent-status registry is keyed by `paneKey`, and the existing pane keeps emitting status hooks like any other.

`sendPromptToPane` is a new IPC roundtrip mirroring `openPromptPane`:

- Main → renderer: `automations:sendPromptToPane` with `{ requestId, paneKey, prompt }`.
- Renderer: looks up PTY by paneKey, calls `window.api.pty.write(ptyId, prompt + '\n')`.
- Renderer → main: `{ ok: true }` or `{ ok: false, error }`.

`OpenPromptPaneError` / `SendPromptToPaneError` (or shared error class) lets the runner fail-fast on deterministic failures (pane no longer exists, agent doesn't accept input).

### `runNow` accepts a payload

```ts
runNow(automationId: string, triggerPayload?: {
  linear?: { issue: LinearIssuePayload }
  worktreeId?: string
}): Promise<AutomationRun>
```

The service seeds `run.context.trigger` from the payload. `worktreeBranch` and `worktreePath` are derived at runtime from the store using the picked `worktreeId`.

### `RunCommandRunner` stdoutTail capture

New tracker fields: `stdoutBuffer: RingBuffer`, `stderrBuffer: RingBuffer`. The runner takes a new dep:

```ts
subscribePtyData: (ptyId: string, onData: (stream: 'stdout' | 'stderr', chunk: string) => void) => () => void
```

PTY data events already flow through the daemon → `pty:data` IPC. We add a main-side filter that also delivers them to the runner via this subscription.

On step exit (success/fail/timeout), the runner:
1. Reads the two buffers.
2. Attaches them to `result.output.stdoutTail` / `stderrTail`.
3. Applies `contextPatch: { steps: { [stepId]: { ..., stdoutTail, stderrTail } } }`.
4. Tears down the subscription via the returned `unsubscribe`.

Wrap teardown in a `try/finally` so a runner crash between subscribe and exit doesn't leak the listener.

## Testing strategy

### Pure-function tests (highest leverage)

- `getAvailableVariablesAtStep` correctly adds Linear overlay only when `acceptsLinearTicket`, worktree overlay only when `acceptsWorktreeSelection`.
- `RunPromptRunner` with `paneRef` set — uses `sendPromptToPane`, agentId effectively ignored, tracker still records paneKey, lifecycle unchanged on subsequent ticks.
- `RunCommandRunner` ring-buffer capture — trims to 32 KB; stdout and stderr captured independently; `stdoutTail` makes it into `contextPatch`.

### Component tests (`renderToStaticMarkup`)

- Trigger pill popover renders the two checkboxes.
- Pill label updates based on flag combinations.
- `RunPromptStepCard` shows the `paneRef` row; `agentId` select dims when `paneRef` is non-empty.
- Run Now confirm modal renders only the enabled pickers.

### Integration tests (e2e and runtime)

- `runNow` with `{ linear: {...}, worktreeId: 'wt-x' }` → `trigger.linear.issue.title` and `trigger.worktreeId` resolve in templates.
- Two-step chain with `paneRef`: step 1 opens a fresh pane; step 2 sends a follow-up to that paneKey; step 2's debounce + done detection works.
- `run-command` step's stdoutTail captured and made available to a downstream `run-prompt` step's templated prompt.

## Risks

1. **Sending input to an agent mid-turn.** If the user clicks Run Now while the target pane's agent is `working`, the keystrokes get queued by the PTY but the agent may interpret them mid-response in unpredictable ways. `RunPromptRunner` with `paneRef` should *wait until status is `done`* before sending. Add a "pre-send wait" tick state.
2. **PTY-data subscription leak.** If `RunCommandRunner` crashes between subscribe and exit, the listener stays alive. Wrap in `try/finally` and tear down on every code path.
3. **Worktree picker scope.** Worktrees are per-repo. If `automation.projectId` is empty for a fresh chain, the worktree picker has nothing to show. Disable Run Now (or force project selection first) when `acceptsWorktreeSelection: true` and `projectId` is empty.
4. **Linear picker latency.** First-load of the Linear issue list can be slow (network). Show a loading skeleton; don't block the modal.
5. **Existing pane closed.** If the user closes the tab a `paneRef` points to, the step should fail fast (PTY dead) rather than hang on agent-status polling. Add a "pane no longer exists" check on first tick.
6. **Pre-existing race with `tickRunningChains`.** Same race carried from Phase 1 — `runNow`'s immediate tick can overlap with periodic ticks. Pane-reuse doesn't make it worse, but does increase the surface where it could matter. Not blocking this phase; document for Phase 3+.
