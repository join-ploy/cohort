# Archive Worktrees — Design

**Status:** Draft
**Date:** 2026-05-20

## Summary

Replace the existing hard-delete action on worktrees with a soft **Archive** that hides the worktree from the primary surfaces and runs a real delete after a 30-day grace window. Archive is the only path users see; "Delete now" survives only in the Archived view as an escape hatch.

The `isArchived` flag already exists on `WorktreeMeta` and the sidebar already filters archived entries from the visible list (`src/renderer/src/components/sidebar/visible-worktrees.ts:97`). Nothing currently sets it to `true`. This design wires up the action, adds a 30-day TTL with auto-cleanup, and audits the remaining surfaces that still show archived worktrees.

## Terminology

In Orca, "workspace" and "worktree" refer to the same thing (`workspaceName` is a short id on a worktree, e.g. `wise_panther`). There is no separate workspace-grouping concept. Repo-level archive is out of scope for v1.

## Model & semantics

Add two persisted fields to `WorktreeMeta` (`src/shared/types.ts`):

```ts
archivedAt: number | null         // ms epoch, null when not archived
archiveCleanupError?: string | null // last cleanup failure, shown in Archived view
```

`isArchived` stays as the boolean indicator. `getDefaultWorktreeMeta` returns `archivedAt: null`. Backfill is trivial — existing records have `isArchived: false`, so `archivedAt: null` is correct for all of them.

**Archive** = `{ isArchived: true, archivedAt: Date.now(), archiveCleanupError: null }`. Worktree directory stays untouched on disk.

**Restore** = `{ isArchived: false, archivedAt: null, archiveCleanupError: null }`. Worktree reappears in its normal sidebar slot.

**The existing user-defined `archive` hook script** (a cleanup command in `orca.yaml`) keeps its current semantics — it runs at *real* deletion time, not on soft-archive. Soft-archive is purely metadata.

## UX flow

**Primary action becomes Archive.** Sidebar context menu, batch select, the existing delete-worktree dialog, and any keyboard shortcut all become Archive. No confirmation modal — Archive is reversible for 30 days, so a Sonner toast with **Undo** is sufficient.

Toast wording: `"Archived '<displayName>' — will be deleted in 30 days"` with an `Undo` action.

**Main worktrees still cannot be archived** (same guard as today's delete, `delete-worktree-flow.ts:119`).

**Batch archive.** The existing batch-delete plumbing becomes batch-archive — same selection, swap verb, skip confirm.

**Archived view.** A collapsible "Archived" disclosure at the bottom of the sidebar. Each row shows:
- Display name and repo
- Days remaining until auto-cleanup (e.g. "27 days left")
- **Restore** — clears archive state
- **Delete now** — calls the existing real-delete flow, including the existing force-delete recovery toast when `git worktree remove` is blocked

The Archived view is the only place the verb "Delete" still appears.

**Surface audit.** Today only the sidebar filters `isArchived`. The following surfaces need the same filter (or to delegate to the existing `visible-worktrees` helpers):
- cmd-K palette search (`worktree-palette-search.ts`)
- Keyboard navigation
- Dashboard `useRetainedAgents`
- Any other consumer of `getAllWorktreesFromState`

## Auto-cleanup at 30 days

**Trigger.** A new `src/main/archive/cleanup-service.ts` owns its own `setInterval` (matches the pattern in `automations/service.ts` — no central scheduler exists). Runs once on app start (after persistence load, before window creation) and every hour while the app is open. Exposes `runCleanupNow()` for tests.

**Selection.** `now - archivedAt >= ARCHIVE_TTL_MS` where `ARCHIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000`. Constant lives in `src/shared/archive-constants.ts` so tests can override it.

**Operation.** Reuses the real-delete code path. To avoid duplication, factor the body of the `worktrees:remove` IPC handler into a `runWorktreeRemoval(args)` function so both the IPC handler and the cleanup service call it.

Order, preserved from today's handler (`src/main/ipc/worktrees.ts:404-511`):
1. Run user's `archive` hook script (preserved — its existing purpose).
2. `removeWorktreeSymlinks`
3. `provider.removeWorktree` or `removeWorktree(repo.path, worktreePath, false)` — **non-force**
4. On success: `deleteWorktreeHistoryDir`, `removeWorktreeMeta`

**Blocked cleanup: never auto-force.** If `git worktree remove` fails (uncommitted/unpushed work, locked, etc.), the worktree stays archived. `archivedAt` is **not** reset. The cleanup retries on the next tick. The error is recorded in `archiveCleanupError` and surfaced in the Archived view as "Cleanup blocked" with a `Delete now` button that routes to the existing force-delete recovery flow. This preserves the current safety invariant: no force-delete without explicit user consent.

**Stale-record protection.** If the worktree path is gone from disk (user `rm -rf`'d it externally), proceed to metadata cleanup as today's handler already does in the non-force path.

**SSH worktrees.** Same path — `provider.removeWorktree` is already abstracted.

## IPC surface

- `worktrees:archive` — `{ worktreeId }` → `{ ok: true }`. Pure metadata mutation.
- `worktrees:restore` — `{ worktreeId }` → `{ ok: true }`.
- `worktrees:remove` — unchanged signature. The Archived view's "Delete now" calls it directly.

## Renderer plumbing

- Split the `removeWorktree` store action into `archiveWorktree`, `restoreWorktree`, and the existing `removeWorktree` for the Delete-now path.
- Rename `delete-worktree-flow.ts` → `archive-worktree-flow.ts`. Drop the force-delete recovery branch (archive can't fail). Add undo-toast wiring.
- New `ArchivedSection.tsx` in the sidebar.
- Surface-audit pass on `getAllWorktreesFromState` consumers.

## Testing

**Unit:**
- Cleanup service selection logic — TTL boundaries (29d 23h vs 30d 1m), blocked-retry, missing-disk path, multi-repo.
- `worktrees:archive` and `worktrees:restore` IPC handlers — sets/clears the three fields, persistence reflects the change.
- Sidebar visibility audit — palette search, dashboard agents, keyboard nav all filter archived.

**E2E:**
- Archive → Undo restores the worktree to the same sidebar slot.
- Archive → time-skip past TTL → cleanup removes the worktree from disk and metadata.
- Archive → uncommitted work → cleanup leaves it archived, `archiveCleanupError` populated, Archived view shows "Cleanup blocked".
- Archived view → Delete now → existing force-delete recovery still works.

## Out of scope

- Repo-level archive (a different concept — disconnecting all worktrees + the repo entry).
- Configurable TTL per repo or per worktree.
- Archive-on-merge automation.
