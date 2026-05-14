# Per-Repo Run Script (Cmd+R) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `scripts.run` key to `orca.yaml` that the user can trigger with `Cmd+R` (or `Ctrl+R` on Linux/Windows). The script runs in a dedicated **Run** tab in the right sidebar with a status indicator. Cmd+R while a run is alive kills and re-runs. At most one run PTY per repo: starting in worktree B kills the run in worktree A but keeps A's output visible. The existing setup script gets a sibling **Setup** tab with a manual re-run button.

**Architecture:** YAML schema extension in `src/main/hooks.ts` and `src/shared/types.ts`. New main-process registry `runPtyByRepo` and IPC handler in `src/main/ipc/run-script.ts`. New renderer slice `scripts.ts` driving two new right-sidebar activity-bar tabs (`Run`, `Setup`) backed by `RunPanel.tsx` / `SetupPanel.tsx`, both reusing the existing `TerminalPane` xterm renderer. Setup PTY routing in `src/main/runtime/orca-runtime.ts` changes from "first regular terminal tab" to "worktree's Setup right-sidebar tab".

**Tech Stack:** TypeScript, Electron (main + renderer), React, Zustand store, xterm.js (`@xterm/xterm`), Vitest, sonner toasts, electron-vite, `js-yaml`-style hand-rolled YAML parser (existing in `src/main/hooks.ts`).

**Reference design:** `docs/plans/2026-05-14-per-repo-run-script-design.md`. Read this before starting any phase.

**Testing convention:** Vitest. Run a single file with `pnpm test -- <path>` (or `pnpm vitest run <path>`). Renderer-side tests use jsdom; main-side tests are node. Mirror the existing test files in the same directory.

**Commit convention:** `type(scope): subject` lowercase. See `git log --oneline -10` for style. One commit per task unless noted.

**Skill reminders:**
- @superpowers:test-driven-development for every code task — write the failing test first.
- @superpowers:verification-before-completion before declaring a task done — run the test, paste the actual output, never assume PASS.
- @superpowers:systematic-debugging if a test won't pass after the implementation step.

---

## Phase 1 — YAML schema: add `scripts.run`

### Task 1.1: Extend `OrcaHooks` type

**Files:**
- Modify: `src/shared/types.ts` (search for `OrcaHooks` — around lines 237–260)

**Step 1: Read the existing type**

Run: `grep -n "OrcaHooks\|RepoHookSettings" src/shared/types.ts`

Note the existing `scripts: { setup?: string; archive?: string }` shape and any places `RepoHookSettings.scripts` mirrors it.

**Step 2: Add `run?: string`**

Edit `OrcaHooks.scripts` to:

```ts
scripts: {
  setup?: string
  archive?: string
  run?: string   // NEW: user-triggered via Cmd+R
}
```

Mirror the same key on `RepoHookSettings.scripts` if it exists (search the file).

**Step 3: Update `getDefaultRepoHookSettings()`**

Run: `grep -n "getDefaultRepoHookSettings" src/shared/constants.ts`

Add `run: ''` (or undefined-by-default — match how `archive` is defaulted).

**Step 4: Type-check**

Run: `pnpm tsc -b --noEmit`
Expected: clean (or only pre-existing errors unrelated to this change).

**Step 5: Commit**

```bash
git add src/shared/types.ts src/shared/constants.ts
git commit -m "types(hooks): add scripts.run to OrcaHooks"
```

---

### Task 1.2: Parser test for `scripts.run`

**Files:**
- Modify: `src/main/hooks.test.ts` (add cases alongside existing setup/archive tests)

**Step 1: Write three failing tests**

Add to `describe('parseOrcaYaml', ...)`:

```ts
it('parses scripts.run as a single-line string', () => {
  const yaml = `scripts:\n  run: pnpm dev\n`
  const result = parseOrcaYaml(yaml)
  expect(result?.scripts.run).toBe('pnpm dev')
})

it('parses scripts.run as a block scalar', () => {
  const yaml = `scripts:\n  run: |\n    pnpm install\n    pnpm dev\n`
  const result = parseOrcaYaml(yaml)
  expect(result?.scripts.run).toBe('pnpm install\npnpm dev')
})

it('returns null when only scripts.run is empty and no other keys exist', () => {
  const yaml = `scripts:\n  run: ''\n`
  const result = parseOrcaYaml(yaml)
  expect(result).toBeNull()
})
```

**Step 2: Run, verify failure**

Run: `pnpm vitest run src/main/hooks.test.ts`
Expected: 3 failures — `result?.scripts.run` is `undefined`.

**Step 3: Commit failing test**

```bash
git add src/main/hooks.test.ts
git commit -m "test(hooks): scripts.run parsing cases (failing)"
```

---

### Task 1.3: Parser implementation for `scripts.run`

**Files:**
- Modify: `src/main/hooks.ts` (`parseOrcaYaml`, around lines 30–110; and the empty-content guard around line 104)

**Step 1: Read the existing parser**

Run: `pnpm tsc --showConfig | head` is unnecessary — just open the file: read lines 25–110 of `src/main/hooks.ts` to understand how `setup` and `archive` are parsed (state machine over keys).

**Step 2: Add `run` to the recognized script keys**

The parser likely keys off a string set or switch. Add `'run'` everywhere `'setup'` / `'archive'` appear. Update the empty-content guard (`if (!hooks.scripts.setup && !hooks.scripts.archive && !hooks.issueCommand)`) to also include `!hooks.scripts.run`.

**Step 3: Run tests, verify pass**

Run: `pnpm vitest run src/main/hooks.test.ts`
Expected: all parser tests pass (existing + new 3).

**Step 4: Commit**

```bash
git add src/main/hooks.ts
git commit -m "feat(hooks): parse scripts.run from orca.yaml"
```

---

### Task 1.4: `getEffectiveHooks` exposes `run`

**Files:**
- Modify: `src/main/hooks.ts` (search for `getEffectiveHooks` — should be around lines 260–290)
- Modify: `src/main/hooks.test.ts`

**Step 1: Write failing test**

```ts
it('getEffectiveHooks returns scripts.run from orca.yaml', () => {
  const repo = makeRepo({ /* … */ })
  // Use existing test fixture pattern; provide an orca.yaml mock that returns
  // { scripts: { run: 'pnpm dev' } }
  const effective = getEffectiveHooks(repo)
  expect(effective?.scripts.run).toBe('pnpm dev')
})
```

Pattern your test on the existing `getEffectiveHooks` tests in this file — copy-adapt one of them.

**Step 2: Run, verify failure (or PASS — `getEffectiveHooks` may already pass run through transparently because it returns the parsed object)**

Run: `pnpm vitest run src/main/hooks.test.ts -t "scripts.run"`
Expected: most likely PASS already if `getEffectiveHooks` returns `OrcaHooks` whole. If FAIL because the function constructs a fresh object, edit the merge to copy `run` alongside `setup` / `archive`.

**Step 3: Commit**

```bash
git add src/main/hooks.ts src/main/hooks.test.ts
git commit -m "test(hooks): assert getEffectiveHooks surfaces scripts.run"
```

---

## Phase 2 — Run-runner script wrapper

### Task 2.1: `createRunRunnerScript` test

**Files:**
- Modify: `src/main/hooks-runner.test.ts`

**Step 1: Read existing setup-runner tests**

Run: `grep -n "createSetupRunnerScript" src/main/hooks-runner.test.ts`
Look at how the setup runner test asserts the wrapped script: env injection (`ORCA_WORKTREE_PATH`), echo prefix, exit-code propagation.

**Step 2: Write parallel test for `createRunRunnerScript`**

Add a new `describe('createRunRunnerScript', () => { ... })` block mirroring the setup tests:

```ts
describe('createRunRunnerScript', () => {
  it('injects ORCA_WORKTREE_PATH and echoes the command', async () => {
    const { createRunRunnerScript } = await import('./hooks')
    const result = createRunRunnerScript(makeRepo(), '/tmp/wt-1', 'pnpm dev')
    expect(result.script).toContain('ORCA_WORKTREE_PATH')
    expect(result.script).toContain('pnpm dev')
  })

  // … add the same shape of assertions the setup variant has
})
```

**Step 3: Run, verify failure**

Run: `pnpm vitest run src/main/hooks-runner.test.ts -t createRunRunnerScript`
Expected: FAIL — `createRunRunnerScript` is not exported.

**Step 4: Commit failing test**

```bash
git add src/main/hooks-runner.test.ts
git commit -m "test(hooks): createRunRunnerScript wrapper (failing)"
```

---

### Task 2.2: Implement `createRunRunnerScript`

**Files:**
- Modify: `src/main/hooks.ts` (sibling to `createSetupRunnerScript` around line 359)

**Step 1: Implement by extracting shared scaffolding**

Either (a) introduce `createScriptRunner(repo, worktreePath, script, kind: 'setup' | 'run')` and have `createSetupRunnerScript` and the new `createRunRunnerScript` delegate to it, or (b) duplicate-and-adapt. Prefer (a) for DRY but only if the setup variant is straightforward to refactor without breaking its existing tests.

**Step 2: Run tests**

Run: `pnpm vitest run src/main/hooks-runner.test.ts`
Expected: all pass (existing setup + new run).

Run: `pnpm vitest run src/main/hooks.test.ts`
Expected: all pass.

**Step 3: Commit**

```bash
git add src/main/hooks.ts
git commit -m "feat(hooks): createRunRunnerScript for run scripts"
```

---

## Phase 3 — Main-process registry + IPC handler

### Task 3.1: `runPtyByRepo` registry test

**Files:**
- Create: `src/main/ipc/run-script.test.ts`

**Step 1: Write a small, focused test for the registry**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { _testing as registry } from './run-script'

describe('runPtyByRepo registry', () => {
  beforeEach(() => registry.clear())

  it('records and returns the live pty for a repo', () => {
    registry.set('repo-1', { ptyId: 'pty-A', worktreeId: 'wt-1', generation: 1 })
    expect(registry.get('repo-1')).toEqual({ ptyId: 'pty-A', worktreeId: 'wt-1', generation: 1 })
  })

  it('clearIfMatches only clears when generation matches', () => {
    registry.set('repo-1', { ptyId: 'pty-A', worktreeId: 'wt-1', generation: 1 })
    registry.clearIfMatches('repo-1', 'pty-A', 0) // stale
    expect(registry.get('repo-1')).not.toBeNull()
    registry.clearIfMatches('repo-1', 'pty-A', 1) // current
    expect(registry.get('repo-1')).toBeNull()
  })
})
```

**Step 2: Run, verify failure**

Run: `pnpm vitest run src/main/ipc/run-script.test.ts`
Expected: FAIL — file does not exist yet.

**Step 3: Commit failing test**

```bash
git add src/main/ipc/run-script.test.ts
git commit -m "test(run-script): registry get/set/clearIfMatches (failing)"
```

---

### Task 3.2: Implement `runPtyByRepo` registry

**Files:**
- Create: `src/main/ipc/run-script.ts`

**Step 1: Minimal registry module**

```ts
type RunPtyEntry = { ptyId: string; worktreeId: string; generation: number }

const runPtyByRepo = new Map<string, RunPtyEntry>()
let nextGeneration = 0

function get(repoId: string): RunPtyEntry | null {
  return runPtyByRepo.get(repoId) ?? null
}

function set(repoId: string, entry: RunPtyEntry): void {
  runPtyByRepo.set(repoId, entry)
}

function clearIfMatches(repoId: string, ptyId: string, generation: number): void {
  const cur = runPtyByRepo.get(repoId)
  if (cur && cur.ptyId === ptyId && cur.generation === generation) {
    runPtyByRepo.delete(repoId)
  }
}

function nextGen(): number {
  return ++nextGeneration
}

export const _testing = { get, set, clearIfMatches, clear: () => runPtyByRepo.clear(), nextGen }
```

**Step 2: Run tests**

Run: `pnpm vitest run src/main/ipc/run-script.test.ts`
Expected: PASS.

**Step 3: Commit**

```bash
git add src/main/ipc/run-script.ts
git commit -m "feat(run-script): repo-keyed pty registry"
```

---

### Task 3.3: `run:start` IPC handler — kill-then-spawn test

**Files:**
- Modify: `src/main/ipc/run-script.test.ts`

**Step 1: Write tests covering the three core behaviors**

Add a `describe('handleRunStart', () => { ... })` block. Mock the `IPtyProvider` so you can assert `kill` and `spawn` calls. Patterns to mirror: look at `src/main/ipc/pty-management.test.ts` or `worktrees.test.ts` for how providers are mocked.

Three tests:

1. **Spawns when nothing is running** — handler called with `(repoId, worktreeId, runScript)`; provider `spawn` called once with cwd = worktree path; registry now has a fresh entry.
2. **Kills existing then spawns** — pre-seed registry with `{ ptyId: 'old', worktreeId: 'wt-A' }`. Handler called for `worktreeId: 'wt-B'` of same repo. Asserts: provider `kill('old')` called once, then `spawn` called once for `wt-B`; registry now points to the new pty.
3. **Generation guard prevents stale exit from clearing fresh entry** — call handler twice quickly. Then fire the *first* spawn's `onExit` callback. Registry must still hold the second entry (because the first's generation no longer matches).

**Step 2: Run, verify failure**

Run: `pnpm vitest run src/main/ipc/run-script.test.ts`
Expected: FAIL — `handleRunStart` not exported.

**Step 3: Commit failing tests**

```bash
git add src/main/ipc/run-script.test.ts
git commit -m "test(run-script): handleRunStart kill-then-spawn (failing)"
```

---

### Task 3.4: Implement `handleRunStart` and `registerRunScriptIpc`

**Files:**
- Modify: `src/main/ipc/run-script.ts`
- Modify: `src/main/ipc/index.ts` (or wherever IPC handlers are registered — find with `grep -rn "registerWorktreeHooks\|hooks:check" src/main`)

**Step 1: Implement handler**

```ts
import { ipcMain, BrowserWindow } from 'electron'
import { getProviderForRepo } from '../providers' // pseudocode — find real path
import { createRunRunnerScript, getEffectiveHooks } from '../hooks'
import { findRepoById, findWorktreeById } from '...' // existing helpers

export async function handleRunStart(args: { repoId: string; worktreeId: string }) {
  const repo = findRepoById(args.repoId)
  const worktree = findWorktreeById(repo, args.worktreeId)
  const hooks = getEffectiveHooks(repo, worktree.path)
  const script = hooks?.scripts.run?.trim()
  if (!script) {
    return { ok: false, reason: 'no-run-script' as const }
  }

  // 1. Kill prior, if any
  const prior = _testing.get(args.repoId)
  if (prior) {
    const provider = getProviderForRepo(repo)
    await provider.kill(prior.ptyId)
    _testing.clearIfMatches(args.repoId, prior.ptyId, prior.generation)
    broadcast('run:exited', { repoId: args.repoId, worktreeId: prior.worktreeId, code: 130 })
  }

  // 2. Spawn fresh
  const wrapped = createRunRunnerScript(repo, worktree.path, script)
  const provider = getProviderForRepo(repo)
  const generation = _testing.nextGen()
  const ptyId = await provider.spawn({
    cwd: worktree.path,
    command: wrapped.script,
    env: wrapped.env,
    connectionId: repo.connectionId
  })
  _testing.set(args.repoId, { ptyId, worktreeId: args.worktreeId, generation })

  provider.onExit(ptyId, (code) => {
    _testing.clearIfMatches(args.repoId, ptyId, generation)
    broadcast('run:exited', { repoId: args.repoId, worktreeId: args.worktreeId, code })
  })

  broadcast('run:started', { repoId: args.repoId, worktreeId: args.worktreeId, ptyId })
  return { ok: true, ptyId }
}

export function registerRunScriptIpc(): void {
  ipcMain.handle('run:start', (_event, args) => handleRunStart(args))
  ipcMain.handle('run:stop', (_event, args: { repoId: string }) => handleRunStop(args))
}
```

`broadcast` should use `BrowserWindow.getAllWindows()[0].webContents.send(...)` or whatever helper is already used by other IPC handlers (search `webContents.send('run:` patterns).

Also implement `handleRunStop(repoId)` — kill the registered pty and clear the entry; emit `run:exited`.

**Step 2: Wire into IPC bootstrap**

Add `registerRunScriptIpc()` call wherever the other `register*Ipc()` calls live. Find with: `grep -rn "registerWorktreeHooksIpc\|registerPtyIpc" src/main/index.ts src/main/ipc/index.ts`

**Step 3: Run tests, verify pass**

Run: `pnpm vitest run src/main/ipc/run-script.test.ts`
Expected: all pass.

**Step 4: Commit**

```bash
git add src/main/ipc/run-script.ts src/main/index.ts # or wherever registered
git commit -m "feat(run-script): run:start ipc with kill-then-spawn"
```

---

### Task 3.5: Preload bridge for `run:start` / `run:stop`

**Files:**
- Modify: `src/preload/index.ts` (the `window.api` surface)
- Modify: `src/preload/api-types.ts`

**Step 1: Find existing pattern**

Run: `grep -n "hooks:" src/preload/index.ts src/preload/api-types.ts | head -20`

**Step 2: Add `runScript` namespace**

```ts
runScript: {
  start: (args: { repoId: string; worktreeId: string }) =>
    ipcRenderer.invoke('run:start', args),
  stop: (args: { repoId: string }) =>
    ipcRenderer.invoke('run:stop', args)
}
```

Mirror the matching type in `api-types.ts`.

**Step 3: Type-check**

Run: `pnpm tsc -b --noEmit`
Expected: clean. (Per AGENTS.md: types in `.ts` files, not `.d.ts`. The preload typecheck is enforced — see `docs/preload-typecheck-hole.md`.)

**Step 4: Commit**

```bash
git add src/preload/index.ts src/preload/api-types.ts
git commit -m "feat(preload): expose runScript.start/stop"
```

---

## Phase 4 — Renderer scripts slice + IPC subscription

### Task 4.1: Test the scripts slice transitions

**Files:**
- Create: `src/renderer/src/store/slices/scripts.test.ts`

**Step 1: Write tests for the slice**

Look at any existing slice test (e.g. `terminals.test.ts` if it exists, otherwise `worktrees.test.ts`) for the pattern.

```ts
describe('scripts slice', () => {
  it('handleRunStarted sets running state with ptyId', () => {
    const store = createTestStore()
    store.getState().handleRunStarted({ worktreeId: 'wt-1', ptyId: 'p-1' })
    const state = store.getState().scriptsByWorktree['wt-1'].run
    expect(state.status).toBe('running')
    expect(state.ptyId).toBe('p-1')
    expect(state.startedAt).toBeGreaterThan(0)
  })

  it('handleRunExited(0) → exited-success', () => { /* … */ })
  it('handleRunExited(1) → exited-failure', () => { /* … */ })
  it('handleSetupStarted / handleSetupExited mirror behavior', () => { /* … */ })
})
```

**Step 2: Run, verify failure**

Run: `pnpm vitest run src/renderer/src/store/slices/scripts.test.ts`
Expected: FAIL — slice does not exist.

**Step 3: Commit failing test**

```bash
git add src/renderer/src/store/slices/scripts.test.ts
git commit -m "test(scripts-slice): status transitions (failing)"
```

---

### Task 4.2: Implement the scripts slice

**Files:**
- Create: `src/renderer/src/store/slices/scripts.ts`
- Modify: the root store composition file (search `combineSlices\|createScriptsSlice\|create<.*Store` in `src/renderer/src/store/`)

**Step 1: Slice shape**

```ts
export type ScriptStatus = 'idle' | 'running' | 'exited-success' | 'exited-failure'
export type ScriptState = {
  ptyId: string | null
  status: ScriptStatus
  exitCode: number | null
  startedAt: number | null
}
export type ScriptKind = 'run' | 'setup'

export type ScriptsSlice = {
  scriptsByWorktree: Record<string, { run: ScriptState; setup: ScriptState }>
  handleRunStarted: (args: { worktreeId: string; ptyId: string }) => void
  handleRunExited: (args: { worktreeId: string; code: number }) => void
  handleSetupStarted: (args: { worktreeId: string; ptyId: string }) => void
  handleSetupExited: (args: { worktreeId: string; code: number }) => void
}
```

Implement reducers as Zustand setters. Default state for an unseen worktree is `{ run: idle, setup: idle }`.

**Step 2: Compose into root store**

Add `...createScriptsSlice(set, get)` to the root store creator.

**Step 3: Run tests**

Run: `pnpm vitest run src/renderer/src/store/slices/scripts.test.ts`
Expected: PASS.

**Step 4: Commit**

```bash
git add src/renderer/src/store/slices/scripts.ts src/renderer/src/store/<root>.ts
git commit -m "feat(scripts-slice): per-worktree run/setup status state"
```

---

### Task 4.3: Wire IPC events to the slice

**Files:**
- Modify: `src/renderer/src/hooks/useIpcEvents.ts`

**Step 1: Subscribe to `run:started`, `run:exited`, `setup:started`, `setup:exited`**

Find the existing event subscription pattern. Add new listeners that call `useAppStore.getState().handleRunStarted(...)` etc.

**Step 2: Smoke test**

No specific unit test (the listeners are wiring). Verify via the upcoming integration test in Phase 8 (smoke).

**Step 3: Commit**

```bash
git add src/renderer/src/hooks/useIpcEvents.ts
git commit -m "feat(ipc): subscribe renderer to run/setup lifecycle events"
```

---

## Phase 5 — Right sidebar Run + Setup tabs (activity bar plumbing)

### Task 5.1: Extend `RightSidebarTab` type

**Files:**
- Modify: `src/renderer/src/store/slices/editor.ts:127`

**Step 1: Add the two tab IDs**

```ts
export type RightSidebarTab =
  | 'explorer'
  | 'search'
  | 'source-control'
  | 'checks'
  | 'ports'
  | 'run'
  | 'setup'
```

**Step 2: Type-check**

Run: `pnpm tsc -b --noEmit`
Expected: clean (if existing switch statements are exhaustive, you'll get errors at the switch sites — that's expected and you'll fix them in Task 5.3).

**Step 3: Commit**

```bash
git add src/renderer/src/store/slices/editor.ts
git commit -m "types(editor): add 'run' and 'setup' to RightSidebarTab"
```

---

### Task 5.2: Add Run + Setup to `ACTIVITY_ITEMS` (gating test)

**Files:**
- Create: `src/renderer/src/components/right-sidebar/RightSidebar.run.test.tsx`

**Step 1: Test that Run + Setup tabs appear for git repos and not for folder repos**

Pattern: copy and adapt one of the existing right-sidebar tests (e.g. `TabBar.context-menu.test.ts` or look in `src/renderer/src/components/right-sidebar/` for any test file).

```tsx
it('shows Run and Setup tabs for a git repo', () => {
  renderWithStore(<RightSidebar />, { repos: [makeGitRepo()] })
  expect(screen.getByLabelText(/Run/)).toBeInTheDocument()
  expect(screen.getByLabelText(/Setup/)).toBeInTheDocument()
})

it('hides Run and Setup tabs for a folder repo', () => {
  renderWithStore(<RightSidebar />, { repos: [makeFolderRepo()] })
  expect(screen.queryByLabelText(/Run/)).not.toBeInTheDocument()
  expect(screen.queryByLabelText(/Setup/)).not.toBeInTheDocument()
})
```

**Step 2: Run, verify failure**

Run: `pnpm vitest run src/renderer/src/components/right-sidebar/RightSidebar.run.test.tsx`
Expected: FAIL — tabs not in `ACTIVITY_ITEMS`.

**Step 3: Add the items**

Edit `src/renderer/src/components/right-sidebar/index.tsx:77-113`. After the `ports` entry:

```ts
{
  id: 'run',
  icon: Play,
  title: 'Run',
  shortcut: `${mod}R`,
  gitOnly: true   // hides for folder repos; reuse existing gating
},
{
  id: 'setup',
  icon: Wrench,
  title: 'Setup',
  shortcut: '',
  gitOnly: true
}
```

Import `Play` and `Wrench` from `lucide-react` at the top of the file.

**Step 4: Run, verify pass**

Run: `pnpm vitest run src/renderer/src/components/right-sidebar/RightSidebar.run.test.tsx`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/renderer/src/components/right-sidebar/index.tsx \
        src/renderer/src/components/right-sidebar/RightSidebar.run.test.tsx
git commit -m "feat(right-sidebar): Run and Setup activity bar entries"
```

---

### Task 5.3: Status dot selector + transition test

**Files:**
- Modify: `src/renderer/src/components/right-sidebar/index.tsx`
- Modify: `src/renderer/src/components/right-sidebar/RightSidebar.run.test.tsx`

**Step 1: Failing test — dot color transitions**

```tsx
it('Run activity-bar dot is amber when running, emerald on success, rose on failure', async () => {
  const { store } = renderWithStore(<RightSidebar />, { worktreeId: 'wt-1' })

  store.getState().handleRunStarted({ worktreeId: 'wt-1', ptyId: 'p-1' })
  expect(screen.getByLabelText(/Run/).querySelector('.bg-amber-500')).toBeTruthy()

  store.getState().handleRunExited({ worktreeId: 'wt-1', code: 0 })
  expect(screen.getByLabelText(/Run/).querySelector('.bg-emerald-500')).toBeTruthy()

  store.getState().handleRunExited({ worktreeId: 'wt-1', code: 1 })
  expect(screen.getByLabelText(/Run/).querySelector('.bg-rose-500')).toBeTruthy()
})
```

**Step 2: Run, verify failure**

Run: `pnpm vitest run src/renderer/src/components/right-sidebar/RightSidebar.run.test.tsx`

**Step 3: Implement**

In `index.tsx`:
- Add a selector that, given `activeWorktreeId`, returns the `ScriptStatus` for `run` (and similarly for `setup`).
- Map status → `STATUS_DOT_COLOR`-style entry. Reuse the existing dot rendering in `ActivityBarButton`. Pass the dot color via the same `statusIndicator` prop, OR add a sibling `runStatus` / `setupStatus` prop and color it the same way (whichever is less invasive — peek at how `checks` currently does it).

For `pending` (running), use `bg-amber-500` plus an `animate-pulse` class to convey "still going".

**Step 4: Run, verify pass**

Run: `pnpm vitest run src/renderer/src/components/right-sidebar/RightSidebar.run.test.tsx`

**Step 5: Commit**

```bash
git add src/renderer/src/components/right-sidebar/index.tsx \
        src/renderer/src/components/right-sidebar/RightSidebar.run.test.tsx
git commit -m "feat(right-sidebar): run/setup status dot indicators"
```

---

## Phase 6 — RunPanel + SetupPanel components

### Task 6.1: Skeleton `RunPanel.tsx` with empty state

**Files:**
- Create: `src/renderer/src/components/right-sidebar/RunPanel.tsx`
- Modify: `src/renderer/src/components/right-sidebar/index.tsx` (the `effectiveTab === 'run' && <RunPanel />` switch)
- Create: `src/renderer/src/components/right-sidebar/RunPanel.test.tsx`

**Step 1: Failing test — empty state when no run script**

```tsx
it('renders empty state when no run script is configured', () => {
  renderWithStore(<RunPanel />, {
    activeRepoHooks: { scripts: {} } // no run
  })
  expect(screen.getByText(/No run script configured/i)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Open orca\.yaml/i })).toBeInTheDocument()
})
```

**Step 2: Run, verify failure**

Run: `pnpm vitest run src/renderer/src/components/right-sidebar/RunPanel.test.tsx`

**Step 3: Implement minimal panel**

```tsx
export default function RunPanel(): React.JSX.Element {
  const activeWorktree = useActiveWorktree()
  const repo = useRepoById(activeWorktree?.repoId ?? null)
  const hooks = useEffectiveHooks(repo) // new selector or compute inline
  const runScript = hooks?.scripts.run?.trim()
  const runState = useAppStore((s) =>
    activeWorktree ? s.scriptsByWorktree[activeWorktree.id]?.run : null
  )

  if (!runScript) {
    return <RunEmptyState />
  }
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <RunHeader runState={runState} onReRun={…} onStop={…} />
      <RunTerminal ptyId={runState?.ptyId ?? null} />
    </div>
  )
}
```

`RunTerminal` wraps the existing `TerminalPane` from `src/renderer/src/components/terminal-pane/TerminalPane.tsx`. Inspect that component first to understand its props (`ptyId`, dimensions, focus). It expects to be mounted in a sized container.

**Step 4: Wire into `index.tsx`**

```tsx
{effectiveTab === 'run' && <RunPanel />}
```

**Step 5: Run, verify pass**

Run: `pnpm vitest run src/renderer/src/components/right-sidebar/RunPanel.test.tsx`

**Step 6: Commit**

```bash
git add src/renderer/src/components/right-sidebar/RunPanel.tsx \
        src/renderer/src/components/right-sidebar/RunPanel.test.tsx \
        src/renderer/src/components/right-sidebar/index.tsx
git commit -m "feat(right-sidebar): RunPanel with empty state"
```

---

### Task 6.2: RunPanel header — Re-run / Stop buttons

**Files:**
- Modify: `RunPanel.tsx`
- Modify: `RunPanel.test.tsx`

**Step 1: Failing test**

```tsx
it('Re-run button calls runScript.start; Stop calls runScript.stop while running', async () => {
  const startSpy = vi.fn(); const stopSpy = vi.fn()
  vi.stubGlobal('window', { api: { runScript: { start: startSpy, stop: stopSpy } } })

  const { store } = renderWithStore(<RunPanel />, {
    activeRepoHooks: { scripts: { run: 'pnpm dev' } }
  })

  await userEvent.click(screen.getByRole('button', { name: /Re-run/i }))
  expect(startSpy).toHaveBeenCalledOnce()

  store.getState().handleRunStarted({ worktreeId: 'wt-1', ptyId: 'p-1' })
  await userEvent.click(screen.getByRole('button', { name: /Stop/i }))
  expect(stopSpy).toHaveBeenCalledOnce()
})
```

**Step 2: Run, verify failure → implement → run pass.**

**Step 3: Commit**

```bash
git commit -am "feat(right-sidebar): Re-run/Stop buttons in RunPanel"
```

---

### Task 6.3: SetupPanel (mirror of RunPanel)

**Files:**
- Create: `src/renderer/src/components/right-sidebar/SetupPanel.tsx`
- Create: `src/renderer/src/components/right-sidebar/SetupPanel.test.tsx`
- Modify: `right-sidebar/index.tsx` (add `effectiveTab === 'setup' && <SetupPanel />`)

**Step 1: Tests**

Mirror the RunPanel tests. Differences:
- Reads `hooks.scripts.setup` instead of `.run`.
- Calls `window.api.setupScript.start({ worktreeId })` (or whatever name; you'll add the IPC for setup re-run in Task 7.x).
- No cross-worktree kill semantics; the empty state is similar.

**Step 2: Implement**

If the setup re-run IPC isn't yet wired (it isn't — see Phase 7), this Task can either: (a) stub the button as disabled until Phase 7 lands, or (b) implement Phase 7 first and then this. Recommended: do Phase 7 first.

**Order note:** **Reorder** so Phase 7 lands before Task 6.3. Update your task tracker accordingly.

---

## Phase 7 — Setup PTY routing change

> **Risk:** highest in the plan. The setup script PTY is currently routed into "the visible first terminal tab". Moving it to the right-sidebar Setup tab affects worktree-creation UX. Read `src/main/runtime/orca-runtime.ts:3850-3900` and the existing tests in `src/main/runtime/orca-runtime.test.ts` (the ones that use `vi.mocked(createSetupRunnerScript)`) before touching code.

### Task 7.1: Inventory existing setup-PTY routing

**Step 1: No code change. Read and document.**

Run:
```
grep -rn "createSetupRunnerScript\|setup.*pty\|setup.*terminal\|setupRunPolicy" \
  src/main src/renderer/src --include="*.ts" --include="*.tsx" | head -50
```

Open the matching files. In a short note (in this plan or a scratch file), capture:
- Where the setup PTY is spawned today
- Which renderer code claims its `ptyId` (likely the first tab in `terminals` slice)
- Which tests cover this behavior

This step is research-only. No commit.

---

### Task 7.2: New `setup:start` / `setup:stop` IPC

**Files:**
- Create or modify: `src/main/ipc/run-script.ts` (add setup variants alongside run; or split into `src/main/ipc/script-runner.ts`)
- Modify: `src/preload/index.ts`, `src/preload/api-types.ts`

**Step 1: Tests**

Add `describe('handleSetupStart', ...)` to the existing test file. Setup is per-worktree, so the registry is `setupPtyByWorktree: Map<worktreeId, { ptyId; generation }>`. Same kill-then-spawn semantics, but keyed on worktreeId, no cross-worktree replacement.

**Step 2: Implement.**

**Step 3: Wire preload.**

**Step 4: Tests pass. Commit.**

```bash
git commit -am "feat(setup-script): setup:start/stop ipc for re-run"
```

---

### Task 7.3: Route auto-run setup PTY into the Setup tab

**Files:**
- Modify: `src/main/runtime/orca-runtime.ts:3850-3900`
- Update: `src/main/runtime/orca-runtime.test.ts` (the `createSetupRunnerScript` mocks)

**Step 1: Adjust the existing tests**

The current tests assert that the wrapped setup script is handed off into `CreateWorktreeResult.setup` (which the renderer uses to mount it in the first regular tab). Update them to assert the new contract: setup PTY is spawned through the `handleSetupStart` path and emits `setup:started` / `setup:exited`. The renderer no longer mounts setup into a regular tab.

**Step 2: Modify `orca-runtime.ts`**

Replace the `createSetupRunnerScript(...)` call inside the worktree-create flow with a `handleSetupStart({ worktreeId })` invocation (or its non-IPC internal function). The setup script auto-runs on creation, but its output now lives in the worktree's Setup right-sidebar tab — not a regular terminal tab.

**Step 3: Run all setup-related tests**

Run: `pnpm vitest run src/main/runtime/`
Expected: PASS.

**Step 4: Commit**

```bash
git add src/main/runtime/orca-runtime.ts src/main/runtime/orca-runtime.test.ts
git commit -m "feat(setup-script): route auto-run setup PTY to Setup right-sidebar tab"
```

---

### Task 7.4: Resume Task 6.3 (SetupPanel) — implement it now

Now that `setupScript.start/stop` exist, finish `SetupPanel.tsx` per Task 6.3 instructions and commit.

```bash
git commit -am "feat(right-sidebar): SetupPanel with Re-run setup button"
```

---

## Phase 8 — Cmd+R global shortcut + menu accelerator

### Task 8.1: `useGlobalShortcuts` Cmd+R test

**Files:**
- Create: `src/renderer/src/hooks/useGlobalShortcuts.run.test.ts` (or extend an existing global-shortcuts hook test if one exists — search `useGlobalShortcuts\|globalShortcuts`)

**Step 1: Failing test**

```ts
it('Cmd+R triggers runScript.start when worktree focused and not in input', () => {
  const startSpy = vi.fn()
  vi.stubGlobal('window', { api: { runScript: { start: startSpy } } })
  renderWithStore(<App />, { activeWorktreeId: 'wt-1', activeRepoHooks: { scripts: { run: 'pnpm dev' } } })

  fireEvent.keyDown(document.body, { key: 'r', metaKey: true })
  expect(startSpy).toHaveBeenCalledWith({ repoId: 'repo-1', worktreeId: 'wt-1' })
})

it('Cmd+R is a no-op when focus is in a text input', () => { /* … */ })

it('Cmd+R toasts and does not call start when no run script is configured', () => {
  const startSpy = vi.fn()
  const toastSpy = vi.spyOn(toast, 'message')
  // no scripts.run
  fireEvent.keyDown(document.body, { key: 'r', metaKey: true })
  expect(startSpy).not.toHaveBeenCalled()
  expect(toastSpy).toHaveBeenCalled()
})
```

Use `ctrlKey: true` on non-Mac platforms (use `Object.defineProperty(navigator, 'userAgent', …)` or test both branches).

**Step 2: Run, verify failure**

**Step 3: Implement**

Add the listener inside `App.tsx` (or a new `useGlobalShortcuts` hook). Cross-platform per AGENTS.md:

```ts
const isMac = navigator.userAgent.includes('Mac')
const mod = isMac ? e.metaKey : e.ctrlKey
if (mod && e.key.toLowerCase() === 'r' && !isInInputOrXterm(e.target)) {
  e.preventDefault()
  runShortcutHandler()
}
```

`runShortcutHandler` reads the active worktree, checks `getEffectiveHooks(repo).scripts.run`, opens the right sidebar, switches to the Run tab, and calls `window.api.runScript.start(...)`. Toast on missing script.

**Step 4: Run, verify pass.**

**Step 5: Commit**

```bash
git commit -am "feat(shortcuts): Cmd+R triggers runScript.start"
```

---

### Task 8.2: Electron menu accelerator

**Files:**
- Modify: `src/main/menu/register-app-menu.ts`

**Step 1: Add a menu item**

Find an appropriate submenu (likely "Run" if it exists, or add to "View" / "Workspace"). Add:

```ts
{
  label: 'Run Script',
  accelerator: 'CmdOrCtrl+R',
  click: () => {
    const win = BrowserWindow.getFocusedWindow()
    win?.webContents.send('shortcut:run-script')
  }
}
```

In the renderer (`useIpcEvents.ts` or wherever main→renderer events are subscribed), listen for `shortcut:run-script` and call the same `runShortcutHandler()` from Task 8.1.

**Step 2: Smoke**

No unit test (menu accelerator behavior). Verify in Phase 9 manual smoke.

**Step 3: Commit**

```bash
git commit -am "feat(menu): CmdOrCtrl+R menu item for run script"
```

---

## Phase 9 — Cleanup & lifecycle hooks

### Task 9.1: Worktree-deleted kills its run + setup PTYs

**Files:**
- Modify: wherever worktree-deletion runs (search `deleteWorktree\|removeWorktree\|worktrees:remove`)
- Modify: `src/main/ipc/run-script.ts` (export `killForWorktree(worktreeId, repoId)` helper)
- Add tests for the kill path.

**Step 1: Test that deletion kills both PTYs**

```ts
it('deleting a worktree kills its run pty (if owned by this worktree) and its setup pty', async () => {
  // pre-seed registries; call deleteWorktree; assert kills + registry cleared
})
```

**Step 2: Implement, run, commit**

```bash
git commit -am "feat(run-script): clean up run/setup ptys on worktree delete"
```

---

## Phase 10 — Manual smoke test (cannot be unit-tested)

> Per AGENTS.md: "For UI or frontend changes, start the dev server and use the feature in a browser before reporting the task as complete." This phase is mandatory.

### Task 10.1: Smoke

**Steps:**
1. Add to a real `orca.yaml` in a test repo:
   ```yaml
   scripts:
     setup: |
       pnpm install
     run: |
       pnpm dev
   ```
2. Run: `pnpm dev` (Orca itself).
3. Open the test repo, focus a worktree, press **Cmd+R**.
4. Verify:
   - Right sidebar opens (if closed) and switches to Run tab.
   - Run command spawns, output streams in.
   - Activity bar dot is amber + pulsing while running.
5. Press **Cmd+R** again. Verify previous PTY dies, fresh PTY spawns.
6. Open a second worktree of the same repo. Press Cmd+R there.
   - Verify worktree A's Run tab shows the killed PTY's final output, dot is gray/rose.
   - Worktree B's run is amber + running.
7. Stop the run via the Stop button; verify dot turns rose (exited 130) or emerald (exited 0).
8. Repeat with a repo that has **no** `scripts.run`. Press Cmd+R, verify toast.
9. Open the Setup tab, click Re-run setup, verify it streams.
10. Test on Linux/Windows if possible — verify Ctrl+R, not Cmd+R.

### Task 10.2: Run the full suite once

```bash
pnpm vitest run
pnpm tsc -b --noEmit
pnpm lint
```

Expected: all green. If anything fails, debug per @superpowers:systematic-debugging.

### Task 10.3: Final commit and PR

```bash
git log --oneline -20  # review the chain
gh pr create --title "feat(scripts): per-repo run + setup right-sidebar tabs (Cmd+R)" \
  --body "$(cat <<'EOF'
## Summary
- Adds `scripts.run` to `orca.yaml`. Cmd+R (CmdOrCtrl) runs it in a new Run tab in the right sidebar.
- Adds a Setup tab in the right sidebar that exposes the existing setup hook and adds a manual re-run button.
- Run is single-instance per repo: starting in worktree B kills worktree A's PTY but keeps the output visible.
- Cross-platform (Mac uses metaKey, Linux/Windows uses ctrlKey).

Design: docs/plans/2026-05-14-per-repo-run-script-design.md
Plan:   docs/plans/2026-05-14-per-repo-run-script.md

## Test plan
- [x] Vitest suite green
- [x] tsc -b --noEmit clean
- [x] Manual smoke (Phase 10.1) passed on macOS
- [ ] Manual smoke on Linux/Windows (if applicable)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Done

If you got through every task, you have:
- A typed YAML schema for `scripts.run`.
- A main-process registry that enforces single-instance run per repo.
- IPC handlers + preload bridges for run + setup start/stop.
- A renderer slice tracking per-worktree script status.
- Two new right-sidebar tabs with status dots, Re-run/Stop controls, and an empty state.
- Cmd+R keybinding (renderer hook + menu accelerator).
- The setup PTY routed to the Setup tab on worktree creation.
- Cleanup hooks that kill PTYs on worktree deletion.
- A passing test suite and a manually-smoked feature.
