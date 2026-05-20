# Automations Chain Engine — Phase 2 Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the remaining three step kinds to the chain engine — `create-worktree`, `wait-for-setup`, `run-command` — so a user can author a real multi-step Linear → PR flow (once the editor lands in Phase 5).

**Architecture:** Each new step kind is a `StepRunner` implementation. `create-worktree` calls the existing main-process `addWorktree` directly. `wait-for-setup` polls a new `SetupScriptRegistry` (mirrors `AgentStatusRegistry` pattern from Phase 1). `run-command` spawns a PTY via the same path the right-sidebar Review button uses, watches for exit, returns the captured stdout tail. The chain executor's runner registry grows to dispatch all four kinds.

**Tech Stack:** Same as Phase 1 — main-process TypeScript, vitest, zustand renderer store (unchanged), existing PTY infrastructure, `src/main/git/worktree` helpers.

**Design doc:** `docs/plans/2026-05-19-automations-chain-engine-design.md` (Step palette section).

**Phase 1 deliverables this builds on:** types, template resolver, `StepRunner` interface, `ChainExecutor`, `AutomationService` integration, `AgentStatusRegistry` pattern.

---

## Pre-task: Research checkpoints

Confirm before Task 1. If any fail, pause and reconcile.

**R1.** Identify the canonical entry point for worktree creation in the main process — the same path the user-facing "New Worktree" dialog uses. We need the full pipeline (git add, persistence write, optional setup-script launch, Linear/PR metadata if available), not just `addWorktree`.

Run: `grep -rn "addWorktree\|createWorktree\b" src/main --include="*.ts" | grep -v test`

Expected: a high-level entry function (likely in `src/main/runtime/orca-runtime.ts` or `src/main/ipc/worktree*.ts`) that bundles git + persistence + setup launch. The chain runner uses THIS, not the raw `addWorktree`.

**R2.** Find the main-process owner of setup-script PTYs and their exit status. We need a place to subscribe so our `SetupScriptRegistry` can mirror live state.

Run: `grep -rn "scripts.setup\|setup-runner\|setupScript" src/main --include="*.ts" | grep -v test | head -20`

Expected: PTY spawn site (likely `src/main/hooks.ts` or `src/main/ipc/worktree-remote.ts`) plus an exit-handler hook. The registry registers there.

**R3.** Confirm `runReviewCommand` / `runCreatePrCommand` (or equivalent) exists as a main-process API the renderer's sidebar Review button already calls. If so, the `run-command` runner reuses it; if not, the runner extracts the spawn logic into a shared helper alongside the existing button code.

Run: `grep -rn "reviewCommand\|createPrCommand\|review-prompt\|prompts/.*\.md" src/main --include="*.ts" | head -10`

Expected: an IPC handler the renderer invokes to spawn the chosen command in a PTY. The chain runner either calls this directly or extracts the same primitive.

If any of R1/R2/R3 fail, pause and decide whether to extract a shared helper (likely) or punt the affected step kind (unlikely).

---

## Task 1: Extend `StepKind` union + migration for `new_per_run`

**Files:**
- Modify: `src/shared/automations-types.ts`
- Modify: `src/main/persistence-automation-migration.ts`
- Modify: `src/main/persistence-automation-migration.test.ts`
- Modify: `src/shared/automations-types.test.ts`

**Goal:** Extend `StepKind` to `'run-prompt' | 'create-worktree' | 'wait-for-setup' | 'run-command'` and `StepConfig` to a discriminated union of per-kind configs. Update the legacy migration so a `workspaceMode: 'new_per_run'` automation produces a real two-step chain (`create-worktree` → `run-prompt`).

**Step 1 — Failing types test.** Extend `automations-types.test.ts` to assert:

```ts
expectTypeOf<StepKind>().toEqualTypeOf<
  'run-prompt' | 'create-worktree' | 'wait-for-setup' | 'run-command'
>()
expectTypeOf<CreateWorktreeConfig['baseBranch']>().toEqualTypeOf<string>()
expectTypeOf<CreateWorktreeConfig['linkLinearIssue']>().toEqualTypeOf<boolean>()
expectTypeOf<WaitForSetupConfig['worktreeRef']>().toEqualTypeOf<string>()
expectTypeOf<WaitForSetupConfig['requireSuccess']>().toEqualTypeOf<boolean>()
expectTypeOf<RunCommandConfig['source']>().toEqualTypeOf<'review' | 'create-pr' | 'custom'>()
```

Run: expect FAIL — types don't exist yet.

**Step 2 — Add the new types.**

```ts
export type StepKind = 'run-prompt' | 'create-worktree' | 'wait-for-setup' | 'run-command'

export type CreateWorktreeConfig = {
  baseBranch: string                 // template
  branchName: string                 // template
  displayName: string                // template
  linkLinearIssue: boolean
}

export type WaitForSetupConfig = {
  worktreeRef: string                // template, typically '{{steps.<id>.worktreeId}}'
  requireSuccess: boolean
}

export type RunCommandConfig = {
  worktreeRef: string                // template
  source: 'review' | 'create-pr' | 'custom'
  commandId?: string                 // when source is 'review' | 'create-pr'
  customCommand?: string             // when source is 'custom'
  captureStdout: boolean
}

export type StepConfig =
  | RunPromptConfig
  | CreateWorktreeConfig
  | WaitForSetupConfig
  | RunCommandConfig
```

Phase 1's `Step.config: StepConfig` typed widening means existing `Step` declarations continue to type-check (Phase 1 only had `RunPromptConfig` as the sole variant). New step rows must include a kind discriminator.

**Step 3 — Update migration tests for `new_per_run`.**

In `persistence-automation-migration.test.ts`, replace the existing "handles workspaceMode = new_per_run by leaving worktreeRef as a placeholder" test with:

```ts
it('upgrades workspaceMode=new_per_run into a two-step chain (create-worktree → run-prompt)', () => {
  const legacy: Automation = { /* ...new_per_run shape... */ }
  const upgraded = upgradeLegacyAutomation(legacy)
  expect(upgraded.steps).toEqual([
    {
      id: expect.any(String),
      kind: 'create-worktree',
      config: {
        baseBranch: 'main',          // from legacy.baseBranch
        branchName: expect.any(String), // generated default
        displayName: expect.any(String),
        linkLinearIssue: false       // legacy automations had no Linear linkage
      },
      onFailure: 'halt',
      timeoutSeconds: null
    },
    {
      id: expect.any(String),
      kind: 'run-prompt',
      config: {
        worktreeRef: expect.stringMatching(/^\{\{steps\.[a-z0-9-]+\.worktreeId\}\}$/),
        agentId: 'claude',
        prompt: 'Do thing',
        doneDebounceSeconds: 15
      },
      onFailure: 'halt',
      timeoutSeconds: null
    }
  ])
})
```

The `run-prompt` step's `worktreeRef` references the preceding `create-worktree` step by id. Generate stable IDs in the migration helper so the test can match the reference.

**Step 4 — Update migration helper.** In `persistence-automation-migration.ts`, branch on `workspaceMode`:

- `existing`: same as today — single `run-prompt` step with literal `workspaceId` as `worktreeRef`.
- `new_per_run`: build two steps. Generate `createWtId = randomUUID()` first, use it in both the new `create-worktree` step's `id` and the `run-prompt`'s `worktreeRef` template.

**Step 5 — Run tests + typecheck.**
- `pnpm vitest run --config config/vitest.config.ts src/main/persistence-automation-migration.test.ts src/shared/automations-types.test.ts`
- `pnpm tc`

Expected: all pass; no new errors.

**Step 6 — Commit.**

```
git commit -m "feat(automations): expand StepKind + migrate new_per_run to chain"
```

NO co-author trailer.

---

## Task 2: `create-worktree` runner

**Files:**
- Create: `src/main/automations/runners/create-worktree-runner.ts`
- Create: `src/main/automations/runners/create-worktree-runner.test.ts`

**Goal:** Implement a runner that calls the canonical worktree-creation entry point identified in R1 and returns `{ worktreeId, path, branch }` as the step output.

**Step 1 — Decide the abstraction boundary.** Based on R1, the runner accepts a `createWorktree` dep (function) injected via its constructor. The runner itself only resolves templates, calls the function, maps the result to the step output shape, and handles errors.

```ts
export type CreateWorktreeDeps = {
  createWorktree: (input: {
    repoId: string                   // from automation.projectId
    baseBranch: string
    branchName: string
    displayName: string
    linkedIssue?: { provider: 'linear'; id: string } | null
  }) => Promise<{ worktreeId: string; path: string; branch: string }>
  now: () => number
}
```

If R1's entry point has a different signature, adapt — but keep the runner's external surface narrow.

**Step 2 — Failing test.** Create `create-worktree-runner.test.ts`:

```ts
describe('CreateWorktreeRunner', () => {
  it('resolves templates and calls createWorktree on first tick', async () => {
    const createWorktree = vi.fn().mockResolvedValue({ worktreeId: 'wt-1', path: '/x/y', branch: 'feature/a' })
    const runner = new CreateWorktreeRunner({ createWorktree, now: () => 0 })
    const step: Step = {
      id: 'cw1',
      kind: 'create-worktree',
      config: {
        baseBranch: '{{trigger.baseBranch}}',
        branchName: 'feature/{{trigger.id}}',
        displayName: '{{trigger.title}}',
        linkLinearIssue: false
      },
      onFailure: 'halt',
      timeoutSeconds: null
    }
    const ctx = { runId: 'r', step, state: pending, context: {
      automation: { projectId: 'repo-1', workspaceId: null },
      trigger: { baseBranch: 'main', id: 'abc', title: 'Fix X' }
    } }
    const result = await runner.tick(ctx)
    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')
    expect(result.output).toEqual({ worktreeId: 'wt-1', path: '/x/y', branch: 'feature/a' })
    expect(result.contextPatch).toEqual({
      steps: { cw1: { worktreeId: 'wt-1', path: '/x/y', branch: 'feature/a' } }
    })
    expect(createWorktree).toHaveBeenCalledWith({
      repoId: 'repo-1',
      baseBranch: 'main',
      branchName: 'feature/abc',
      displayName: 'Fix X',
      linkedIssue: null
    })
  })

  it('attaches Linear issue when linkLinearIssue=true and trigger.linear.issue is present', async () => {
    // ... expect createWorktree called with linkedIssue: { provider: 'linear', id: ... } ...
  })

  it('fails fast on TemplateResolutionError', async () => {
    // ... bad template path → outcome 'failed' ...
  })

  it('fails when createWorktree rejects', async () => {
    // ... createWorktree throws → outcome 'failed', error message surfaced ...
  })

  it('does not call createWorktree again if ticked after success (idempotency via tracker)', async () => {
    // The chain executor shouldn't tick a succeeded step, but defensively the
    // runner should refuse to double-create. Mirror RunPromptRunner's tracker pattern.
  })
})
```

**Step 3 — Implement the runner.** Follow `RunPromptRunner`'s shape: nested `trackers: Map<runId, Map<stepId, { worktreeId, openedAt }>>` so re-ticks are no-ops, template errors fail-fast, other errors propagate or fail-fast (decide which — `addWorktree` errors are usually deterministic, so fail-fast is sensible).

Step output and `contextPatch` write to `steps.<stepId>` so downstream `wait-for-setup` / `run-prompt` steps can use `{{steps.cw1.worktreeId}}`.

**Step 4 — Verify.** Tests pass; `pnpm tc` clean.

**Step 5 — Commit.**

```
git commit -m "feat(automations): create-worktree step runner"
```

NO co-author trailer.

---

## Task 3: `wait-for-setup` runner + `SetupScriptRegistry`

**Files:**
- Create: `src/main/setup-script/registry.ts`
- Create: `src/main/setup-script/registry.test.ts`
- Create: `src/main/automations/runners/wait-for-setup-runner.ts`
- Create: `src/main/automations/runners/wait-for-setup-runner.test.ts`
- Modify: the setup-script PTY spawn/exit site identified in R2 (likely `src/main/ipc/worktree-remote.ts` or `src/main/hooks.ts`) to feed the registry.

**Goal:** A new main-process `SetupScriptRegistry` tracks per-worktree setup-script status (`pending` → `running` → `exited-success` | `exited-failure`). The `wait-for-setup` runner polls it and returns `done`/`failed`/`needs-more-time` accordingly.

**Step 1 — Build the registry.** Mirror `AgentStatusRegistry` shape:

```ts
export type SetupScriptState = 'pending' | 'running' | 'exited-success' | 'exited-failure'
export type SetupScriptEntry = {
  state: SetupScriptState
  exitCode: number | null
  startedAt: number | null
  finishedAt: number | null
}

export class SetupScriptRegistry {
  set(worktreeId: string, entry: SetupScriptEntry): void
  get(worktreeId: string): SetupScriptEntry | undefined
}
```

5 tests: unknown id → undefined; set/get; idempotent set; transitions through state machine; final state persists.

**Step 2 — Wire setup PTY lifecycle into the registry.** At the spawn site from R2:
- On spawn: `registry.set(worktreeId, { state: 'running', startedAt: now, exitCode: null, finishedAt: null })`.
- On exit: `registry.set(worktreeId, { state: code === 0 ? 'exited-success' : 'exited-failure', exitCode: code, finishedAt: now, startedAt: <kept> })`.

Verify no regression: existing setup-script tests still pass.

**Step 3 — Build the runner.** Lifecycle:
- First tick: resolve `worktreeRef` template, store tracker with `startedAt`.
- Subsequent ticks: read registry by worktreeId.
  - `pending` or `running` → `needs-more-time`.
  - `exited-success` → `done` with output `{ exitCode: 0, durationMs }`.
  - `exited-failure` → if `config.requireSuccess`: `failed` with error; else `done` with output `{ exitCode, durationMs }`.
  - Missing entry → if first tick: assume no setup script configured for this worktree → `done` with output `{ exitCode: 0, durationMs: 0 }` (so chains without a setup script just no-op past this step). Document the decision.
- Honor `step.timeoutSeconds`.

**Step 4 — Tests.** 7 cases covering: success, failure with requireSuccess=true, failure with requireSuccess=false, still-running, no-setup-script, timeout, template error.

**Step 5 — Verify + commit.**

```
git commit -m "feat(automations): wait-for-setup runner + SetupScriptRegistry"
```

NO co-author trailer.

---

## Task 4: `run-command` runner

**Files:**
- Create: `src/main/automations/runners/run-command-runner.ts`
- Create: `src/main/automations/runners/run-command-runner.test.ts`
- Possibly modify: the existing sidebar Review/CreatePR spawn path identified in R3 to extract a shared helper.

**Goal:** Spawn a PTY running either a configured command from `reviewCommands` / `createPrCommands` or a custom shell command, in a new tab in the target worktree. Watch for exit. Return exit code + stdout tail.

**Step 1 — Identify the shared spawn primitive.** Based on R3, either:
- (a) An existing main-process function the renderer's button calls. The runner calls it directly.
- (b) Logic lives only in the renderer; extract it into a main-process helper that both the renderer IPC handler and the runner consume. Renderer keeps working unchanged.

Prefer (b) if it's a small extract; the runner becomes substantially cleaner.

**Step 2 — Decide output capture.** Spawn the PTY, attach a stdout listener that maintains a ring buffer of the last 32 KB. On exit, the buffer becomes `stdoutTail`. Need:
- A small ring-buffer helper (`src/main/automations/output-tail.ts`).
- A hook into the PTY data stream — likely exists already (the daemon owns PTY data; the renderer scrollback reads from it).

If hooking the data stream is heavy, a simpler v1: skip `stdoutTail` (set to empty string) and just return `exitCode`. Downstream steps can't template the review output, but the chain still runs to completion. We can add capture in Phase 2.5 once the rest of the chain works. **Recommend skipping `stdoutTail` for v1 of this runner** — keep scope tight, ship working chains first.

**Step 3 — Build the runner.** Lifecycle:
- First tick: resolve templates (`worktreeRef`, `customCommand`), look up `commandId` if `source !== 'custom'`, spawn the PTY. Tracker records `{ ptyId, openedAt }`.
- Subsequent ticks: check if PTY exited (via existing PTY exit registry / events).
  - Still running → `needs-more-time`.
  - Exited → `done` with output `{ exitCode, durationMs }` (or `failed` if `exitCode !== 0` and step author wanted strict — Phase 1 design doc doesn't specify; default to `done` regardless of exit code, let `onFailure: 'halt'` + a downstream template check decide).
- Honor `step.timeoutSeconds`.

Actually — re-read the Phase 1 design doc § Step palette → `run-command`: "Resolves on process exit." The design doesn't explicitly say a non-zero exit fails the step. **Decision: non-zero exit returns `done` with the exit code in output. The user can author the next step's prompt to read `{{steps.review_1.exitCode}}` if they want to react. This keeps the runner agnostic.**

**Step 4 — Tests.** 6 cases: source=review spawn, source=create-pr spawn, source=custom shell, PTY exit success, PTY exit non-zero (still `done`), timeout.

**Step 5 — Verify + commit.**

```
git commit -m "feat(automations): run-command step runner"
```

NO co-author trailer.

---

## Task 5: Register all three new runners in the executor

**Files:**
- Modify: `src/main/automations/service.ts`
- Modify: `src/main/index.ts` (pass new deps into the service)
- Modify: `src/main/automations/service.test.ts` (or add a small integration test)

**Goal:** The chain executor's `getRunner(kind)` lookup returns the right runner for each kind. The service constructor accepts the new deps (`createWorktree`, `setupScriptRegistry`, `spawnPty` or equivalent).

**Step 1 — Wire deps.** `AutomationService`'s constructor gains:
- `createWorktree` factory function (from R1).
- `getSetupScript: (worktreeId) => SetupScriptEntry | undefined` (from the registry).
- `spawnRunCommandPty` factory (from the helper extracted in Task 4 Step 1).

These come from `src/main/index.ts` at service-construction time.

**Step 2 — Construct each runner.** In the service constructor, alongside the existing `RunPromptRunner`:

```ts
const createWorktreeRunner = new CreateWorktreeRunner({ createWorktree, now })
const waitForSetupRunner = new WaitForSetupRunner({ getSetupScript, now })
const runCommandRunner = new RunCommandRunner({ spawnRunCommandPty, getPtyExit, now })

this.chainExecutor = new ChainExecutor({
  getRunner: (kind) => {
    switch (kind) {
      case 'run-prompt': return this.runPromptRunner
      case 'create-worktree': return createWorktreeRunner
      case 'wait-for-setup': return waitForSetupRunner
      case 'run-command': return runCommandRunner
    }
  },
  // ...
})
```

**Step 3 — Integration test.** Extend `service.test.ts` (or `run-now-chain-integration.test.ts`) with a test that runs a 3-step chain end-to-end (create-worktree → wait-for-setup → run-prompt) with all four dependencies mocked. Assert the final run is `completed` and step outputs flow as expected.

**Step 4 — Verify + commit.**

```
git commit -m "feat(automations): register create-worktree/wait-for-setup/run-command runners"
```

NO co-author trailer.

---

## Task 6: Phase 2 verification + design doc update

Mirror Phase 1's Task 10.

**Step 1 — Run full test suite.** `pnpm test`. Expected: existing 53 automation tests + new tests (~25?) all pass. Same pre-existing failures (`updater.test.ts`, `register-core-handlers`, `persistence.test.ts:183`, `WorktreeContextBar.test.tsx`) remain.

**Step 2 — Run `pnpm tc`.** Same pre-existing failure only.

**Step 3 — Update the design doc.** Append Phase 2 to the Status section:

```markdown
- 2026-??-??: Phase 2 (step palette) shipped. Multi-step chains now feasible without an editor (hand-edited orca-data.json) — Phase 5 will add the editor UI.
```

**Step 4 — Commit doc.**

```
git commit -m "docs(automations): mark Phase 2 complete"
```

NO co-author trailer.

---

## Phase 2 known follow-ups (carried into Phase 3+)

These intentionally deferred items will land later:
- `run-command` `stdoutTail` capture — skipped in v1 for scope; required before review chains can pass reviewer verdicts into subsequent prompts.
- Tracker cleanup in all four runners (Phase 1 carried this for `RunPromptRunner`; new runners inherit the same gap).
- Per-step retry policy — none yet; failure is final.
- Step output schemas are not validated at runtime — runners trust their own shapes.

## What's NOT in Phase 2 (explicit)

- Schedule trigger (extended) — Phase 3.
- Linear trigger + Hookdeck — Phase 4.
- Chain editor UI — Phase 5.
- Run viewer enhancements (deep-link to paneKey, stdout/stderr tail expansion) — Phase 6.
- Variable picker — Phase 7.
