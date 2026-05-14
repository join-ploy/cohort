# Per-Repo Run Script (Cmd+R) — Design

**Status:** Approved (brainstorming → design); ready for implementation plan.
**Date:** 2026-05-14

## Goal

Let each repo declare a `run` script in its `orca.yaml`. Pressing `Cmd+R` (or `Ctrl+R` on Linux/Windows) while a worktree is focused starts that script in a dedicated **Run** tab in the right sidebar. Pressing `Cmd+R` again kills and re-runs. Only one `run` PTY can be alive per repo at a time — starting a run in worktree B kills the run in worktree A but keeps A's output visible. The setup script (already auto-running on worktree creation) gets its own **Setup** tab in the right sidebar with a manual re-run button.

## Out of scope

- UI for editing `orca.yaml` from inside the app.
- Surfacing the `archive` script in the right sidebar (stays as the silent hook it is today).
- Multiple named run scripts (e.g. `scripts.run.dev`, `scripts.run.test`). Could come later.

## YAML schema

Extend `OrcaHooks.scripts` in `src/shared/types.ts` and `parseOrcaYaml()` in `src/main/hooks.ts` with one new key:

```yaml
scripts:
  setup: |          # existing — runs once on worktree creation
    pnpm install
  run: |            # NEW — user-triggered via Cmd+R
    pnpm dev
  archive: |        # existing — runs on worktree archive
    ...
```

`scripts.run` is a multiline shell string, parsed identically to `scripts.setup` (block scalar). Empty/missing means "no run script configured" — Cmd+R shows a toast and is otherwise a no-op.

## PTY ownership

| Script | Lifetime | Scope | Cross-worktree behavior |
| --- | --- | --- | --- |
| `run` | User-triggered (Cmd+R), long-lived | One PTY per **repo** | Starting a run in worktree B kills any run PTY in repo X (which would be in worktree A). A's tab keeps the final output and an "exited" status dot. |
| `setup` | Auto on worktree create + manual re-run | One PTY per **worktree** | Independent. No cross-worktree replacement. |

A new main-process registry tracks the live run PTY per repo:

```ts
runPtyByRepo: Map<repoId, { ptyId: string; worktreeId: string; generation: number }>
```

The `generation` counter prevents stale `onExit` events from clearing the registry after a fast kill+respawn cycle.

## Working directory and environment

Both scripts run in the worktree path with `ORCA_WORKTREE_PATH` set, mirroring the wrapper currently produced by `createSetupRunnerScript()` in `src/main/hooks.ts`. We will introduce a sibling `createRunRunnerScript()` (or generalize the existing one) so the run script gets the same env scaffolding and command-echo behavior.

PTY routing goes through the existing `IPtyProvider` registry: local for local repos, the SSH provider keyed by `repo.connectionId` for remote ones. SSH worktrees work without additional plumbing.

## Right sidebar UI

### Activity bar

Two new entries in `ACTIVITY_ITEMS` in `src/renderer/src/components/right-sidebar/index.tsx`:

```ts
{ id: 'run',   icon: Play,   title: 'Run',   shortcut: `${mod}R` }
{ id: 'setup', icon: Wrench, title: 'Setup', shortcut: '' }
```

`RightSidebarTab` in `src/renderer/src/store/slices/editor.ts` gains `'run' | 'setup'`. Both are gated as **non-folder-only**: skipped when `isFolderRepo(activeRepo)` is true, mirroring the existing `gitOnly` filter.

### Status indicator dot

Reuse the existing `STATUS_DOT_COLOR` pattern that the Checks tab uses (lines 428–436 of `right-sidebar/index.tsx`). A new selector returns:

| Status | Color | Meaning |
| --- | --- | --- |
| `pending` | amber, pulsing | currently running |
| `success` | emerald | last run exited 0 |
| `failure` | rose | last run exited non-zero |
| `null` | (none) | never run / no script configured |

The dot rides on the activity-bar icon button just like the Checks status dot. The selected-tab underline is unchanged — that purely reflects which tab the user is viewing.

### Panel content

Two new components in `src/renderer/src/components/right-sidebar/`:

- **`RunPanel.tsx`** — header bar with `[▶ Re-run]` / `[■ Stop]` toggle and a status line (`running…`, `exited 0`, `exited 130`); xterm terminal pane below using the existing terminal renderer (the same component used for regular tabs).
- **`SetupPanel.tsx`** — same shape; bound to the worktree's setup PTY. Header has `[▶ Re-run setup]` and (while running) `[■ Stop]`.

### Empty state

When `getEffectiveHooks(repo).scripts.run` (or `.setup`) is missing, the panel shows a friendly message:

> No run script configured.
> Add `scripts.run` to `orca.yaml` in this repo.
> [Open orca.yaml]

The button opens the file in the editor (or shows a "create orca.yaml" prompt if absent).

## Cmd+R flow

### Keybinding registration

- **Renderer:** global keydown listener in `App.tsx` (or `useGlobalShortcuts` hook). Guarded so it does not fire when focus is inside a text input or a focused xterm that owns its own Cmd+R behavior, and only when `activeWorktreeId` is set. Platform check picks `metaKey` on Mac, `ctrlKey` on Linux/Windows (per AGENTS.md cross-platform rules).
- **Main:** `CmdOrCtrl+R` registered as an Electron menu accelerator in `src/main/menu/register-app-menu.ts` so it appears in the OS menu bar. The menu item dispatches an IPC event the renderer routes to the same handler.

Cmd+R is currently unbound (verified during exploration), so no conflict.

### Renderer flow

1. Resolve `activeWorktree` → `repo`. If neither, no-op.
2. Read `getEffectiveHooks(repo).scripts.run`. If empty/missing → toast `"No run script configured for {repoName}"` and return.
3. Open the right sidebar (`rightSidebarOpen = true`) and switch tab to `'run'`.
4. Call IPC `run:start({ worktreeId })`.

### Main `run:start` handler (new `src/main/ipc/run-script.ts`)

1. Look up `runPtyByRepo.get(repoId)`. If a PTY exists (in any worktree), kill it via `provider.kill(ptyId)` and emit `run:exited` so the previous worktree's Run panel paints the exit. **Do not** delete the renderer-side tab state or scrollback.
2. Spawn a fresh PTY via the appropriate `IPtyProvider` with cwd = worktree path and the wrapped run script.
3. `runPtyByRepo.set(repoId, { ptyId, worktreeId, generation: ++ })`.
4. Wire `onExit` → emit `run:exited` with code → renderer flips status dot to green/rose. Clear the registry only if the exiting `(ptyId, generation)` still matches the current entry (guards against fast kill+respawn races).

Cmd+R while already running in the *current* worktree takes the same path — no special-case branch — yielding the "kill and re-run" UX.

## State and persistence

A new renderer slice `src/renderer/src/store/slices/scripts.ts`:

```ts
type ScriptStatus = 'idle' | 'running' | 'exited-success' | 'exited-failure'
type ScriptState = {
  ptyId: string | null
  status: ScriptStatus
  exitCode: number | null
  startedAt: number | null
}
type ScriptsByWorktree = Record<worktreeId, { run: ScriptState; setup: ScriptState }>
```

The activity-bar dot selector reads this. The Run/Setup panels read `ptyId` and feed it to the existing xterm renderer. No new terminal implementation.

### IPC events

Subscribed via `useIpcEvents`:

- `run:started   { repoId, worktreeId, ptyId }` → set `running`
- `run:exited    { repoId, worktreeId, code }`  → flip status, clear `runPtyByRepo` if generation matches
- `setup:started`/`setup:exited` (mirror) → replaces today's silent setup spawn

### Scrollback persistence

Reuse the existing `src/main/terminal-history.ts` mechanism keyed by `ptyId`, so the previous worktree's killed-Run output survives both a sidebar tab switch and an app restart, matching the behavior of regular terminal tabs.

`ScriptsByWorktree` itself is volatile (lost on reload). The last `exitCode` is recomputable on next mount from the persisted PTY end-state if we want the dot color to survive reload — optional follow-up.

## Setup script lifecycle change

Today, the setup script's PTY is wired into "the visible first terminal tab" (see `src/main/runtime/orca-runtime.ts:3873`). Under this design, on worktree creation the setup PTY is instead routed into the worktree's Setup right-sidebar tab. The auto-run trigger and `setupRunPolicy` semantics are unchanged — only the surface where output appears.

The Setup tab also exposes a `[▶ Re-run setup]` button that takes the same code path as the auto-run.

## Cleanup

- Worktree deleted → kill its setup PTY and (if registered to it) the repo's run PTY.
- App quit → existing PTY shutdown sweep handles both.

## Tests (Vitest)

| File | Coverage |
| --- | --- |
| `src/main/hooks.test.ts` (extend) | `parseOrcaYaml` accepts `scripts.run` (single-line, block scalar, empty). |
| `src/main/ipc/run-script.test.ts` (new) | `run:start` kill-then-spawn, cross-worktree replacement preserves prior tab, missing-script returns the right error, exit-code propagation, generation race. |
| `src/renderer/src/components/right-sidebar/RightSidebar.run.test.tsx` (new) | Activity-bar dot transitions across `idle → running → success → failure`; folder-repo gating; empty state when no script; Re-run button enabled/disabled. |
| `src/renderer/src/hooks/useGlobalShortcuts.run.test.ts` (new) | Cmd+R fires only when worktree focused; no-op when input/xterm has focus; toast when no script configured. |

## Risk and rollout

- **Breakage risk:** moving setup output from a regular terminal tab to the Setup right-sidebar tab is the most invasive change. The existing tests in `src/main/runtime/orca-runtime.test.ts` exercise the setup spawn path and need updating to assert the new routing target.
- **Cross-platform:** keybinding uses `metaKey` on Mac, `ctrlKey` elsewhere; menu accelerator uses `CmdOrCtrl+R`.
- **SSH:** PTY routing already handled by `IPtyProvider` keyed on `repo.connectionId` — no extra work.
- **Folder-mode repos:** Run/Setup tabs hidden via `gitOnly`-style gating (folder repos have no hooks today).
