# Archive Worktrees Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the hard-delete action on worktrees with a soft **Archive** that hides the worktree and runs a real delete after a 30-day grace window. "Delete now" survives only inside a new Archived sidebar view.

**Architecture:** Two new persisted fields on `WorktreeMeta` (`archivedAt`, `archiveCleanupError`) drive the soft state. Two new IPC handlers (`worktrees:archive`, `worktrees:restore`) flip metadata. A long-lived `archive/cleanup-service.ts` in main runs once on startup and hourly, calling a factored-out `runWorktreeRemoval()` to do the actual delete after 30 days. Renderer gets an `archiveWorktree` store action, a new `ArchivedSection` sidebar disclosure, and the existing delete entrypoints flip to archive.

**Tech Stack:** Electron, TypeScript, React, Zustand, Vitest, Playwright. Renderer uses shadcn primitives + design tokens per `docs/STYLEGUIDE.md`.

**Reference design:** `docs/plans/2026-05-20-archive-worktrees-design.md`

**Conventions / commands:**
- Typecheck: `pnpm tc` (uses tsgo, not tsc)
- Unit tests: `pnpm test <pattern>` (Vitest)
- E2E tests: `pnpm test:e2e <pattern>` (Playwright)
- TDD: write failing test → run → implement → run → commit. One step ≈ 2–5 min.
- Comments: keep short, document the WHY only. Don't explain WHAT the code does.
- Naming: never `helpers`/`utils`/`shared`. Pick a domain name (`archive-cleanup`, `archive-section`).

---

## Phase 1 — Persistence schema and constants

### Task 1.1: Add archive constants

**Files:**
- Create: `src/shared/archive-constants.ts`

**Step 1: Write the file**

```ts
// Why: TTL is shared between the cleanup service (main) and the Archived
// view's countdown (renderer). Centralizing avoids drift and gives tests a
// single override point.
export const ARCHIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const ARCHIVE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
```

**Step 2: Typecheck**

Run: `pnpm tc`
Expected: PASS

**Step 3: Commit**

```bash
git add src/shared/archive-constants.ts
git commit -m "feat(worktrees): add archive TTL constants"
```

---

### Task 1.2: Extend WorktreeMeta + Worktree types

**Files:**
- Modify: `src/shared/types.ts` (the `Worktree` type around line 107 and `WorktreeMeta` around line 152)

**Step 1: Add fields**

In `Worktree` (after `isArchived: boolean`):

```ts
  /** ms epoch when archive was set; null when not archived. */
  archivedAt: number | null
  /** Last cleanup attempt failure message; null/absent when never blocked. */
  archiveCleanupError?: string | null
```

In `WorktreeMeta` (after `isArchived: boolean`):

```ts
  archivedAt: number | null
  archiveCleanupError?: string | null
```

**Step 2: Typecheck (expect callsite failures)**

Run: `pnpm tc`
Expected: errors in `worktree-logic.ts`, `persistence.ts`, and tests that build `WorktreeMeta` literals.

**Step 3: Update `getDefaultWorktreeMeta` in `src/main/persistence.ts:1572`**

Add `archivedAt: null` (omit `archiveCleanupError` — it's optional and `null` is the default-by-absence).

**Step 4: Update `toWorktree` in `src/main/ipc/worktree-logic.ts` around line 241**

Add inside the returned object near `isArchived`:

```ts
    isArchived: meta?.isArchived ?? false,
    archivedAt: meta?.archivedAt ?? null,
    ...(meta?.archiveCleanupError != null ? { archiveCleanupError: meta.archiveCleanupError } : {}),
```

**Step 5: Update test fixtures**

Search for all `isArchived: false` callsites and add `archivedAt: null` next to each. Use:

```bash
rg -n "isArchived: false" -g '*.ts' -g '*.tsx' -g '!node_modules' -l
```

Update each file. Files known to be affected (from earlier audit):
- `src/renderer/src/store/slices/terminals.ts`
- `src/renderer/src/store/slices/diffComments.test.ts`
- `src/renderer/src/store/slices/store-test-helpers.ts`
- `src/renderer/src/store/slices/tabs.test.ts` (3 sites)
- `src/renderer/src/store/slices/store-session-cascades.test.ts`
- `src/renderer/src/lib/agent-status-count.test.ts`
- `src/renderer/src/lib/worktree-palette-search.test.ts`
- `src/renderer/src/lib/order-empty-query-worktrees.test.ts`
- `src/renderer/src/store/slices/worktrees.test.ts`
- `src/renderer/src/lib/browser-palette-search.test.ts`
- `src/renderer/src/lib/worktree-activation-created-agent.test.ts`
- `src/main/persistence.test.ts` (~6 sites)
- `src/main/runtime/orca-runtime.test.ts` (2 sites)
- `src/main/runtime/runtime-rpc.test.ts`
- `src/main/ipc/worktrees.test.ts` (3 sites)
- `src/main/ipc/worktree-logic-created-agent.test.ts`
- `src/main/ipc/worktree-logic.test.ts` (3 sites)
- `src/renderer/src/components/activity/ActivityPrototypePage.test.ts`
- `src/renderer/src/components/sidebar/WorktreeCard.diff-stats.test.tsx`
- `src/renderer/src/components/WorktreeContextBar.test.tsx`
- `src/renderer/src/components/dashboard/useRetainedAgentsSync.test.ts`

For the runtime that mirrors persisted meta (`src/main/runtime/orca-runtime.ts:2050`), also add `archivedAt: meta.archivedAt ?? existingMeta?.archivedAt ?? null`.

**Step 6: Typecheck**

Run: `pnpm tc`
Expected: PASS

**Step 7: Run all unit tests**

Run: `pnpm test`
Expected: PASS

**Step 8: Commit**

```bash
git add src/shared/types.ts src/main/persistence.ts src/main/ipc/worktree-logic.ts src/main/runtime/orca-runtime.ts src/renderer src/main/persistence.test.ts src/main/runtime src/main/ipc tests
git commit -m "feat(worktrees): add archivedAt + archiveCleanupError to WorktreeMeta"
```

---

### Task 1.3: Persistence round-trip test

**Files:**
- Modify: `src/main/persistence.test.ts`

**Step 1: Write failing test**

Inside an existing describe block:

```ts
it('persists archivedAt and archiveCleanupError across save/load', async () => {
  const store = await makeStore() // use existing test helper
  const worktreeId = 'repo1::/tmp/repo1/wt-a'
  store.setWorktreeMeta(worktreeId, {
    isArchived: true,
    archivedAt: 1_700_000_000_000,
    archiveCleanupError: 'has uncommitted changes'
  })
  await store.flushPendingWrite?.() // or whatever the existing test uses
  const reloaded = await loadStoreFromSameDir() // existing helper
  const meta = reloaded.getWorktreeMeta(worktreeId)
  expect(meta?.isArchived).toBe(true)
  expect(meta?.archivedAt).toBe(1_700_000_000_000)
  expect(meta?.archiveCleanupError).toBe('has uncommitted changes')
})
```

Look at adjacent tests in `persistence.test.ts` for the actual test scaffold names — adapt accordingly.

**Step 2: Run test**

Run: `pnpm test src/main/persistence.test.ts`
Expected: PASS (the persistence layer already writes whatever's in meta; this is a safety net).

**Step 3: Commit**

```bash
git add src/main/persistence.test.ts
git commit -m "test(persistence): cover archive metadata round-trip"
```

---

## Phase 2 — Factor the real-delete code path

### Task 2.1: Extract `runWorktreeRemoval`

The existing `worktrees:remove` handler at `src/main/ipc/worktrees.ts:404-516` does the full delete dance: kill PTYs/run/setup → run archive hook → unlink symlinks → `git worktree remove` (with orphan-recovery fallback) → cleanup meta + history dir + auth roots + notify. The cleanup service needs all of this.

**Files:**
- Create: `src/main/worktree-removal/run-worktree-removal.ts`
- Modify: `src/main/ipc/worktrees.ts` (the `worktrees:remove` body)

**Step 1: Write the function**

Move the body of the `worktrees:remove` handler verbatim into:

```ts
// src/main/worktree-removal/run-worktree-removal.ts
import type { BrowserWindow } from 'electron'
// ... imports moved from worktrees.ts
import type { PersistenceStore } from '../persistence'
import type { OrcaRuntime } from '../runtime/orca-runtime'

export type RunWorktreeRemovalArgs = {
  worktreeId: string
  force?: boolean
  skipArchive?: boolean
}

export type RunWorktreeRemovalDeps = {
  store: PersistenceStore
  runtime: OrcaRuntime
  mainWindow: BrowserWindow | null
}

export async function runWorktreeRemoval(
  args: RunWorktreeRemovalArgs,
  deps: RunWorktreeRemovalDeps
): Promise<void> {
  // ... entire existing body of the IPC handler, parameterised on deps
}
```

Keep all the existing `// Why:` comments verbatim — they explain ordering invariants.

**Step 2: Replace the IPC handler body**

`worktrees:remove` becomes:

```ts
ipcMain.handle(
  'worktrees:remove',
  async (_event, args: { worktreeId: string; force?: boolean; skipArchive?: boolean }) => {
    await runWorktreeRemoval(args, { store, runtime, mainWindow })
  }
)
```

**Step 3: Typecheck**

Run: `pnpm tc`
Expected: PASS

**Step 4: Run existing worktree IPC tests**

Run: `pnpm test src/main/ipc/worktrees.test.ts`
Expected: PASS (behavior is unchanged — pure refactor).

**Step 5: Commit**

```bash
git add src/main/worktree-removal/run-worktree-removal.ts src/main/ipc/worktrees.ts
git commit -m "refactor(worktrees): extract runWorktreeRemoval from IPC handler"
```

---

## Phase 3 — Archive / restore IPC + store actions

### Task 3.1: Write failing IPC handler test

**Files:**
- Modify: `src/main/ipc/worktrees.test.ts`

**Step 1: Write failing tests**

Add a new describe block. Use the existing test setup pattern in that file.

```ts
describe('worktrees:archive + worktrees:restore', () => {
  it('archive sets isArchived=true, archivedAt=now, and clears archiveCleanupError', async () => {
    const { store, invoke } = await setupWorktreeIpc() // existing helper, or build per file conventions
    const worktreeId = makeFakeWorktree(store)
    store.setWorktreeMeta(worktreeId, { archiveCleanupError: 'previous error' })

    const before = Date.now()
    await invoke('worktrees:archive', { worktreeId })
    const after = Date.now()

    const meta = store.getWorktreeMeta(worktreeId)
    expect(meta?.isArchived).toBe(true)
    expect(meta?.archivedAt).toBeGreaterThanOrEqual(before)
    expect(meta?.archivedAt).toBeLessThanOrEqual(after)
    expect(meta?.archiveCleanupError).toBeNull()
  })

  it('restore clears isArchived, archivedAt, and archiveCleanupError', async () => {
    const { store, invoke } = await setupWorktreeIpc()
    const worktreeId = makeFakeWorktree(store)
    store.setWorktreeMeta(worktreeId, {
      isArchived: true,
      archivedAt: 123,
      archiveCleanupError: 'boom'
    })

    await invoke('worktrees:restore', { worktreeId })

    const meta = store.getWorktreeMeta(worktreeId)
    expect(meta?.isArchived).toBe(false)
    expect(meta?.archivedAt).toBeNull()
    expect(meta?.archiveCleanupError).toBeNull()
  })

  it('archive refuses to archive the main worktree', async () => {
    const { store, invoke } = await setupWorktreeIpc()
    const mainId = makeFakeMainWorktree(store)
    await expect(invoke('worktrees:archive', { worktreeId: mainId })).rejects.toThrow(
      /main worktree/i
    )
  })
})
```

Note: adapt `setupWorktreeIpc`, `makeFakeWorktree`, `makeFakeMainWorktree` to whatever the file already uses. If those helpers don't exist, follow the pattern of the closest existing test in the file.

**Step 2: Run the test**

Run: `pnpm test src/main/ipc/worktrees.test.ts -t archive`
Expected: FAIL — handlers don't exist.

**Step 3: Commit (failing test)**

```bash
git add src/main/ipc/worktrees.test.ts
git commit -m "test(worktrees): failing tests for archive + restore IPC"
```

---

### Task 3.2: Implement `worktrees:archive` and `worktrees:restore` handlers

**Files:**
- Modify: `src/main/ipc/worktrees.ts`

**Step 1: Add handlers**

In `registerWorktreeIpc` (or wherever the existing handlers are registered, near `worktrees:remove`):

```ts
ipcMain.handle('worktrees:archive', (_event, args: { worktreeId: string }) => {
  const { repoId, worktreePath } = parseWorktreeId(args.worktreeId)
  // Why: the main worktree backs the repo entry itself; archiving it would
  // hide the repo with no way to restore.
  const list = store.getGitWorktreeList?.(repoId) // or however main-flag is read
  const isMain = list?.some((w) => w.path === worktreePath && w.isMainWorktree)
  if (isMain) {
    throw new Error('Cannot archive the main worktree.')
  }
  store.setWorktreeMeta(args.worktreeId, {
    isArchived: true,
    archivedAt: Date.now(),
    archiveCleanupError: null
  })
  notifyWorktreesChanged(mainWindow, repoId)
})

ipcMain.handle('worktrees:restore', (_event, args: { worktreeId: string }) => {
  const { repoId } = parseWorktreeId(args.worktreeId)
  store.setWorktreeMeta(args.worktreeId, {
    isArchived: false,
    archivedAt: null,
    archiveCleanupError: null
  })
  notifyWorktreesChanged(mainWindow, repoId)
})
```

Also add the matching `ipcMain.removeHandler` entries in the cleanup block at the top of the file (around line 108-118).

**Step 2: Run the test**

Run: `pnpm test src/main/ipc/worktrees.test.ts -t archive`
Expected: PASS

**Step 3: Add preload bindings**

In `src/preload/index.ts`, near line 443:

```ts
archive: (args: { worktreeId: string }): Promise<void> =>
  ipcRenderer.invoke('worktrees:archive', args),
restore: (args: { worktreeId: string }): Promise<void> =>
  ipcRenderer.invoke('worktrees:restore', args),
```

Also add to the corresponding type definition for `window.api.worktrees`. Check `src/preload/api.d.ts` or wherever the surface type lives — `pnpm tc` will tell you.

**Step 4: Typecheck**

Run: `pnpm tc`
Expected: PASS

**Step 5: Commit**

```bash
git add src/main/ipc/worktrees.ts src/preload
git commit -m "feat(worktrees): add archive + restore IPC handlers"
```

---

### Task 3.3: Add store actions

**Files:**
- Modify: `src/renderer/src/store/slices/worktrees.ts`

**Step 1: Write the actions**

Near `removeWorktree` (line 307), add:

```ts
archiveWorktree: async (worktreeId: string) => {
  await window.api.worktrees.archive({ worktreeId })
  // The main-side worktrees:changed broadcast will refresh the list; nothing
  // to mutate optimistically here. Filters drop isArchived from the sidebar
  // automatically.
},

restoreWorktree: async (worktreeId: string) => {
  await window.api.worktrees.restore({ worktreeId })
},
```

Add corresponding type entries to the slice's `Slice` type (search for `removeWorktree:` signature in the same file).

**Step 2: Write the unit test**

In `src/renderer/src/store/slices/worktrees.test.ts`, mirror an existing `removeWorktree` test:

```ts
it('archiveWorktree calls IPC with the worktree id', async () => {
  const apiMock = vi.fn().mockResolvedValue(undefined)
  // wire mock as adjacent tests do
  await useAppStore.getState().archiveWorktree('repo1::/path/a')
  expect(apiMock).toHaveBeenCalledWith({ worktreeId: 'repo1::/path/a' })
})

it('restoreWorktree calls IPC with the worktree id', async () => {
  // same pattern
})
```

**Step 3: Run tests**

Run: `pnpm test src/renderer/src/store/slices/worktrees.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/renderer/src/store/slices/worktrees.ts src/renderer/src/store/slices/worktrees.test.ts
git commit -m "feat(worktrees): add archive/restore store actions"
```

---

## Phase 4 — Swap delete UI for archive UI

### Task 4.1: Rename `delete-worktree-flow.ts` → `archive-worktree-flow.ts`

**Files:**
- Move: `src/renderer/src/components/sidebar/delete-worktree-flow.ts` → `archive-worktree-flow.ts`
- Move: `src/renderer/src/components/sidebar/delete-worktree-flow.test.ts` → `archive-worktree-flow.test.ts`
- Update imports in `WorktreeContextMenu.tsx`, `MemoryStatusSegment.tsx`, and any other call sites

**Step 1: Locate call sites**

Run: `rg -n "delete-worktree-flow" src/`

**Step 2: Move the files**

```bash
git mv src/renderer/src/components/sidebar/delete-worktree-flow.ts \
       src/renderer/src/components/sidebar/archive-worktree-flow.ts
git mv src/renderer/src/components/sidebar/delete-worktree-flow.test.ts \
       src/renderer/src/components/sidebar/archive-worktree-flow.test.ts
```

**Step 3: Update imports**

Update every import that references the old path. The Edit tool with `replace_all=true` works for `delete-worktree-flow` → `archive-worktree-flow` per file.

**Step 4: Typecheck**

Run: `pnpm tc`
Expected: PASS

**Step 5: Commit (rename only, no behaviour change)**

```bash
git add -A
git commit -m "refactor(sidebar): rename delete-worktree-flow to archive-worktree-flow"
```

---

### Task 4.2: Rewrite the flow to use archive

**Files:**
- Modify: `src/renderer/src/components/sidebar/archive-worktree-flow.ts`
- Modify: `src/renderer/src/components/sidebar/archive-worktree-flow.test.ts`

**Step 1: Write failing tests for the new behaviour**

The new behaviour:
- `runWorktreeArchive(id)` calls `archiveWorktree(id)`, then shows an info toast `"Archived '<name>' — will be deleted in 30 days"` with an `Undo` action that calls `restoreWorktree(id)`.
- No modal, no skip-confirm setting check, no force-delete recovery.
- Failures surface a destructive toast.
- Main worktrees no-op (existing guard).

```ts
describe('runWorktreeArchive', () => {
  it('calls archive, shows toast with undo action that restores', async () => {
    // arrange archiveWorktree + restoreWorktree mocks and a worktree
    runWorktreeArchive('wt-1')
    await tick()
    expect(mocks.archiveWorktree).toHaveBeenCalledWith('wt-1')
    expect(toast.info).toHaveBeenCalledWith(
      expect.stringContaining("Archived 'My Worktree'"),
      expect.objectContaining({
        action: expect.objectContaining({ label: 'Undo' })
      })
    )
    // simulate clicking Undo
    const action = (toast.info.mock.calls[0][1] as any).action
    action.onClick()
    expect(mocks.restoreWorktree).toHaveBeenCalledWith('wt-1')
  })

  it('no-ops for main worktree', () => {
    // arrange isMainWorktree: true
    runWorktreeArchive('wt-main')
    expect(mocks.archiveWorktree).not.toHaveBeenCalled()
  })

  it('surfaces destructive toast on archive failure', async () => {
    mocks.archiveWorktree.mockRejectedValue(new Error('IPC down'))
    runWorktreeArchive('wt-1')
    await tick()
    expect(toast.error).toHaveBeenCalled()
  })
})
```

Remove or rewrite the existing tests in the file that reference force-delete recovery or `openModal('delete-worktree', ...)`.

**Step 2: Run tests**

Run: `pnpm test src/renderer/src/components/sidebar/archive-worktree-flow.test.ts`
Expected: FAIL (functions don't exist yet).

**Step 3: Replace the file body**

```ts
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { getWorktreeMapFromState } from '@/store/selectors'

export function runWorktreeArchive(worktreeId: string): void {
  const state = useAppStore.getState()
  const target = getWorktreeMapFromState(state).get(worktreeId) ?? null
  if (!target || target.isMainWorktree) {
    return
  }

  state
    .archiveWorktree(worktreeId)
    .then(() => {
      toast.info(`Archived '${target.displayName}' — will be deleted in 30 days`, {
        duration: 10000,
        action: {
          label: 'Undo',
          onClick: () => {
            useAppStore
              .getState()
              .restoreWorktree(worktreeId)
              .catch((err: unknown) => {
                toast.error('Failed to restore worktree', {
                  description: err instanceof Error ? err.message : String(err)
                })
              })
          }
        }
      })
    })
    .catch((err: unknown) => {
      toast.error('Failed to archive worktree', {
        description: err instanceof Error ? err.message : String(err)
      })
    })
}

export function runWorktreeBatchArchive(worktreeIds: readonly string[]): void {
  const state = useAppStore.getState()
  const worktreeMap = getWorktreeMapFromState(state)
  const targets = worktreeIds
    .map((id) => worktreeMap.get(id) ?? null)
    .filter((w): w is NonNullable<typeof w> => w != null && !w.isMainWorktree)
  if (targets.length === 0) return
  for (const target of targets) {
    runWorktreeArchive(target.id)
  }
}
```

**Step 4: Run tests**

Run: `pnpm test src/renderer/src/components/sidebar/archive-worktree-flow.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/components/sidebar/archive-worktree-flow.ts src/renderer/src/components/sidebar/archive-worktree-flow.test.ts
git commit -m "feat(sidebar): replace delete flow with archive + undo"
```

---

### Task 4.3: Rewire callers, retire the delete modal

**Files:**
- Modify: `src/renderer/src/components/sidebar/WorktreeContextMenu.tsx`
- Modify: `src/renderer/src/components/right-sidebar/PRActions.tsx` (line 84 — calls `openModal('delete-worktree', ...)`)
- Modify: `src/renderer/src/components/sidebar/index.tsx` (if it routes the modal — verify)
- Delete: `src/renderer/src/components/sidebar/DeleteWorktreeDialog.tsx` after confirming no remaining references
- Modify: `src/renderer/src/store/slices/ui.ts:265` — keep `'delete-worktree'` in the modal union for now ONLY if `DeleteWorktreeDialog` is being kept temporarily; otherwise remove the union entry

**Step 1: Update WorktreeContextMenu**

Replace `runWorktreeDelete` / `runWorktreeBatchDelete` imports with `runWorktreeArchive` / `runWorktreeBatchArchive`. Rename `handleDelete` → `handleArchive`, swap the menu label to "Archive Selected" / "Archive N Workspaces", swap the tooltip copy ("The main worktree cannot be archived"). Wire `onSelect` to the new handler.

**Step 2: Update PRActions.tsx:84**

Replace `openModal('delete-worktree', { worktreeId: worktree.id })` with `runWorktreeArchive(worktree.id)`.

**Step 3: Decide on DeleteWorktreeDialog fate**

The Archived view's "Delete now" still needs the confirm/force-delete UX. Two options:
- **(a)** Keep `DeleteWorktreeDialog.tsx` for the "Delete now" path, just rename it to `DeleteArchivedWorktreeDialog.tsx` and only open it from the Archived view in Task 5.2.
- **(b)** Inline a smaller confirm into the Archived view since there's no longer a skip-confirm setting.

Recommended: **(a)** — DRY, the existing dialog already handles the force-delete recovery flow.

If (a): leave `DeleteWorktreeDialog.tsx` in place for now, but verify no caller opens it via context menu anymore.

**Step 4: Update the existing `skipDeleteWorktreeConfirm` setting**

Search: `rg -n "skipDeleteWorktreeConfirm" -g '*.ts' -g '*.tsx'`

Since archive has no confirm step (just an undo toast), this setting becomes meaningless for the archive path. Two cleanup paths:
- Strict: remove the setting field and any UI that exposes it.
- Pragmatic: leave the setting in place — it now only affects the Archived view's "Delete now" path.

Recommended: **leave it** — minimises blast radius and the Archived-view delete still has a confirm step that benefits from the skip toggle.

**Step 5: Typecheck**

Run: `pnpm tc`
Expected: PASS

**Step 6: Run all unit tests**

Run: `pnpm test`
Expected: PASS

**Step 7: Commit**

```bash
git add -A
git commit -m "feat(sidebar): swap delete UI entrypoints to archive"
```

---

## Phase 5 — Cleanup service

### Task 5.1: Write failing cleanup-service tests

**Files:**
- Create: `src/main/archive/cleanup-service.test.ts`

**Step 1: Write tests**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ARCHIVE_TTL_MS } from '../../shared/archive-constants'
// Adapt these to whatever the persistence test scaffold actually exports.
import { makeStore } from '../persistence.test-helpers'
import { createCleanupService } from './cleanup-service'

describe('archive cleanup service', () => {
  it('selects only archived worktrees past the TTL', async () => {
    const store = makeStore()
    const oldId = 'repo1::/path/old'
    const youngId = 'repo1::/path/young'
    const liveId = 'repo1::/path/live'
    store.setWorktreeMeta(oldId, {
      isArchived: true,
      archivedAt: Date.now() - ARCHIVE_TTL_MS - 1000
    })
    store.setWorktreeMeta(youngId, { isArchived: true, archivedAt: Date.now() })
    store.setWorktreeMeta(liveId, { isArchived: false, archivedAt: null })

    const removed: string[] = []
    const service = createCleanupService({
      store,
      runRemoval: async (id) => {
        removed.push(id)
      }
    })

    await service.runOnce()

    expect(removed).toEqual([oldId])
  })

  it('records archiveCleanupError and leaves the worktree archived when removal throws', async () => {
    const store = makeStore()
    const id = 'repo1::/path/blocked'
    store.setWorktreeMeta(id, {
      isArchived: true,
      archivedAt: Date.now() - ARCHIVE_TTL_MS - 1000
    })

    const service = createCleanupService({
      store,
      runRemoval: async () => {
        throw new Error('worktree has uncommitted changes')
      }
    })

    await service.runOnce()

    const meta = store.getWorktreeMeta(id)
    expect(meta?.isArchived).toBe(true)
    expect(meta?.archivedAt).not.toBeNull()
    expect(meta?.archiveCleanupError).toContain('uncommitted changes')
  })

  it('retries blocked worktrees on the next tick', async () => {
    const store = makeStore()
    const id = 'repo1::/path/blocked'
    store.setWorktreeMeta(id, {
      isArchived: true,
      archivedAt: Date.now() - ARCHIVE_TTL_MS - 1000,
      archiveCleanupError: 'previous error'
    })

    let calls = 0
    const service = createCleanupService({
      store,
      runRemoval: async () => {
        calls++
        if (calls === 1) throw new Error('still blocked')
      }
    })

    await service.runOnce()
    expect(calls).toBe(1)
    await service.runOnce()
    expect(calls).toBe(2)
    expect(store.getWorktreeMeta(id)).toBeUndefined() // removal succeeded → meta removed by runRemoval
  })

  it('clears archiveCleanupError on success', async () => {
    const store = makeStore()
    const id = 'repo1::/path/ok'
    store.setWorktreeMeta(id, {
      isArchived: true,
      archivedAt: Date.now() - ARCHIVE_TTL_MS - 1000,
      archiveCleanupError: 'old error'
    })

    const service = createCleanupService({
      store,
      runRemoval: async (toRemove) => {
        store.removeWorktreeMeta(toRemove)
      }
    })

    await service.runOnce()
    expect(store.getWorktreeMeta(id)).toBeUndefined()
  })
})
```

**Step 2: Run**

Run: `pnpm test src/main/archive/cleanup-service.test.ts`
Expected: FAIL — module doesn't exist.

**Step 3: Commit**

```bash
git add src/main/archive/cleanup-service.test.ts
git commit -m "test(archive): failing tests for cleanup service"
```

---

### Task 5.2: Implement the cleanup service

**Files:**
- Create: `src/main/archive/cleanup-service.ts`

**Step 1: Write the module**

```ts
import { ARCHIVE_CLEANUP_INTERVAL_MS, ARCHIVE_TTL_MS } from '../../shared/archive-constants'
import type { PersistenceStore } from '../persistence'

export type CleanupServiceDeps = {
  store: PersistenceStore
  // Why: injected so tests can avoid the real worktree-removal pipeline.
  // The production wiring passes a function that calls runWorktreeRemoval.
  runRemoval: (worktreeId: string) => Promise<void>
  intervalMs?: number
  ttlMs?: number
  now?: () => number
}

export type CleanupService = {
  runOnce: () => Promise<void>
  start: () => void
  stop: () => void
}

export function createCleanupService(deps: CleanupServiceDeps): CleanupService {
  const ttl = deps.ttlMs ?? ARCHIVE_TTL_MS
  const interval = deps.intervalMs ?? ARCHIVE_CLEANUP_INTERVAL_MS
  const now = deps.now ?? Date.now
  let timer: ReturnType<typeof setInterval> | null = null

  async function runOnce(): Promise<void> {
    const allMeta = deps.store.getAllWorktreeMeta()
    const threshold = now() - ttl
    const candidates: string[] = []
    for (const [worktreeId, meta] of Object.entries(allMeta)) {
      if (!meta.isArchived) continue
      if (typeof meta.archivedAt !== 'number') continue
      if (meta.archivedAt > threshold) continue
      candidates.push(worktreeId)
    }
    for (const id of candidates) {
      try {
        await deps.runRemoval(id)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // Why: stay archived, surface the reason. archivedAt is NOT reset so
        // the next tick still considers it past TTL and retries.
        deps.store.setWorktreeMeta(id, { archiveCleanupError: message })
      }
    }
  }

  function start(): void {
    if (timer) return
    timer = setInterval(() => {
      runOnce().catch((err) => {
        console.error('[archive-cleanup] tick failed:', err)
      })
    }, interval)
    // Why: also run immediately on startup so users who quit the app for a
    // long stretch see expired worktrees cleaned up without waiting an hour.
    runOnce().catch((err) => {
      console.error('[archive-cleanup] startup tick failed:', err)
    })
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return { runOnce, start, stop }
}
```

**Step 2: Run tests**

Run: `pnpm test src/main/archive/cleanup-service.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add src/main/archive/cleanup-service.ts
git commit -m "feat(archive): cleanup service that removes worktrees past TTL"
```

---

### Task 5.3: Wire cleanup service into app startup

**Files:**
- Modify: the main process bootstrap that owns long-lived services. Locate with `rg -n "createWindow\|app.on\(.ready.\|whenReady\(\)" src/main/index.ts src/main/app*.ts 2>/dev/null | head -10`

**Step 1: Wire it**

After persistence is loaded and before window creation (so the startup tick fires while the splash is up, not after the user can interact):

```ts
import { createCleanupService } from './archive/cleanup-service'
import { runWorktreeRemoval } from './worktree-removal/run-worktree-removal'

const archiveCleanup = createCleanupService({
  store,
  runRemoval: (worktreeId) =>
    runWorktreeRemoval({ worktreeId, force: false }, { store, runtime, mainWindow })
})
archiveCleanup.start()
// Stop on app quit
app.on('before-quit', () => archiveCleanup.stop())
```

Note: `runWorktreeRemoval` needs `mainWindow` for the changed-notify call. If the service starts before the window is created, pass a getter (`getMainWindow()`) instead of capturing the variable.

**Step 2: Manual smoke**

Start the app, archive a worktree, then in the persistence file manually set `archivedAt` to `Date.now() - ARCHIVE_TTL_MS - 1000`, restart, and confirm the worktree gets removed at startup.

(Or use the e2e test below in Task 7.)

**Step 3: Commit**

```bash
git add -A
git commit -m "feat(archive): start cleanup service at main bootstrap"
```

---

## Phase 6 — Archived sidebar section

### Task 6.1: Write the visible-worktrees selector for archived items

**Files:**
- Modify: `src/renderer/src/components/sidebar/visible-worktrees.ts`

**Step 1: Add a selector**

```ts
export function getArchivedWorktrees(state: Pick<AppState, 'worktreesByRepo'>): Worktree[] {
  return getAllWorktreesFromState(state).filter((w) => w.isArchived)
}
```

Place it near `getAllWorktreesFromState` usage. Update existing tests for `visible-worktrees.ts` if any cover this file.

**Step 2: Test**

Add to existing visible-worktrees test file:

```ts
it('getArchivedWorktrees returns only archived worktrees', () => {
  const state = { worktreesByRepo: { repo1: [
    { ...sampleWorktree, id: 'a', isArchived: true },
    { ...sampleWorktree, id: 'b', isArchived: false }
  ]}}
  expect(getArchivedWorktrees(state).map(w => w.id)).toEqual(['a'])
})
```

**Step 3: Commit**

```bash
git add src/renderer/src/components/sidebar/visible-worktrees.ts
git commit -m "feat(sidebar): selector for archived worktrees"
```

---

### Task 6.2: Build the ArchivedSection component

**Files:**
- Create: `src/renderer/src/components/sidebar/ArchivedSection.tsx`
- Create: `src/renderer/src/components/sidebar/ArchivedSection.test.tsx`

**Style discipline:** Read `docs/STYLEGUIDE.md` and use only the design tokens in `src/renderer/src/assets/main.css` + shadcn primitives in `src/renderer/src/components/ui/`. Examples: use the `Collapsible` primitive if available, the existing sidebar `Button` variants, and `cn()` for class composition. No hardcoded color/spacing values.

**Step 1: Write failing component test**

```tsx
describe('<ArchivedSection />', () => {
  it('renders nothing when no archived worktrees', () => {
    const { container } = render(<ArchivedSection />, { wrapper: withStore({ archived: [] }) })
    expect(container).toBeEmptyDOMElement()
  })

  it('lists archived worktrees with days remaining', () => {
    const archivedAt = Date.now() - 3 * 24 * 60 * 60 * 1000 // 3 days ago
    render(<ArchivedSection />, {
      wrapper: withStore({
        archived: [{ id: 'wt-a', displayName: 'My WT', archivedAt }]
      })
    })
    expect(screen.getByText('My WT')).toBeInTheDocument()
    expect(screen.getByText(/27 days left/i)).toBeInTheDocument()
  })

  it('Restore button calls restoreWorktree', async () => {
    render(<ArchivedSection />, { wrapper: withStore({ archived: [sampleArchived] }) })
    await userEvent.click(screen.getByRole('button', { name: /restore/i }))
    expect(mocks.restoreWorktree).toHaveBeenCalledWith('wt-a')
  })

  it('Delete now opens DeleteWorktreeDialog for that worktree', async () => {
    render(<ArchivedSection />, { wrapper: withStore({ archived: [sampleArchived] }) })
    await userEvent.click(screen.getByRole('button', { name: /delete now/i }))
    expect(mocks.openModal).toHaveBeenCalledWith('delete-worktree', { worktreeId: 'wt-a' })
  })

  it('surfaces "Cleanup blocked" badge when archiveCleanupError is set', () => {
    render(<ArchivedSection />, {
      wrapper: withStore({
        archived: [{ ...sampleArchived, archiveCleanupError: 'uncommitted changes' }]
      })
    })
    expect(screen.getByText(/cleanup blocked/i)).toBeInTheDocument()
  })
})
```

**Step 2: Run**

Run: `pnpm test src/renderer/src/components/sidebar/ArchivedSection.test.tsx`
Expected: FAIL — component doesn't exist.

**Step 3: Implement the component**

Sketch — follow the styleguide for actual classes/primitives:

```tsx
import { useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { ARCHIVE_TTL_MS } from '../../../../shared/archive-constants'
import { getArchivedWorktrees } from './visible-worktrees'

function daysRemaining(archivedAt: number, now: number): number {
  const remaining = archivedAt + ARCHIVE_TTL_MS - now
  return Math.max(0, Math.ceil(remaining / (24 * 60 * 60 * 1000)))
}

export function ArchivedSection(): React.JSX.Element | null {
  const archived = useAppStore((s) => getArchivedWorktrees(s))
  const restoreWorktree = useAppStore((s) => s.restoreWorktree)
  const openModal = useAppStore((s) => s.openModal)
  const [open, setOpen] = useState(false)

  if (archived.length === 0) return null

  // Sort: most-recently archived first.
  const sorted = useMemo(
    () => [...archived].sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
    [archived]
  )

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger>
        Archived ({archived.length})
      </CollapsibleTrigger>
      <CollapsibleContent>
        {sorted.map((wt) => {
          const days = wt.archivedAt != null ? daysRemaining(wt.archivedAt, Date.now()) : 0
          return (
            <div key={wt.id}>
              <span>{wt.displayName}</span>
              {wt.archiveCleanupError ? (
                <span title={wt.archiveCleanupError}>Cleanup blocked</span>
              ) : (
                <span>{days} days left</span>
              )}
              <Button onClick={() => restoreWorktree(wt.id)}>Restore</Button>
              <Button
                variant="destructive"
                onClick={() => openModal('delete-worktree', { worktreeId: wt.id })}
              >
                Delete now
              </Button>
            </div>
          )
        })}
      </CollapsibleContent>
    </Collapsible>
  )
}
```

**Step 4: Run tests**

Run: `pnpm test src/renderer/src/components/sidebar/ArchivedSection.test.tsx`
Expected: PASS

**Step 5: Mount in the sidebar**

Add `<ArchivedSection />` at the bottom of the sidebar — `src/renderer/src/components/sidebar/index.tsx` or `WorktreeList.tsx`, after the normal worktree list. Verify visually in dev (`pnpm dev`).

**Step 6: Verify with the running app**

Run the app, archive a worktree from the context menu, confirm:
- It vanishes from the main list
- The Archived disclosure shows "(1)"
- Expanding shows the entry with "30 days left"
- Restore returns the worktree to the main list
- Delete now opens the existing DeleteWorktreeDialog

If any of those steps doesn't work, fix before committing.

**Step 7: Commit**

```bash
git add -A
git commit -m "feat(sidebar): archived section with restore + delete now"
```

---

### Task 6.3: Live countdown (optional polish)

The day count refreshes only on render. Re-rendering every minute is overkill; re-rendering when the section opens is fine for v1. Skip unless you want a clock — and if so, use a single shared `useNow(60_000)` hook in `ArchivedSection` so we don't spam re-renders across the tree.

---

## Phase 7 — Verification & E2E

### Task 7.1: Surface audit

**Step 1: Confirm all `getAllWorktreesFromState` consumers filter archived**

Run: `rg -n "getAllWorktreesFromState" -g '*.ts' -g '*.tsx' -g '!node_modules' -g '!*.test.*'`

For each result, verify the next 5 lines either filter `isArchived` or explicitly want all worktrees (e.g. the ArchivedSection selector itself). Already confirmed during plan-writing:
- `visible-worktrees.ts:94, 175` — filtered
- `WorktreeList.tsx:662` — filtered
- `WorktreeJumpPalette.tsx:199, 646, 705` — filtered
- `useDashboardData.ts:123`, `useRetainedAgents.ts:54` — filtered

If new call sites have been added since plan time, add the filter.

**Step 2: Commit any fixes**

If no fixes needed, no commit.

---

### Task 7.2: E2E — archive + undo

**Files:**
- Create: `tests/e2e/worktree-archive.spec.ts`

Model after `tests/e2e/worktree-lifecycle.spec.ts`. Steps:

1. Create a worktree.
2. Right-click → Archive.
3. Assert it disappears from the main list.
4. Assert Archived disclosure shows "(1)".
5. Click Undo on the toast (within the 10s window).
6. Assert worktree returns to main list, Archived disclosure disappears.

Run: `pnpm test:e2e worktree-archive`
Expected: PASS

Commit.

---

### Task 7.3: E2E — TTL cleanup

**Files:**
- Modify: same `tests/e2e/worktree-archive.spec.ts`

Use the test-mode entrypoint `runCleanupNow` (exposed from main via an IPC reserved for tests, or by setting `process.env.ORCA_TEST_ARCHIVE_TTL_MS=0` so any archived item is past TTL).

Recommended approach: add a test-only `worktrees:_archiveCleanupNow` IPC handler guarded by `process.env.NODE_ENV === 'test'` that calls the cleanup service's `runOnce()`. Sketchy in prod-paranoid codebases — if the team prefers, expose a CLI-style flag instead.

Steps:
1. Create + archive a worktree.
2. Override `archivedAt` to `Date.now() - ARCHIVE_TTL_MS - 1000` via the test helper (write directly to persistence, or use an env-overridden TTL).
3. Trigger cleanup.
4. Assert worktree is gone from disk and from the Archived disclosure.

Commit.

---

### Task 7.4: E2E — blocked cleanup

Steps:
1. Create + archive a worktree with uncommitted changes.
2. Override TTL.
3. Trigger cleanup.
4. Assert worktree is still in Archived section with "Cleanup blocked" badge.
5. Click Delete now → confirm modal → Force Delete.
6. Assert worktree gone.

Commit.

---

### Task 7.5: Full typecheck + test sweep

Run:
```bash
pnpm tc
pnpm test
pnpm test:e2e
```

All three expected: PASS.

Commit any small fixups individually with the matching prefix (`fix:`, `test:`, etc.).

---

## Phase 8 — Cleanup & docs

### Task 8.1: Update STYLEGUIDE if introducing new UI patterns

If `ArchivedSection` adds a "collapsible secondary list" pattern not already documented, append a short subsection to `docs/STYLEGUIDE.md`. If it reuses existing patterns, skip.

### Task 8.2: Code-review pass

**REQUIRED SUB-SKILL:** Use superpowers:requesting-code-review against `main` once Phase 7 passes.

### Task 8.3: Mark plan complete

Add a small "## Status" section at the top of this file:

```markdown
## Status

- [x] Phase 1 — Schema + constants
- [x] Phase 2 — Refactor real-delete path
- [x] Phase 3 — Archive/restore IPC + store
- [x] Phase 4 — Swap delete UI for archive
- [x] Phase 5 — Cleanup service
- [x] Phase 6 — Archived sidebar section
- [x] Phase 7 — Verification & E2E
```

Commit, then open PR.

---

## Risk callouts

- **`runWorktreeRemoval` extraction** is the highest-risk refactor. The existing handler has ordering invariants (kill PTYs → kill setup/run → archive hook → symlinks → git remove → meta cleanup) documented in the `// Why:` comments. Preserve order verbatim during extraction.
- **Cleanup service startup timing**: passing `mainWindow` to `runWorktreeRemoval` only works if the window exists when cleanup fires. Use a getter (`() => mainWindow`) and tolerate `null` (the notify call already does in some paths — verify).
- **Test-mode cleanup IPC**: a `_archiveCleanupNow` handler exposed only in test/dev should be guarded by `process.env.NODE_ENV` or a build-time flag. Don't ship it to prod.
- **`skipDeleteWorktreeConfirm` setting** keeps its meaning for the Archived view's Delete now. Don't remove the setting; the deletion modal still uses it.
