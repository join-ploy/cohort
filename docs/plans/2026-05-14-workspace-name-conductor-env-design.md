# Workspace Names + Conductor Env Vars — Design

**Status:** Approved (brainstorming → design); ready for implementation.
**Date:** 2026-05-14

## Goal

Each worktree gets a short, memorable, immutable name (e.g. `wise_panther`) shown under the worktree's `displayName` in the left sidebar. The name is injected into the setup, run, and archive script environments as `CONDUCTOR_WORKSPACE_NAME`. The primary repo path is injected as `CONDUCTOR_ROOT_PATH`. Compatible with Conductor's env-var convention so users with existing Conductor scripts work unchanged.

## Out of scope

- Renaming after creation. Names are immutable. To change one, delete and recreate the worktree.
- Cross-repo uniqueness. Postgres collisions across repos are the user's problem.
- Variable expansion done by Orca. The user's shell substitutes `$CONDUCTOR_WORKSPACE_NAME` at exec time — Orca only sets the env var on the spawned PTY.

## Data model

New field on `Worktree` (`src/shared/types.ts`):

```ts
type Worktree = {
  // ... existing fields
  /** Short, immutable, DB-safe identifier (e.g. "wise_panther"). Generated at
   *  create time. Injected into script env as CONDUCTOR_WORKSPACE_NAME. */
  workspaceName: string
}
```

Persisted alongside the rest of the worktree record in `src/main/persistence.ts`.

## Generation

**Format constraint:** `/^[a-z][a-z0-9_]{0,15}$/` — lowercase, starts with a letter, max 16 chars, snake_case. Composes cleanly into shell vars and Postgres DB names.

**Algorithm** (in new `src/shared/workspace-name-generator.ts`):

1. Pick random `adjective` from a curated list (~80 words: `wise`, `swift`, `nimble`, `sunny`, `brave`, `clever`, …).
2. Pick random `noun` from a curated list (~80 words: `otter`, `panther`, `robin`, `fox`, `owl`, `lynx`, …).
3. Combine: `${adjective}_${noun}`.
4. **If unique across all worktrees of the repo (active + archived) → use as-is.**
5. **If colliding → append `_2`, `_3`, … until unique.** Numeric suffix beats hex for memorability.

Word lists live inline in the source — no new dependency, ~5 KB. Shared by the renderer-side create dialog and the main-process backfill.

**Backfill:** when a persisted worktree lacks `workspaceName` (created before this feature), generate one once on load with sibling-collision check, assign, persist on next save.

## UI

### Sidebar display

In the left worktree-list row, render `workspaceName` as a sub-line below `displayName`:

```
┌─────────────────────────────┐
│ feat/auth-rewrite           │  ← displayName (existing)
│ wise_panther                │  ← workspaceName (NEW, smaller, muted, monospace)
└─────────────────────────────┘
```

`<span className="text-[10px] font-mono text-muted-foreground">{workspaceName}</span>`. Hidden when missing (defensive — backfill makes this rare).

### Create dialog

The worktree-create dialog gets a new "Workspace name" field below the branch field, prefilled with the generated suggestion:

```
Workspace name: [ wise_panther       ] 🔄
```

Live validation:
- Match `/^[a-z][a-z0-9_]{0,15}$/`
- Unique across all worktrees of repo (active + archived)
- Inline error below the field on failure

The 🔄 button regenerates a fresh adjective_noun.

## Env var injection

Setup, run, and archive scripts each receive two new env vars in addition to the existing `ORCA_WORKTREE_PATH`:

| Variable | Value |
| --- | --- |
| `CONDUCTOR_WORKSPACE_NAME` | `worktree.workspaceName` |
| `CONDUCTOR_ROOT_PATH` | `repo.path` (the primary worktree path) |

Implementation: extend the `envVars` block produced by `createWorktreeRunnerScript()` in `src/main/hooks.ts`. Both `createSetupRunnerScript` and `createRunRunnerScript` already delegate through this single helper (Phase 2 of the prior feature factored it). The archive runner is wired the same way (verify and extend if not).

The IPC handlers (`handleRunStart`, `handleSetupStart`) already resolve the worktree by ID for `worktree.path`; pull `workspaceName` from the same record.

## Tests

| File | Coverage |
| --- | --- |
| `src/shared/workspace-name-generator.test.ts` (new) | Produces valid format. Collision suffix appends `_2`, `_3`. Respects archived siblings. Live-validation predicate. |
| `src/main/hooks-runner.test.ts` (extend) | Wrapper script forwards `CONDUCTOR_WORKSPACE_NAME` and `CONDUCTOR_ROOT_PATH` alongside `ORCA_WORKTREE_PATH`. |
| `src/main/ipc/run-script.test.ts` (extend) | Spawn env block contains both `CONDUCTOR_*` vars. |
| `src/main/ipc/setup-script.test.ts` (extend) | Same. |
| Renderer | Sidebar row renders `workspaceName` sub-line. Create-dialog validates format + uniqueness. Reroll button updates value. |
| Persistence | Backfill assigns a unique name on load when missing. |

## Risk

- **Sidebar density:** adding a sub-line per row increases vertical density. The new line is small (10px) and muted, so impact is bounded — but worth a manual smoke check.
- **Backfill timing:** generating + persisting names for many existing worktrees on first load could write a flurry of saves. Generate eagerly in a single pass, then persist once.
