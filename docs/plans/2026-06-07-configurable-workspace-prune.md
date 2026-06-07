# Configurable Workspace Prune Duration + Force Prune — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users configure per-type auto-prune durations for archived worktrees and workspace groups, and add on-demand "Run cleanup now" and "Prune all archived now" (with force-delete) actions in Settings.

**Architecture:** The archive cleanup service (`src/main/archive/cleanup-service.ts`) resolves per-type TTLs live from `GlobalSettings` each tick, and `runOnce` gains `{ ignoreTtl, force }` options. Two new production IPC handlers expose on-demand cleanup; the renderer adds a "Workspace Archiving" section to the General settings pane.

**Tech Stack:** Electron (main + preload + renderer), TypeScript (`tsgo`), React, Zustand, shadcn/ui (`dialog`, `input`, `select`, `button`), `sonner` toasts, Vitest.

**Design doc:** `docs/plans/2026-06-07-configurable-workspace-prune-design.md`

**Verification (per repo memory — full suite & `tc:cli` have pre-existing unrelated failures, use targeted runs):**
- `pnpm tc:node` — main + shared typecheck
- `pnpm tc:web` — renderer typecheck
- `pnpm vitest run <file>` — targeted tests

**Naming note (refinement vs design doc):** the on-demand IPC lives under the existing `worktrees` namespace (alongside the E2E-only `worktrees:_archiveCleanupNow`), as `worktrees:cleanupArchivedNow` and `worktrees:pruneAllArchivedNow`, instead of a new `archive:` namespace. This keeps all archive-cleanup IPC in one place.

---

## Task 1: Settings fields, defaults, and stale comment fixes

Structural plumbing — no behavior change yet. Verified by typecheck.

**Files:**
- Modify: `src/shared/types.ts` (after line 1405, `promptCacheTtlMs`)
- Modify: `src/shared/constants.ts:287` (after `promptCacheTtlMs` in `DEFAULT_SETTINGS`)
- Modify: `src/main/index.ts` (comment-only: lines 608, 625, 668, 1045)
- Modify: `src/main/archive/cleanup-service.ts:99` (comment-only)

**Step 1: Add the two `GlobalSettings` fields**

In `src/shared/types.ts`, immediately after the `promptCacheTtlMs: number` field (line 1405), add:

```ts
  /** Auto-prune duration (ms) for archived normal worktrees. Archived worktrees
   *  older than this are permanently deleted by the cleanup service. Defaults to
   *  ARCHIVE_TTL_MS. */
  archiveWorktreeTtlMs?: number
  /** Auto-prune duration (ms) for archived workspace groups. Defaults to
   *  ARCHIVE_TTL_MS. */
  archiveGroupTtlMs?: number
```

**Step 2: Seed defaults**

In `src/shared/constants.ts`, find the `ARCHIVE_TTL_MS` import (add it if missing — it lives in `./archive-constants`). At the top of the file confirm/add:

```ts
import { ARCHIVE_TTL_MS } from './archive-constants'
```

Then in `DEFAULT_SETTINGS`, immediately after `promptCacheTtlMs: 300_000,` (line 287), add:

```ts
    archiveWorktreeTtlMs: ARCHIVE_TTL_MS,
    archiveGroupTtlMs: ARCHIVE_TTL_MS,
```

> If `ARCHIVE_TTL_MS` is already imported in `constants.ts`, don't duplicate the import. If importing it creates a circular-import concern, instead inline the literal `3 * 24 * 60 * 60 * 1000` with a comment `// = ARCHIVE_TTL_MS (3 days)`. Check by running `pnpm tc:node` after.

**Step 3: Fix the stale "30 days" comments**

`ARCHIVE_TTL_MS` is 3 days, not 30. Update these comments to say "3 days" (text only, no code change):
- `src/main/index.ts:608` — "without waiting 30 days" → "without waiting 3 days"
- `src/main/index.ts:625` — "the hook-trust prompt 30 days earlier" → "the hook-trust prompt 3 days earlier"
- `src/main/index.ts:668` — `"user quit Orca for 30+ days"` → `"user quit Orca for 3+ days"`
- `src/main/index.ts:1045` — "30-day-quit cleanup tick" → "long-quit cleanup tick"
- `src/main/archive/cleanup-service.ts:99` — "quit Orca for weeks" → "quit Orca for days"

**Step 4: Typecheck**

Run: `pnpm tc:node`
Expected: PASS (no errors).

**Step 5: Commit**

```bash
git add src/shared/types.ts src/shared/constants.ts src/main/index.ts src/main/archive/cleanup-service.ts
git commit -m "feat(archive): add per-type prune-duration settings; fix stale 30-day comments"
```

---

## Task 2: `archive-duration.ts` ms ↔ {value, unit} conversion (TDD)

A small, pure, testable module the UI uses to display ms as a number + unit.

**Files:**
- Create: `src/shared/archive-duration.ts`
- Test: `src/shared/archive-duration.test.ts`

**Step 1: Write the failing test**

Create `src/shared/archive-duration.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  msToDurationParts,
  durationPartsToMs,
  MIN_ARCHIVE_TTL_MS
} from './archive-duration'

describe('archive-duration', () => {
  it('picks the largest whole unit', () => {
    expect(msToDurationParts(3 * 86_400_000)).toEqual({ value: 3, unit: 'days' })
    expect(msToDurationParts(604_800_000)).toEqual({ value: 1, unit: 'weeks' })
    expect(msToDurationParts(3_600_000)).toEqual({ value: 1, unit: 'hours' })
    expect(msToDurationParts(2 * 604_800_000)).toEqual({ value: 2, unit: 'weeks' })
  })

  it('falls back to rounded hours for non-aligned values', () => {
    expect(msToDurationParts(90 * 60_000)).toEqual({ value: 2, unit: 'hours' }) // 1.5h -> 2h
  })

  it('round-trips through durationPartsToMs', () => {
    const ms = durationPartsToMs(3, 'days')
    expect(ms).toBe(3 * 86_400_000)
    expect(msToDurationParts(ms)).toEqual({ value: 3, unit: 'days' })
  })

  it('clamps to the minimum (1 hour)', () => {
    expect(durationPartsToMs(0, 'hours')).toBe(MIN_ARCHIVE_TTL_MS)
    expect(durationPartsToMs(-5, 'days')).toBe(MIN_ARCHIVE_TTL_MS)
    expect(msToDurationParts(1000)).toEqual({ value: 1, unit: 'hours' })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/shared/archive-duration.test.ts`
Expected: FAIL with "Cannot find module './archive-duration'".

**Step 3: Write minimal implementation**

Create `src/shared/archive-duration.ts`:

```ts
// Why: the settings UI shows the archive TTL (stored as ms) as a number + unit.
// Conversion lives here so it's pure and unit-testable, separate from React.
export type DurationUnit = 'hours' | 'days' | 'weeks'

export const DURATION_UNIT_MS: Record<DurationUnit, number> = {
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
  weeks: 7 * 24 * 60 * 60 * 1000
}

// Why: guard against a typo (e.g. "0") setting near-instant auto-deletion of
// archived workspaces.
export const MIN_ARCHIVE_TTL_MS = DURATION_UNIT_MS.hours

export function durationPartsToMs(value: number, unit: DurationUnit): number {
  const ms = Math.round(value) * DURATION_UNIT_MS[unit]
  return Math.max(MIN_ARCHIVE_TTL_MS, ms)
}

export function msToDurationParts(ms: number): { value: number; unit: DurationUnit } {
  const clamped = Math.max(MIN_ARCHIVE_TTL_MS, ms)
  for (const unit of ['weeks', 'days', 'hours'] as DurationUnit[]) {
    const unitMs = DURATION_UNIT_MS[unit]
    if (clamped % unitMs === 0) {
      return { value: clamped / unitMs, unit }
    }
  }
  // Fallback for non-aligned custom values: express in rounded hours.
  return { value: Math.round(clamped / DURATION_UNIT_MS.hours), unit: 'hours' }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/shared/archive-duration.test.ts`
Expected: PASS (all 4 tests).

**Step 5: Commit**

```bash
git add src/shared/archive-duration.ts src/shared/archive-duration.test.ts
git commit -m "feat(archive): add ms<->duration-parts conversion for prune-duration UI"
```

---

## Task 3: Cleanup service — per-type TTL + `ignoreTtl` + `force` (TDD)

**Files:**
- Modify: `src/main/archive/cleanup-service.ts`
- Test: `src/main/archive/cleanup-service.test.ts` (extend existing)

**Step 1: Write the failing tests**

Append these tests inside the existing `describe('archive cleanup service', ...)` block in `src/main/archive/cleanup-service.test.ts` (before the closing `})` on the last line):

```ts
  it('uses per-type TTLs from settings (worktree vs group)', async () => {
    const store = await createStore()
    const { createCleanupService } = await loadCleanupService()
    const now = Date.now()
    // Worktree TTL short (1h), group TTL long (1 week).
    store.updateSettings({
      archiveWorktreeTtlMs: 60 * 60 * 1000,
      archiveGroupTtlMs: 7 * 24 * 60 * 60 * 1000
    })
    const wtId = 'repo1::/path/wt'
    store.setWorktreeMeta(wtId, { isArchived: true, archivedAt: now - 2 * 60 * 60 * 1000 }) // 2h old > 1h
    store.setWorkspaceGroup(makeGroup('group:young', true, now - 2 * 60 * 60 * 1000)) // 2h old < 1 week

    const removed: string[] = []
    const removedGroups: string[] = []
    const service = createCleanupService({
      store,
      runRemoval: async (id) => {
        removed.push(id)
      },
      runGroupRemoval: async (id) => {
        removedGroups.push(id)
      }
    })

    await service.runOnce()

    expect(removed).toEqual([wtId])
    expect(removedGroups).toEqual([])
  })

  it('reads TTL settings live on each tick', async () => {
    const store = await createStore()
    const { createCleanupService } = await loadCleanupService()
    const now = Date.now()
    const wtId = 'repo1::/path/wt'
    store.setWorktreeMeta(wtId, { isArchived: true, archivedAt: now - 2 * 60 * 60 * 1000 }) // 2h old
    store.updateSettings({ archiveWorktreeTtlMs: 24 * 60 * 60 * 1000 }) // 1 day -> not expired

    const removed: string[] = []
    const service = createCleanupService({
      store,
      runGroupRemoval: async () => {},
      runRemoval: async (id) => {
        removed.push(id)
      }
    })

    await service.runOnce()
    expect(removed).toEqual([]) // within 1-day TTL

    store.updateSettings({ archiveWorktreeTtlMs: 60 * 60 * 1000 }) // now 1h -> expired
    await service.runOnce()
    expect(removed).toEqual([wtId])
  })

  it('ignoreTtl removes freshly-archived items regardless of duration', async () => {
    const store = await createStore()
    const { createCleanupService } = await loadCleanupService()
    const now = Date.now()
    const wtId = 'repo1::/path/fresh'
    store.setWorktreeMeta(wtId, { isArchived: true, archivedAt: now }) // just archived
    store.setWorkspaceGroup(makeGroup('group:fresh', true, now))

    const removed: string[] = []
    const removedGroups: string[] = []
    const service = createCleanupService({
      store,
      runRemoval: async (id) => {
        removed.push(id)
      },
      runGroupRemoval: async (id) => {
        removedGroups.push(id)
      }
    })

    await service.runOnce({ ignoreTtl: true })

    expect(removed).toEqual([wtId])
    expect(removedGroups).toEqual(['group:fresh'])
  })

  it('threads force through to the removal callbacks', async () => {
    const store = await createStore()
    const { createCleanupService } = await loadCleanupService()
    const now = Date.now()
    store.setWorktreeMeta('repo1::/path/wt', { isArchived: true, archivedAt: now })
    store.setWorkspaceGroup(makeGroup('group:g', true, now))

    const wtForce: Array<boolean | undefined> = []
    const groupForce: Array<boolean | undefined> = []
    const service = createCleanupService({
      store,
      runRemoval: async (_id, opts) => {
        wtForce.push(opts?.force)
      },
      runGroupRemoval: async (_id, opts) => {
        groupForce.push(opts?.force)
      }
    })

    await service.runOnce({ ignoreTtl: true, force: true })
    expect(wtForce).toEqual([true])
    expect(groupForce).toEqual([true])
  })

  it('deps.ttlMs override wins over settings for both types', async () => {
    const store = await createStore()
    const { createCleanupService } = await loadCleanupService()
    const now = Date.now()
    // Settings say "never expire soon" (1 week) but the override forces 0ms.
    store.updateSettings({
      archiveWorktreeTtlMs: 7 * 24 * 60 * 60 * 1000,
      archiveGroupTtlMs: 7 * 24 * 60 * 60 * 1000
    })
    store.setWorktreeMeta('repo1::/path/wt', { isArchived: true, archivedAt: now - 1000 })
    store.setWorkspaceGroup(makeGroup('group:g', true, now - 1000))

    const removed: string[] = []
    const removedGroups: string[] = []
    const service = createCleanupService({
      store,
      ttlMs: 0,
      runRemoval: async (id) => {
        removed.push(id)
      },
      runGroupRemoval: async (id) => {
        removedGroups.push(id)
      }
    })

    await service.runOnce()
    expect(removed).toEqual(['repo1::/path/wt'])
    expect(removedGroups).toEqual(['group:g'])
  })
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/archive/cleanup-service.test.ts`
Expected: FAIL — new tests fail (e.g. per-type TTL not honored; `opts?.force` undefined; `runOnce` doesn't accept options). Existing tests still pass.

**Step 3: Implement the service changes**

In `src/main/archive/cleanup-service.ts`:

(a) Update `CleanupServiceDeps` — give the two removal callbacks an optional `opts`:

```ts
  runRemoval: (worktreeId: string, opts?: { force?: boolean }) => Promise<void>
  runGroupRemoval: (groupId: string, opts?: { force?: boolean }) => Promise<void>
```

(b) Update `CleanupService.runOnce` signature:

```ts
export type CleanupService = {
  runOnce: (options?: { ignoreTtl?: boolean; force?: boolean }) => Promise<void>
  start: () => void
  stop: () => void
}
```

(c) Remove the construction-time `const ttl = deps.ttlMs ?? ARCHIVE_TTL_MS` line (line 25). Keep `interval` and `now`.

(d) Replace the `runOnce` function with this (resolves TTLs per tick, supports `ignoreTtl`/`force`):

```ts
  async function runOnce(options?: { ignoreTtl?: boolean; force?: boolean }): Promise<void> {
    const ignoreTtl = options?.ignoreTtl ?? false
    const force = options?.force ?? false
    // Why: resolve TTLs per-tick (not at construction) so a settings change takes
    // effect on the next cleanup without an app restart. deps.ttlMs is the
    // test/E2E hard override and wins over settings for both types.
    const settings = deps.store.getSettings()
    const worktreeTtl = deps.ttlMs ?? settings.archiveWorktreeTtlMs ?? ARCHIVE_TTL_MS
    const groupTtl = deps.ttlMs ?? settings.archiveGroupTtlMs ?? ARCHIVE_TTL_MS
    const currentNow = now()
    // Why: ignoreTtl ("Prune all now") treats every archived item as expired by
    // pinning the threshold to now — archivedAt is always <= now.
    const worktreeThreshold = ignoreTtl ? currentNow : currentNow - worktreeTtl
    const groupThreshold = ignoreTtl ? currentNow : currentNow - groupTtl

    const allMeta = deps.store.getAllWorktreeMeta()
    const candidates: string[] = []
    for (const [worktreeId, meta] of Object.entries(allMeta)) {
      if (!meta.isArchived) {
        continue
      }
      if (typeof meta.archivedAt !== 'number') {
        continue
      }
      if (meta.archivedAt > worktreeThreshold) {
        continue
      }
      candidates.push(worktreeId)
    }
    for (const id of candidates) {
      try {
        await deps.runRemoval(id, { force })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // Why: stay archived and keep archivedAt set so the next tick still
        // considers this worktree past TTL and retries on its own.
        deps.store.setWorktreeMeta(id, { archiveCleanupError: message })
      }
    }

    // Why: workspace-group records are pruned separately from worktree meta.
    // Run AFTER the worktree loop so a group's member worktrees (which carry
    // their own archived meta) are already removed by the time the group
    // teardown runs — leaving the group folder empty and the record safe to drop.
    const groupCandidates: string[] = []
    for (const group of deps.store.getWorkspaceGroups()) {
      if (!group.isArchived) {
        continue
      }
      if (typeof group.archivedAt !== 'number') {
        continue
      }
      if (group.archivedAt > groupThreshold) {
        continue
      }
      groupCandidates.push(group.id)
    }
    for (const id of groupCandidates) {
      try {
        await deps.runGroupRemoval(id, { force })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // Why: keep the group archived (mirrors the worktree path) so the next
        // tick retries; surface the reason on the record for the Archived view's
        // "Cleanup blocked" badge.
        const group = deps.store.getWorkspaceGroups().find((g) => g.id === id)
        if (group) {
          deps.store.setWorkspaceGroup({ ...group, archiveCleanupError: message })
        }
      }
    }
  }
```

`start()`/`stop()` are unchanged — `start()` still calls `runOnce()` (no args → TTL-respecting).

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/archive/cleanup-service.test.ts`
Expected: PASS (all old + 5 new tests).

**Step 5: Typecheck and commit**

Run: `pnpm tc:node`
Expected: PASS.

```bash
git add src/main/archive/cleanup-service.ts src/main/archive/cleanup-service.test.ts
git commit -m "feat(archive): per-type TTL read live; runOnce gains ignoreTtl + force"
```

---

## Task 4: Wire `force` through the production thunks + add on-demand IPC handlers

**Files:**
- Modify: `src/main/index.ts` (thunks ~618-662; new handlers after ~664)

**Step 1: Forward `force` in the `runRemoval` thunk**

In `src/main/index.ts`, change the `runRemoval` thunk (currently `runRemoval: async (worktreeId) => {`) to accept `opts` and forward `force`:

```ts
    runRemoval: async (worktreeId, opts) => {
      const window = mainWindow
      if (!window || window.isDestroyed()) {
        return
      }
      // Why: skipArchive=true so we never auto-execute the repo's orca.yaml
      // `archive` hook from unsupervised cleanup. force (off by default) is set
      // only by the user's explicit "Prune all archived now" with the
      // uncommitted-changes option checked.
      await runWorktreeRemoval(
        { worktreeId, force: opts?.force ?? false, skipArchive: true },
        { store: storeRef, runtime: runtimeRef, mainWindow: window }
      )
    },
```

**Step 2: Forward `force` in the `runGroupRemoval` thunk**

Change `runGroupRemoval: async (groupId) => {` to `runGroupRemoval: async (groupId, opts) => {`, and in the member-removal loop change `force: false` to `force: opts?.force ?? false`:

```ts
        await runWorktreeRemoval(
          { worktreeId: memberWorktreeId, force: opts?.force ?? false, skipArchive: true },
          { store: storeRef, runtime: runtimeRef, mainWindow: window }
        )
```

(Leave the rest of the group thunk — the `rm(group.parentPath, ...)`, `removeWorkspaceGroup`, `notifyWorkspaceGroupsChanged` — unchanged.)

**Step 3: Add the two production IPC handlers**

Immediately after the `createCleanupService({ ... })` call closes (after line ~664, before the `if (process.env.ORCA_E2E_USER_DATA_DIR) {` block at ~672), add:

```ts
  // Why: user-facing on-demand archive cleanup from Settings. cleanupArchivedNow
  // respects the configured per-type durations (same as the hourly tick);
  // pruneAllArchivedNow ignores them and deletes every archived item now,
  // optionally force-deleting worktrees with uncommitted changes.
  ipcMain.handle('worktrees:cleanupArchivedNow', async () => {
    await archiveCleanup?.runOnce()
  })
  ipcMain.handle('worktrees:pruneAllArchivedNow', async (_event, force: boolean) => {
    await archiveCleanup?.runOnce({ ignoreTtl: true, force: !!force })
  })
```

(The list-refresh in the renderer happens automatically: `runWorktreeRemoval` emits `worktrees:changed` and the group thunk emits the workspace-groups change event, both of which the renderer already subscribes to.)

**Step 4: Typecheck**

Run: `pnpm tc:node`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(archive): forward force through cleanup thunks; add on-demand prune IPC"
```

---

## Task 5: Preload bridge + api types

**Files:**
- Modify: `src/preload/index.ts` (worktrees object, near `restore`/`_archiveCleanupNow` ~459-467)
- Modify: `src/preload/api-types.ts` (worktrees interface ~505)

**Step 1: Add the bridge methods**

In `src/preload/index.ts`, inside the `worktrees:` object, after the `restore:` method (around line 459) add:

```ts
    cleanupArchivedNow: (): Promise<void> => ipcRenderer.invoke('worktrees:cleanupArchivedNow'),

    pruneAllArchivedNow: (force: boolean): Promise<void> =>
      ipcRenderer.invoke('worktrees:pruneAllArchivedNow', force),
```

**Step 2: Add the type declarations**

In `src/preload/api-types.ts`, inside the `worktrees: { ... }` block, after the `_archiveCleanupNow?` field (around line 505) add:

```ts
    /** Run the archive cleanup pass on demand, honoring the configured per-type
     *  durations (same as the hourly tick). */
    cleanupArchivedNow: () => Promise<void>
    /** Immediately delete every archived worktree and group, ignoring the
     *  configured durations. force=true also removes worktrees with
     *  uncommitted/untracked changes (git worktree remove --force). */
    pruneAllArchivedNow: (force: boolean) => Promise<void>
```

**Step 3: Typecheck (preload is enforced — see docs/preload-typecheck-hole.md)**

Run: `pnpm tc:node`
Expected: PASS.

**Step 4: Commit**

```bash
git add src/preload/index.ts src/preload/api-types.ts
git commit -m "feat(archive): expose cleanupArchivedNow + pruneAllArchivedNow on window.api.worktrees"
```

---

## Task 6: Search entries for the new section

**Files:**
- Modify: `src/renderer/src/components/settings/general-search.ts`

**Step 1: Add the archive search entries**

In `src/renderer/src/components/settings/general-search.ts`, before the `GENERAL_PANE_SEARCH_ENTRIES` aggregate (line 123), add:

```ts
export const GENERAL_ARCHIVE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Keep Archived Workspaces',
    description: 'How long archived worktrees are kept before being permanently deleted.',
    keywords: ['archive', 'prune', 'cleanup', 'retention', 'duration', 'worktree', 'delete', 'ttl']
  },
  {
    title: 'Keep Archived Groups',
    description: 'How long archived workspace groups are kept before being permanently deleted.',
    keywords: ['archive', 'prune', 'cleanup', 'retention', 'duration', 'group', 'delete', 'ttl']
  },
  {
    title: 'Prune Archived Workspaces Now',
    description: 'Run cleanup on demand or delete all archived workspaces immediately.',
    keywords: ['prune', 'cleanup', 'archive', 'now', 'force', 'delete', 'all']
  }
]
```

**Step 2: Register them in the pane aggregate**

In the `GENERAL_PANE_SEARCH_ENTRIES` array (line 123), add a spread entry:

```ts
  ...GENERAL_ARCHIVE_SEARCH_ENTRIES,
```

(e.g. after `...GENERAL_WORKSPACE_SEARCH_ENTRIES,`)

**Step 3: Typecheck and commit**

Run: `pnpm tc:web`
Expected: PASS.

```bash
git add src/renderer/src/components/settings/general-search.ts
git commit -m "feat(settings): search entries for Workspace Archiving section"
```

---

## Task 7: Settings UI — duration rows, buttons, and prune-all dialog

**Files:**
- Modify: `src/renderer/src/components/settings/GeneralPane.tsx`

**Step 1: Add imports**

At the top of `GeneralPane.tsx`:

- Change the `lucide-react` import to include the dialog icons:
  ```ts
  import { Check, FolderOpen, LoaderCircle, Timer, Trash2 } from 'lucide-react'
  ```
- Add:
  ```ts
  import { toast } from 'sonner'
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
  } from '../ui/dialog'
  import { ARCHIVE_TTL_MS } from '../../../../shared/archive-constants'
  import {
    msToDurationParts,
    durationPartsToMs,
    type DurationUnit
  } from '../../../../shared/archive-duration'
  ```
- Add `GENERAL_ARCHIVE_SEARCH_ENTRIES` to the existing `from './general-search'` import list.

**Step 2: Add the reusable duration row component**

Above `export function GeneralPane(...)`, add a module-local component:

```tsx
function ArchiveDurationRow({
  id,
  title,
  description,
  keywords,
  valueMs,
  onChangeMs
}: {
  id: string
  title: string
  description: string
  keywords: string[]
  valueMs: number
  onChangeMs: (ms: number) => void
}): React.JSX.Element {
  const parts = msToDurationParts(valueMs)
  const [draft, setDraft] = useState(String(parts.value))
  // Why: re-sync the visible number when the persisted value changes externally,
  // without clobbering a mid-edit draft on every keystroke.
  useEffect(() => {
    setDraft(String(msToDurationParts(valueMs).value))
  }, [valueMs])

  const commit = (rawValue: string, unit: DurationUnit): void => {
    const n = Number(rawValue)
    if (!Number.isFinite(n) || n <= 0) {
      setDraft(String(msToDurationParts(valueMs).value))
      return
    }
    onChangeMs(durationPartsToMs(n, unit))
  }

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={keywords}
      className="flex items-center justify-between gap-4 px-1 py-2"
    >
      <div className="space-y-0.5">
        <Label>{title}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          min={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(draft, parts.unit)}
          className="h-7 w-16 text-xs"
        />
        <Select value={parts.unit} onValueChange={(u) => commit(draft, u as DurationUnit)}>
          <SelectTrigger size="sm" className="h-7 w-[110px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hours">Hours</SelectItem>
            <SelectItem value="days">Days</SelectItem>
            <SelectItem value="weeks">Weeks</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </SearchableSetting>
  )
}
```

**Step 3: Add component state + handlers**

Inside `GeneralPane`, after the existing `searchQuery`/draft state (near line 39-48), add:

```tsx
  const [pruneAllOpen, setPruneAllOpen] = useState(false)
  const [pruneForce, setPruneForce] = useState(false)
  const [pruneBusy, setPruneBusy] = useState(false)

  // Why: the force option is a one-shot intent — reset it whenever the dialog
  // closes so the next open starts unchecked.
  useEffect(() => {
    if (!pruneAllOpen) {
      setPruneForce(false)
    }
  }, [pruneAllOpen])

  const handleCleanupNow = async (): Promise<void> => {
    try {
      await window.api.worktrees.cleanupArchivedNow()
      toast.success('Cleaned up expired archived workspaces.')
    } catch (err) {
      toast.error('Cleanup failed', {
        description: err instanceof Error ? err.message : String(err)
      })
    }
  }

  const handlePruneAll = async (): Promise<void> => {
    setPruneBusy(true)
    try {
      await window.api.worktrees.pruneAllArchivedNow(pruneForce)
      toast.success('Pruned all archived workspaces.')
      setPruneAllOpen(false)
    } catch (err) {
      toast.error('Prune failed', {
        description: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setPruneBusy(false)
    }
  }
```

**Step 4: Add the new section to `visibleSections`**

Inside the `visibleSections` array (after the Workspace section, before the Editor section ~line 222), add:

```tsx
    matchesSettingsSearch(searchQuery, GENERAL_ARCHIVE_SEARCH_ENTRIES) ? (
      <section key="workspace-archiving" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Workspace Archiving</h3>
          <p className="text-xs text-muted-foreground">
            How long archived workspaces are kept before they&apos;re permanently deleted.
          </p>
        </div>

        <ArchiveDurationRow
          id="general-archive-worktree-ttl"
          title="Keep Archived Workspaces"
          description="Archived worktrees are permanently deleted after this long."
          keywords={['archive', 'prune', 'cleanup', 'retention', 'duration', 'worktree', 'delete', 'ttl']}
          valueMs={settings.archiveWorktreeTtlMs ?? ARCHIVE_TTL_MS}
          onChangeMs={(ms) => updateSettings({ archiveWorktreeTtlMs: ms })}
        />

        <ArchiveDurationRow
          id="general-archive-group-ttl"
          title="Keep Archived Groups"
          description="Archived workspace groups are permanently deleted after this long."
          keywords={['archive', 'prune', 'cleanup', 'retention', 'duration', 'group', 'delete', 'ttl']}
          valueMs={settings.archiveGroupTtlMs ?? ARCHIVE_TTL_MS}
          onChangeMs={(ms) => updateSettings({ archiveGroupTtlMs: ms })}
        />

        <SearchableSetting
          title="Prune Archived Workspaces Now"
          description="Run cleanup on demand or delete all archived workspaces immediately."
          keywords={['prune', 'cleanup', 'archive', 'now', 'force', 'delete', 'all']}
          className="flex items-center justify-between gap-4 px-1 py-2"
        >
          <div className="space-y-0.5">
            <Label>Prune Now</Label>
            <p className="text-xs text-muted-foreground">
              Run cleanup now (respects the durations above), or prune every archived workspace
              immediately.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleCleanupNow}>
              Run cleanup now
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setPruneAllOpen(true)}>
              Prune all archived now
            </Button>
          </div>
        </SearchableSetting>
      </section>
    ) : null,
```

**Step 5: Render the confirmation dialog**

In the component's `return`, change the outer wrapper to include the dialog after the sections map. Replace:

```tsx
  return (
    <div className="space-y-8">
      {visibleSections.map((section, index) => (
        <div key={index} className="space-y-8">
          {index > 0 ? <Separator /> : null}
          {section}
        </div>
      ))}
    </div>
  )
```

with:

```tsx
  return (
    <div className="space-y-8">
      {visibleSections.map((section, index) => (
        <div key={index} className="space-y-8">
          {index > 0 ? <Separator /> : null}
          {section}
        </div>
      ))}

      <Dialog
        open={pruneAllOpen}
        onOpenChange={(open) => {
          if (!pruneBusy) {
            setPruneAllOpen(open)
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">Prune all archived workspaces?</DialogTitle>
            <DialogDescription className="text-xs">
              Permanently delete every archived workspace and group right now, ignoring the
              configured durations. This cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <button
            type="button"
            role="checkbox"
            aria-checked={pruneForce}
            onClick={() => setPruneForce((prev) => !prev)}
            className="flex items-center gap-2 rounded-sm px-1 py-1 text-xs text-foreground/80 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              className={`flex size-4 items-center justify-center rounded-sm border transition-colors ${
                pruneForce
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-muted-foreground bg-transparent'
              }`}
            >
              {pruneForce ? <Check className="size-3" strokeWidth={3} /> : null}
            </span>
            Also delete workspaces with uncommitted changes
          </button>

          <DialogFooter>
            <Button variant="outline" onClick={() => setPruneAllOpen(false)} disabled={pruneBusy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handlePruneAll} disabled={pruneBusy}>
              {pruneBusy ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 />}
              {pruneBusy ? 'Pruning…' : 'Prune all'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
```

**Step 6: Typecheck**

Run: `pnpm tc:web`
Expected: PASS.

**Step 7: Commit**

```bash
git add src/renderer/src/components/settings/GeneralPane.tsx
git commit -m "feat(settings): Workspace Archiving section with durations + prune-now actions"
```

---

## Task 8: Full verification pass

**Step 1: Typecheck both projects**

Run: `pnpm tc:node && pnpm tc:web`
Expected: PASS (both).

**Step 2: Run the touched tests**

Run: `pnpm vitest run src/shared/archive-duration.test.ts src/main/archive/cleanup-service.test.ts`
Expected: PASS (all).

**Step 3: Manual smoke check (optional but recommended)**

Use the `/run` skill or `pnpm dev` to launch the app:
1. Open Settings → General → Workspace Archiving.
2. Confirm both duration rows show "3 Days" by default; change one to "12 Hours" and reopen Settings to confirm it persisted.
3. Click "Run cleanup now" → expect a success toast, no errors.
4. Archive a worktree, click "Prune all archived now", confirm in the dialog → expect it disappears from the Archived view; with a dirty worktree, the "Also delete…with uncommitted changes" option deletes it too.

**Step 4: Final commit (if the smoke check required tweaks)**

```bash
git add -A
git commit -m "chore(archive): verification fixups for configurable prune"
```

---

## Out of Scope / Notes

- The cleanup *interval* (`ARCHIVE_CLEANUP_INTERVAL_MS`) stays hardcoded.
- No enable/disable toggle — durations clamp to ≥1 hour instead.
- The E2E-only `worktrees:_archiveCleanupNow` handler is left untouched.
- Force-prune still passes `skipArchive: true` — the repo's `orca.yaml` `archive` hook never runs from cleanup.
- Renderer list refresh relies on the existing `worktrees:changed` / workspace-groups change events emitted by the removal pipeline; no manual refetch is added.
