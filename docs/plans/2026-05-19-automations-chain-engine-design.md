# Automations Chain Engine — Design

**Status:** Approved (brainstorming → design); ready for implementation plan.
**Date:** 2026-05-19

## Goal

Expand the Automations screen from a "one prompt on a schedule" feature into a chain-execution engine driven by external events. A typical chain:

```
trigger: linear (issue status → "Ready for Agent")
  → create-worktree           (link to Linear issue)
  → wait-for-setup
  → run-prompt                ("Implement: {{trigger.linear.issue.title}}…")
  → run-command source=review
  → run-prompt                ("Address the review: {{steps.review_1.stdoutTail}}")
  → run-command source=review (re-review)
  → run-command source=create-pr
```

A user defines this once. Linear ticket movement spawns a run. Orca creates the worktree, waits for setup, drives the agent, runs reviewer commands, and opens a PR — autonomously, with the user able to drop into any tab to spectate or intervene.

## Out of scope (v1)

Conscious YAGNI cuts; revisit after the canonical Linear flow is proven:

- Branching / parallel fan-out / joins (linear chains only).
- Manual approval gates between steps.
- GitHub triggers (PR comment, push, review submitted).
- Delay / sleep / OS notification step kinds.
- Custom HTTP-request step kind.
- Multi-worktree fan-out from one run.
- Per-step retry policy (failure is final; user re-runs the chain).
- Template expressions beyond literal substitution (no logic, no filters).
- Conditional skip on prior-step output.
- Plugin / SDK for user-defined step kinds.
- Triggering on existing PRs (e.g. re-review on push).
- Catching up missed scheduled runs from before the chain feature shipped.

## Architecture overview

The new model extends — does not replace — the existing `Automation` concept. Today: `{ trigger: schedule, action: dispatch one prompt }`. Tomorrow: `{ trigger: TriggerConfig, steps: Step[] }`.

The runtime stays in the main process under `src/main/automations/`. The existing 60-second `AutomationService` tick gains a second job: drive in-flight runs forward by polling each waiting step. Triggers register listeners with the service:

- `RRuleScheduler` (existing) — schedule triggers.
- `LinearTrigger` (new) — subscribes to webhook events from Hookdeck via a local HTTP receiver bound to 127.0.0.1; supervises a `hookdeck listen` child process using the same pattern as `src/main/daemon/daemon-spawner.ts`.

Each `Step` declares a literal `kind` and typed `config`. The executor looks up a `StepRunner` by kind and hands it the run's accumulated `context` (trigger payload + outputs from completed steps). Runners return `done | failed | pending | needs-more-time`; the executor advances, halts, or reschedules a re-tick.

What we reuse from the existing system: schedule scaffolding, persistence layer, runs table, IPC surface, local/SSH execution-target abstraction, agent hook reporting, `scriptsByWorktree` slice, configured `reviewCommands` / `createPrCommands`. We are adding orchestration on top of well-tested primitives, not rebuilding them.

## Data model

```ts
type Automation = {
  id: string
  name: string
  projectId: string
  executionTargetType: 'local' | 'ssh'
  executionTargetId: string
  trigger: TriggerConfig                  // tagged union; see "Trigger sources"
  steps: Step[]                           // ordered, runs top-to-bottom
  haltOnFailure: boolean                  // default true; per-step can override
  maxConcurrentRuns: number               // default 1
  deduplicationKey: string | null         // template e.g. 'linear-{{trigger.linear.issue.id}}'
  enabled: boolean
  createdAt: number
  updatedAt: number
}

type Step = {
  id: string                              // stable id for {{steps.<id>.x}} references
  kind: 'create-worktree' | 'wait-for-setup' | 'run-prompt' | 'run-command'
  config: StepConfig                      // typed per kind
  onFailure: 'halt' | 'continue'          // overrides Automation.haltOnFailure
  timeoutSeconds: number | null
}

type AutomationRun = {
  id: string
  automationId: string
  trigger: TriggerEvent                   // payload that fired this run
  context: Record<string, unknown>        // grows as steps complete
  steps: StepRunState[]
  status: 'pending' | 'running' | 'completed' | 'failed' | 'halted'
  startedAt: number
  finishedAt: number | null
}

type StepRunState = {
  stepId: string
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'timed-out'
  startedAt: number | null
  finishedAt: number | null
  output: unknown                         // structured per kind
  error: string | null
}
```

### Variable resolution

Any string field in a `StepConfig` runs through a literal-substitution resolver:

- `{{trigger.linear.issue.title}}`, `{{trigger.schedule.firedAt}}`, etc.
- `{{steps.<stepId>.<output-field>}}`.

Unresolved references fail the step with a clear error. Strings only — no expressions, no functions, no conditionals. If we ever want logic, that is the v2 conversation.

## Agent step lifecycle

The `run-prompt` step relies on infrastructure that already exists. The store carries `agentStatusByPaneKey: Record<paneKey, { state: 'done' | 'working' | 'blocked' | 'waiting', updatedAt }>`, written by the per-agent hook services (`src/main/claude/hook-service.ts`, `codex`, `droid`, `cursor`, `gemini`, `opencode`). The sidebar status dot reads it; the chain executor reads the same source.

Step transitions:

1. **Start.** Open a new tab in the target worktree, send the prompt to the chosen agent, capture the resulting `paneKey` as the step's watch target.
2. **Polling.** On every executor tick, read `agentStatusByPaneKey[paneKey]`:
   - `working` → step stays `running`.
   - `blocked` or `waiting` → step **fails** with `error: "Agent needs human input. Chain halted."` (linear chains have no manual gates in v1.) The user can intervene manually and re-run.
   - `done` → start a **debounce window** (default 15s of continuous `done`). If `done` persists, succeed with `output: { paneKey, lastTitle, durationMs }`. If state flips back to `working` mid-window, reset.
   - Missing entry → still warming up; treat as `working`.
3. **Stale safety.** Orca already has `AGENT_STATUS_STALE_AFTER_MS`. Once stale, the step times out per its `timeoutSeconds`.
4. **Cleanup.** The captured `paneKey` is preserved in the step output so the run viewer can deep-link the user into the tab. The tab is not closed automatically — that is the user's call.

This means the chain executor never invents a "done" signal. It consumes the same signal the sidebar dot is showing.

## Trigger sources (v1)

Triggers are a tagged union with three variants.

### Linear (via Hookdeck)

```ts
type LinearTrigger = {
  kind: 'linear'
  teamId: string
  eventTypes: ('issue.update' | 'comment.create')[]
  filters: LinearFilter[]                 // flat AND-list
}

type LinearFilter =
  | { field: 'status'; verb: 'equals'; value: string }
  | { field: 'assignee'; verb: 'equals'; value: string }
  | { field: 'label'; verb: 'contains'; value: string }
  | { field: 'priority'; verb: 'equals'; value: number }
```

A new `LinearTrigger` module:

- Spins up a local HTTP receiver on a randomized port bound to 127.0.0.1.
- Supervises a `hookdeck listen --destination http://127.0.0.1:<port>` child process via the `daemon-spawner.ts` pattern.
- Verifies Hookdeck's HMAC signature on every request; drops mismatches.
- Maps the Linear payload into a normalized `TriggerEvent.linear: { issue, comment?, actor, ... }` so templates have a stable shape regardless of Hookdeck-side reshaping.

Auth/config lives in a new Settings → Integrations → Linear (Hookdeck) pane: the user pastes their Hookdeck source URL and API key and selects which teams to subscribe to. The CLI auto-starts on app launch when at least one enabled Linear-triggered automation exists, and exposes its health to that settings pane.

### Schedule (extended)

Existing `rrule + dtstart + timezone` model unchanged. Same `RRuleScheduler`. On fire, instead of dispatching one prompt, it constructs `TriggerEvent.schedule: { firedAt, occurrenceIndex }` and starts a chain run. The schedule's `missedRunGraceMinutes` policy carries over unchanged.

### Manual

Implicit; no config. Every automation gets a "Run now" button regardless of trigger kind. Produces `TriggerEvent.manual: { firedAt, actorEmail }`. The intended workflow is "build the chain, smoke-test with Run now, then enable the Linear trigger."

### Cross-trigger guardrails

These live on `Automation`, not per-trigger:

- `maxConcurrentRuns` (default 1) — a second trigger while a run is in flight queues rather than spawns parallel. A noisy Linear day must not create 30 worktrees.
- `deduplicationKey` — a template (e.g. `linear-{{trigger.linear.issue.id}}`). Duplicate triggers on the same entity collapse to one run.

## Step palette (v1)

Four kinds; each reuses an existing Orca primitive.

### `create-worktree`

Wraps the existing worktree creation flow.

```ts
type CreateWorktreeConfig = {
  baseBranch: string                      // template
  branchName: string                      // template
  displayName: string                     // template
  linkLinearIssue: boolean
}
```

If `linkLinearIssue: true` and the trigger is Linear, the new worktree's `linkedIssue` / `linkedPR` are populated from `trigger.linear.issue`, so the sidebar identity matches what a manual "New worktree from issue" flow would produce.

Output: `{ worktreeId, path, branch }`.

### `wait-for-setup`

Blocks until the worktree's `setup` script finishes.

```ts
type WaitForSetupConfig = {
  worktreeRef: string                     // template, typically '{{steps.create_wt.worktreeId}}'
  requireSuccess: boolean
}
```

Reads from `scriptsByWorktree[wtId].setup.status` — same slice the status bar uses. Resolves on `exited-success` (or `exited-failure` if `requireSuccess: false`). No setup script configured → resolves immediately.

Output: `{ exitCode, durationMs }`.

### `run-prompt`

Interactive-agent step. Lifecycle per "Agent step lifecycle" above.

```ts
type RunPromptConfig = {
  worktreeRef: string                     // template
  agentId: TuiAgent
  prompt: string                          // template — where Linear data lands
  doneDebounceSeconds: number             // default 15
}
```

Output: `{ paneKey, lastTitle, durationMs }`.

### `run-command`

Runs a shell command in the worktree and waits for exit.

```ts
type RunCommandConfig = {
  worktreeRef: string                     // template
  source: 'review' | 'create-pr' | 'custom'
  commandId?: string                      // when source is 'review' or 'create-pr'
  customCommand?: string                  // when source is 'custom'
  captureStdout: boolean
}
```

When `source === 'review'` / `'create-pr'`, the user picks from the repo's configured `reviewCommands` / `createPrCommands` (already defined in `RepoHookSettings`). When `'custom'`, freeform shell.

Output: `{ exitCode, stdoutTail, stderrTail }`. `stdoutTail` is the last ~32KB so a downstream prompt can quote the reviewer's verdict:

```
Address the review feedback below.

{{steps.review_1.stdoutTail}}
```

## UI

### Automations list page

Extends `src/renderer/src/components/automations/AutomationsPage.tsx`. Table columns:

- Name.
- Trigger (icon + summary, e.g. "Linear · Bright Robin team · status = Ready").
- Step count.
- Last run (status pill + relative time).
- Enabled toggle.
- "Run now" button.

Filter by trigger kind and last-run status. Empty state pitches the canonical Linear → PR flow as a one-click template.

### Chain editor

Replaces `AutomationEditorDialog.tsx`. Full-screen modal — this is the workhorse surface.

Layout: a vertical column of cards with `+` buttons between cards to insert a new step. The **trigger card** at the top is special (different border, can change kind but cannot be deleted). Each **step card** has:

- Header: kind icon, step name (the `id`), kind selector dropdown, drag handle, delete button.
- Body: typed config fields auto-rendered per kind. `run-prompt` shows a prompt textarea, agent select, and debounce input. `run-command` shows a source radio, command picker (or free-form input when `custom`), and a "capture stdout tail" toggle.
- Footer strip: `onFailure` ("halt" / "continue") and `timeoutSeconds`.

A "Run now" button at the top stays available so the user can test without waiting for a trigger.

### Variable picker

Critical to making the template system discoverable. Typing `{{` in any template field opens an autocomplete popover listing the variables available at that step's position — `trigger.linear.issue.title`, `steps.create_wt.worktreeId`, etc. — with type hints. Live validation flags unresolved or future-step references in red. This is the closest the UI gets to a "node graph builder" feel while remaining a linear list.

### Run viewer

Click any past or in-flight run → the chain editor's vertical layout, but each card is decorated with execution state: green check, red X, spinner, grey "not reached." `run-prompt` cards expose an "Open tab" button that deep-links to the captured `paneKey`. `run-command` cards expand to show their stdout / stderr tail. Top of the viewer: the trigger payload (collapsed JSON), total duration, and a status banner. Failed runs link straight to the failing step.

### Settings

New **Integrations → Linear (Hookdeck)** pane: paste source URL + API key, choose teams to subscribe, view live `hookdeck listen` child-process health. When no Linear-triggered automation is enabled, the CLI is not running and the pane shows "Not started."

## Migration

Schema upgrade happens on read by the persistence layer. No startup downtime; no DB migration needed at the storage layer (the persistence file is JSON).

- `{ rrule, dtstart, timezone, missedRunPolicy, ... }` → `trigger: { kind: 'schedule', ... }`.
- `{ prompt, agentId, workspaceMode, workspaceId, baseBranch }` → `steps: [{ kind: 'run-prompt', config: { ... } }]`. When `workspaceMode === 'new_per_run'`, a synthetic `create-worktree` step is prepended.

Existing `AutomationRun` rows render in the run viewer as single-step legacy runs. We do not write the legacy fields back on first save — the row becomes canonical the moment it is edited.

## Risks and open questions

1. **Hook reporter reliability for non-Claude/Codex agents.** `run-prompt` is only as reliable as the agent's `done` signal. v1 ships with a known-good agent allowlist in the agent dropdown (Claude, Codex, Droid confirmed; Cursor, Gemini, Opencode to be verified). Expand the allowlist as per-agent hook services improve.
2. **Hookdeck dependency.** Solo dogfooding is fine; broader rollout would need a polling fallback or a hosted relay. Documented but unbuilt.
3. **Concurrency under Linear bursts.** `maxConcurrentRuns` and `deduplicationKey` are the v1 guardrails. Watch real traffic before relaxing the defaults.
4. **Variable picker scope creep.** The template engine is strings-only. Resist adding expressions, filters, or conditionals — the moment users want logic, that is a signal for a v2 conversation about a real graph, not a feature creep in v1.
5. **Tab clutter.** Chain runs create tabs that the user owns afterward. If chains run heavily, the worktree's tab strip fills up. Possible mitigations (group, auto-archive, prefix) deferred to a follow-up.

## Status

- 2026-05-19: Design approved.
- 2026-05-19: Phase 1 (foundation) shipped on branch `bright_robin`. Re-plan begins for Phase 2 (step palette expansion).

### Phase 1 deliverables

Foundation commits (chronological, `git log --oneline 5da45de9..d359f136`):

- Chain types alongside legacy (`7a9f240d`, `0515c20b`)
- Template variable resolver (`f58be9da`, `dfa7ac5b`)
- StepRunner interface + RunPromptRunner skeleton (`63a31c67`, `66de7a98`)
- Persistence migration (`5c381d84`)
- Main↔renderer openPromptPane IPC (`80070a96`, `7599ff3b`)
- Agent-status registry + lifecycle (`e5e056d1`, `e1ae9083`)
- Chain executor (`bf4189a0`, `f836dff8`)
- runNow integration (`f75aa621`)
- Step-state UI (`d359f136`)

### Phase 1 known follow-ups

Carried into Phase 2 polish (not blocking, surfaced by code reviews):
- `template.ts`: multi-line tokens become literal text (regex narrowing trade-off).
- `service.ts`: `requestDispatch` reads `this.webContents` directly while chain path uses `getWebContents()` — cosmetic inconsistency.
- Snappy immediate tick in `runNow` can block up to ~30s on `openPromptPane` timeout (worst case).
- Pre-existing race between `runNow`'s immediate tick and a concurrent periodic `tickRunningChains` — narrow window, but real.
- Chain executor `tickRunningChains` and `evaluateDueRuns` share the `evaluating` flag, serializing scheduling and chain progress against each other.
- Tracker cleanup deferred — RunPromptRunner trackers grow per (runId, stepId) without release; pick up in Phase 2 or when fan-out support lands.
