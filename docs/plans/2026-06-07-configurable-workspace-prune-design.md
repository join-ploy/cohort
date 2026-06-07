# Configurable Workspace Prune Duration + Force Prune

**Date:** 2026-06-07

## Problem

Archived worktrees and workspace groups are auto-pruned by the archive cleanup
service, but the retention duration is a single hardcoded constant
(`ARCHIVE_TTL_MS`) applied uniformly to both types. There is no way for a user
to configure how long archived items are kept, no separate control for normal
worktrees vs. workspace groups, and no user-facing way to trigger cleanup on
demand. A test-only IPC (`worktrees:_archiveCleanupNow`) exists but is gated
behind `ORCA_E2E_USER_DATA_DIR`.

## Goals

1. Let users configure the auto-prune duration **separately** for normal
   worktrees and workspace groups.
2. Add an on-demand **"Run cleanup now"** action (respects the configured
   durations — same as the hourly tick).
3. Add an on-demand **"Prune all archived now"** action that ignores the
   durations and deletes every archived item immediately, with an option to
   **force-delete worktrees that still have uncommitted changes**.

## Non-Goals

- No enable/disable toggle: auto-prune is always on; users only set durations.
- No scheduled/automatic force-prune. Force is a per-action option at the
  "Prune all archived now" button press only.
- The cleanup *interval* (`ARCHIVE_CLEANUP_INTERVAL_MS`, hourly) stays
  hardcoded — only the per-type TTLs become configurable.
- Force-prune still uses `skipArchive: true`; it never runs the repo's
  `orca.yaml` `archive` hook unsupervised.

## Decisions (from brainstorming)

- Two distinct on-demand actions: TTL-respecting "Run cleanup now" and
  TTL-ignoring "Prune all archived now".
- Duration entered as a **number + unit dropdown** (Hours / Days / Weeks),
  stored internally as milliseconds (consistent with `promptCacheTtlMs`).
- Separate durations for normal worktrees and groups; always-on (no disable).
- "Force" = `force: true` → `git worktree remove --force`, deleting worktrees
  with uncommitted/untracked changes instead of skipping them. Exposed as a
  switch in the "Prune all archived now" confirmation dialog, **default off**.

## Design

### 1. Data model & settings

Add to `GlobalSettings` (`src/shared/types.ts`), both in **milliseconds**:

```ts
archiveWorktreeTtlMs?: number   // normal worktrees
archiveGroupTtlMs?: number      // workspace groups
```

Seed `DEFAULT_SETTINGS` (`src/shared/constants.ts`) with both = `ARCHIVE_TTL_MS`
so behavior is unchanged until edited. Flows through existing settings plumbing
(renderer Zustand `updateSettings` → `settings:set` IPC → `store.updateSettings`
→ debounced disk write); no new transport. Verify `settings:set` merges
`Partial<GlobalSettings>` without a key whitelist.

Cleanup: `ARCHIVE_TTL_MS` is `3 * 24 * 60 * 60 * 1000` = **3 days**, but several
prose comments (e.g. `index.ts` "without waiting 30 days") claim 30 days.
Correct those comments to "3 days" (no behavior change).

### 2. Cleanup service: per-type TTL + force mode

`src/main/archive/cleanup-service.ts` currently resolves one `ttl` at
construction. Move resolution into `runOnce` so settings changes take effect
without restart, and split per type:

```ts
async function runOnce(options?: { ignoreTtl?: boolean; force?: boolean }) {
  const settings = deps.store.getSettings()
  // deps.ttlMs is the test/E2E hard override; applies to both types when set.
  const worktreeTtl = deps.ttlMs ?? settings.archiveWorktreeTtlMs ?? ARCHIVE_TTL_MS
  const groupTtl    = deps.ttlMs ?? settings.archiveGroupTtlMs    ?? ARCHIVE_TTL_MS
  const worktreeThreshold = options?.ignoreTtl ? now() : now() - worktreeTtl
  const groupThreshold    = options?.ignoreTtl ? now() : now() - groupTtl
  // ...candidate predicate unchanged: archivedAt > threshold => skip
}
```

`ignoreTtl: true` sets threshold to `now()`, so every archived item (its
`archivedAt` is always in the past) is a candidate. Removal/retry/error logic is
untouched. `start()`/`stop()`/hourly tick unchanged — `start()` calls
`runOnce()` (no args, TTL-respecting).

Thread `force` through the removal thunks:

```ts
runRemoval:      (worktreeId: string, opts?: { force?: boolean }) => Promise<void>
runGroupRemoval: (groupId: string,    opts?: { force?: boolean }) => Promise<void>
```

`runOnce` passes `options.force` to both. In `index.ts`, the thunks forward it
to `runWorktreeRemoval({ worktreeId, force: opts?.force ?? false, skipArchive: true }, ...)`,
and the group thunk passes `force` to each member removal.

### 3. IPC + preload

Add two production handlers in `index.ts` (leave the E2E-only
`worktrees:_archiveCleanupNow` untouched so existing specs pass):

```ts
ipcMain.handle('archive:cleanupNow', async () => archiveCleanup?.runOnce())
ipcMain.handle('archive:pruneAllNow', async (_e, force: boolean) =>
  archiveCleanup?.runOnce({ ignoreTtl: true, force: !!force }))
```

Both resolve after the pass; per-item failures are swallowed into
`archiveCleanupError` (item stays archived for retry), so one blocked worktree
won't reject the whole call.

Expose via preload bridge `window.api.archive`: `cleanupNow()` and
`pruneAllNow(force: boolean)`; add to the renderer api type declarations,
mirroring `window.api.settings`.

### 4. Settings UI (GeneralPane)

New **"Workspace Archiving"** section in
`src/renderer/src/components/settings/GeneralPane.tsx` (global setting; sits near
the existing Workspace rows):

- Two duration rows ("Auto-prune normal workspaces after" /
  "Auto-prune workspace groups after"), each a number `Input` + `Select`
  (Hours / Days / Weeks). Conversion in a testable
  `src/shared/archive-duration.ts`: `msToDurationParts(ms)` (largest whole
  unit) and `durationPartsToMs(value, unit)`. Clamp to ≥1 hour. Edits call
  `updateSettings({ archiveWorktreeTtlMs })` / `archiveGroupTtlMs`.
- **"Run cleanup now"** button (secondary) →
  `await window.api.archive.cleanupNow()` → `toast.success(...)` + refresh
  worktree/group lists.
- **"Prune all archived now"** button (destructive) → `Dialog`: title
  "Prune all archived workspaces?", body explaining it permanently deletes all
  archived workspaces and groups regardless of duration, plus a switch (reuse
  the existing `role="switch"` pattern — no checkbox primitive) "Also delete
  workspaces with uncommitted changes" (default off). Cancel + destructive
  "Prune all" → `await window.api.archive.pruneAllNow(force)` → toast + refresh.

Add search entries (`GENERAL_ARCHIVE_SEARCH_ENTRIES`) to `general-search.ts`
(keywords: prune, archive, cleanup, retention, duration, delete) and register
them in the pane. Styling per `docs/STYLEGUIDE.md` and the existing
`SearchableSetting` row layout. Primitives available: `dialog`, `input`,
`select`, `button`; toast via `sonner`.

### 5. Testing

TDD (red → green):

- **`src/shared/archive-duration.test.ts`** (new): largest-unit selection,
  round-trip, ≥1h clamp.
- **`src/main/archive/cleanup-service.test.ts`** (extend):
  - Per-type TTL from settings (worktree past TTL but group within longer TTL →
    only worktree removed, and vice-versa).
  - Live read: change stubbed settings between two `runOnce()` calls → second
    tick honors new value.
  - `ignoreTtl`: just-archived item removed.
  - `force` threading: `{ ignoreTtl: true, force: true }` → removal thunks
    called with `{ force: true }`; default calls pass falsy/no force.
  - `deps.ttlMs` override still wins over settings for both types.
  - Existing error-retry tests stay green.

**Verification commands** (full suite & `tc:cli` have pre-existing unrelated
failures — use targeted runs):

- `pnpm tc:node`, `pnpm tc:web`
- `pnpm vitest run src/shared/archive-duration.test.ts src/main/archive/cleanup-service.test.ts`

## Files Touched

- `src/shared/types.ts` — two `GlobalSettings` fields
- `src/shared/constants.ts` — `DEFAULT_SETTINGS` seeds
- `src/shared/archive-constants.ts` / `src/main/index.ts` — comment fixes (3 days)
- `src/shared/archive-duration.ts` (new) + test
- `src/main/archive/cleanup-service.ts` (+ extend test)
- `src/main/index.ts` — thunk `force` forwarding + two IPC handlers
- `src/preload/*` + renderer api types — `window.api.archive` bridge
- `src/renderer/src/components/settings/GeneralPane.tsx` — new section + dialog
- `src/renderer/src/components/settings/general-search.ts` — search entries
