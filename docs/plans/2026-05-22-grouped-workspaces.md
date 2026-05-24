# Grouped Workspaces Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Introduce first-class workspace groups — a workspace that owns N git worktrees from N different repos, co-located under a shared parent folder so agents and automations can run at the parent and `cd` into each member repo. Single-repo workspaces (today's shape) remain unchanged.

**Architecture:** A new `WorkspaceGroup` entity is persisted alongside today's per-repo `WorktreeMeta`. Each member `Worktree` gains an optional `groupId`. On disk, single-repo workspaces stay at `workspaces/<repoName>/<workspaceName>/`; groups live side-by-side at `workspaces/<groupName>/<repoName>/`. Resolution between the two shapes is driven by Orca's data store, not filesystem heuristics. Sidebar gets a new top-level "Groups" section; Setup/Run/Diff surfaces get per-repo sub-tabs; archive cascades atomically across members; automations gain a target discriminator so `new_per_run` can materialize a group.

**Tech Stack:** TypeScript, React, Zustand, Electron (main + renderer), Vitest, React Testing Library, simple-git / native `git` for worktree ops, zod for schema validation.

**Design doc:** `docs/plans/2026-05-22-grouped-workspaces-design.md` (read this first if you haven't).

**Feature flag:** Gate all UI entry points (the "New grouped workspace" composer mode, the Groups sidebar section, the automation Target picker for `group`) behind a `settings.experimentalGroupedWorkspaces` boolean. IPC handlers and types ship unconditionally so persisted data is forward-compatible.

---

## Pre-flight

- Work on a fresh worktree branched off `main`. The current branch (`daring_tiger`) is fine for the design doc but a clean branch is preferred for implementation. Use `superpowers:using-git-worktrees` to create one before starting Phase A.
- Test command: `pnpm vitest run --config config/vitest.config.ts <pattern>` (just `pnpm vitest run -- <pattern>` works for filtered runs).
- Typecheck: `pnpm tc` (uses `tsgo`, not `tsc` — see AGENTS.md).
- Commit cadence: one commit per task. Commit messages: `grouped-workspaces: <what changed>`.

---

## Phase A — Data Model & Persistence

### Task A1: Add `WorkspaceGroup` type

**Files:**
- Modify: `src/shared/types.ts` (after the existing `Worktree` block, around line 200)

**Step 1: Add the type.**

```ts
// ─── WorkspaceGroup ─────────────────────────────────────────────────
/**
 * A workspace that owns N worktrees from N distinct repos, co-located under
 * a shared parent folder. Members share a branch name (set at create time);
 * card-level state (pin, sort, activity, archive) lives on the group, not
 * the members. See docs/plans/2026-05-22-grouped-workspaces-design.md.
 */
export type WorkspaceGroup = {
  id: string                    // 'group:<uuid>'
  workspaceName: string         // also the parent folder name
  displayName: string
  parentPath: string            // workspaces/<workspaceName>/
  memberWorktreeIds: string[]   // ordered; max one worktree per repo
  branchName: string

  isArchived: boolean
  archivedAt: number | null
  archiveCleanupError?: string | null
  isPinned: boolean
  sortOrder: number
  lastActivityAt: number
  isUnread: boolean
  comment: string
  createdAt: number
  createdByAutomationRunId?: string
  linkedIssue: number | null
  linkedLinearIssue: string | null
}
```

**Step 2: Commit.**

```bash
git add src/shared/types.ts
git commit -m "grouped-workspaces: add WorkspaceGroup type"
```

### Task A2: Add `groupId` to `Worktree`

**Files:**
- Modify: `src/shared/types.ts:107-153` (Worktree type) and `src/shared/types.ts:162-201` (WorktreeMeta type)

**Step 1: Add the field to both.**

```ts
// In Worktree:
  /** When set, this worktree is a member of the named group; card-level
   *  state is read from the group rather than this record. Absent for
   *  single-repo worktrees (today's shape). */
  groupId?: string

// In WorktreeMeta (so it persists across reloads):
  groupId?: string
```

**Step 2: Commit.**

```bash
git add src/shared/types.ts
git commit -m "grouped-workspaces: add Worktree.groupId"
```

### Task A3: Extend `PersistedState` with `workspaceGroups`

**Files:**
- Modify: `src/shared/types.ts:1776` (PersistedState)
- Modify: `src/shared/constants.ts:388` (`getDefaultPersistedState`)

**Step 1: Add the array to PersistedState.**

```ts
export type PersistedState = {
  // … existing fields
  workspaceGroups: WorkspaceGroup[]
  // … rest
}
```

**Step 2: Default to empty array in `getDefaultPersistedState`.**

```ts
return {
  // … existing fields
  workspaceGroups: [],
  // … rest
}
```

**Step 3: Commit.**

```bash
git add src/shared/types.ts src/shared/constants.ts
git commit -m "grouped-workspaces: persist workspaceGroups on PersistedState"
```

### Task A4: zod schema for `WorkspaceGroup`

**Files:**
- Create: `src/shared/workspace-group-schema.ts`
- Create: `src/shared/workspace-group-schema.test.ts`

**Step 1: Write the failing test (TDD).**

```ts
// src/shared/workspace-group-schema.test.ts
import { describe, it, expect } from 'vitest'
import { parseWorkspaceGroups } from './workspace-group-schema'

describe('parseWorkspaceGroups', () => {
  it('returns [] for non-array input', () => {
    expect(parseWorkspaceGroups(null)).toEqual([])
    expect(parseWorkspaceGroups(undefined)).toEqual([])
    expect(parseWorkspaceGroups('nope')).toEqual([])
  })

  it('keeps valid entries and drops malformed ones', () => {
    const input = [
      {
        id: 'group:abc',
        workspaceName: 'daring_tiger',
        displayName: 'daring_tiger',
        parentPath: '/x/daring_tiger',
        memberWorktreeIds: ['orca::/a', 'pc::/b'],
        branchName: 'daring_tiger',
        isArchived: false,
        archivedAt: null,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        isUnread: false,
        comment: '',
        createdAt: 1000,
        linkedIssue: null,
        linkedLinearIssue: null
      },
      { id: 'group:bad', memberWorktreeIds: 'not-an-array' }
    ]
    const result = parseWorkspaceGroups(input)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('group:abc')
  })

  it('tolerates extra fields', () => {
    const input = [{
      id: 'group:abc', workspaceName: 'x', displayName: 'x',
      parentPath: '/x', memberWorktreeIds: [], branchName: 'x',
      isArchived: false, archivedAt: null, isPinned: false,
      sortOrder: 0, lastActivityAt: 0, isUnread: false, comment: '',
      createdAt: 0, linkedIssue: null, linkedLinearIssue: null,
      futureField: 'ignored'
    }]
    expect(parseWorkspaceGroups(input)).toHaveLength(1)
  })
})
```

**Step 2: Run, verify failure.**

```bash
pnpm vitest run -- src/shared/workspace-group-schema.test.ts
```

Expected: FAIL (module not found).

**Step 3: Implement.**

```ts
// src/shared/workspace-group-schema.ts
/* Why: workspaceGroups are read back from orca-data.json on startup; a type
 * flip in a future build (or a truncated write) shouldn't poison Zustand
 * state. Schema-validate at the read boundary and drop malformed entries
 * silently rather than throwing into main. Same pattern as
 * workspace-session-schema.ts. */
import { z } from 'zod'
import type { WorkspaceGroup } from './types'

const workspaceGroupSchema = z.object({
  id: z.string(),
  workspaceName: z.string(),
  displayName: z.string(),
  parentPath: z.string(),
  memberWorktreeIds: z.array(z.string()),
  branchName: z.string(),
  isArchived: z.boolean(),
  archivedAt: z.number().nullable(),
  archiveCleanupError: z.string().nullable().optional(),
  isPinned: z.boolean(),
  sortOrder: z.number(),
  lastActivityAt: z.number(),
  isUnread: z.boolean(),
  comment: z.string(),
  createdAt: z.number(),
  createdByAutomationRunId: z.string().optional(),
  linkedIssue: z.number().nullable(),
  linkedLinearIssue: z.string().nullable()
}).passthrough()

export function parseWorkspaceGroups(raw: unknown): WorkspaceGroup[] {
  if (!Array.isArray(raw)) return []
  const out: WorkspaceGroup[] = []
  for (const entry of raw) {
    const parsed = workspaceGroupSchema.safeParse(entry)
    if (parsed.success) out.push(parsed.data as WorkspaceGroup)
  }
  return out
}
```

**Step 4: Re-run, verify pass.**

```bash
pnpm vitest run -- src/shared/workspace-group-schema.test.ts
```

**Step 5: Commit.**

```bash
git add src/shared/workspace-group-schema.ts src/shared/workspace-group-schema.test.ts
git commit -m "grouped-workspaces: schema-validate workspaceGroups at load"
```

### Task A5: Wire schema into persistence load

**Files:**
- Modify: `src/main/persistence.ts` (load path — search for where `worktreeMeta` is parsed; add the same pattern for `workspaceGroups`)

**Step 1: In `loadPersistedState`, parse `workspaceGroups` via the new schema; default to `[]` on missing.**

Find the section that loads each top-level field. Add:

```ts
const workspaceGroups = parseWorkspaceGroups(raw.workspaceGroups)
// … include in the returned PersistedState
```

Add the import at the top:

```ts
import { parseWorkspaceGroups } from '../shared/workspace-group-schema'
```

**Step 2: Add a test in `src/main/persistence.test.ts` covering: (a) absent `workspaceGroups` defaults to `[]`, (b) malformed entries dropped.**

**Step 3: Run.**

```bash
pnpm vitest run -- src/main/persistence.test.ts
```

**Step 4: Commit.**

```bash
git add src/main/persistence.ts src/main/persistence.test.ts
git commit -m "grouped-workspaces: load + validate workspaceGroups from orca-data.json"
```

---

## Phase B — Disk Layout & Namespace Validation

### Task B1: Namespace validation helper

**Files:**
- Create: `src/shared/workspace-group-namespace.ts`
- Create: `src/shared/workspace-group-namespace.test.ts`

**Step 1: Write the failing test.**

```ts
import { describe, it, expect } from 'vitest'
import { validateGroupName, type NamespaceContext } from './workspace-group-namespace'

const ctx: NamespaceContext = {
  repoFolderNames: ['orca', 'ploy-client', 'ploy-server'],
  existingGroupNames: ['cozy_leopard']
}

describe('validateGroupName', () => {
  it('rejects collision with a repo name', () => {
    expect(validateGroupName('orca', ctx)).toEqual({ ok: false, reason: 'collides-with-repo' })
  })
  it('rejects collision with another group', () => {
    expect(validateGroupName('cozy_leopard', ctx)).toEqual({ ok: false, reason: 'collides-with-group' })
  })
  it('rejects empty / invalid characters', () => {
    expect(validateGroupName('', ctx).ok).toBe(false)
    expect(validateGroupName('has space', ctx).ok).toBe(false)
  })
  it('accepts a clean name', () => {
    expect(validateGroupName('daring_tiger', ctx)).toEqual({ ok: true })
  })
})
```

**Step 2: Verify failure.**

```bash
pnpm vitest run -- src/shared/workspace-group-namespace.test.ts
```

**Step 3: Implement.**

```ts
export type NamespaceContext = {
  repoFolderNames: string[]
  existingGroupNames: string[]
}

export type ValidateResult =
  | { ok: true }
  | { ok: false; reason: 'empty' | 'invalid-chars' | 'collides-with-repo' | 'collides-with-group' }

const VALID_NAME = /^[a-z0-9_][a-z0-9_-]*$/i

export function validateGroupName(name: string, ctx: NamespaceContext): ValidateResult {
  if (!name) return { ok: false, reason: 'empty' }
  if (!VALID_NAME.test(name)) return { ok: false, reason: 'invalid-chars' }
  if (ctx.repoFolderNames.includes(name)) return { ok: false, reason: 'collides-with-repo' }
  if (ctx.existingGroupNames.includes(name)) return { ok: false, reason: 'collides-with-group' }
  return { ok: true }
}
```

**Step 4: Verify pass. Commit.**

```bash
pnpm vitest run -- src/shared/workspace-group-namespace.test.ts
git add src/shared/workspace-group-namespace.ts src/shared/workspace-group-namespace.test.ts
git commit -m "grouped-workspaces: validate group-name namespace against repos and existing groups"
```

### Task B2: Group-path resolver + top-level disambiguator

**Files:**
- Create: `src/shared/workspace-group-paths.ts`
- Create: `src/shared/workspace-group-paths.test.ts`

**Step 1: Test (failing).**

```ts
import { describe, it, expect } from 'vitest'
import { resolveGroupParentPath, memberWorktreePath } from './workspace-group-paths'

describe('group path helpers', () => {
  it('resolveGroupParentPath joins workspaces root + group name', () => {
    expect(resolveGroupParentPath('/u/m/orca/workspaces', 'daring_tiger'))
      .toBe('/u/m/orca/workspaces/daring_tiger')
  })
  it('memberWorktreePath puts repo subfolder under group parent', () => {
    expect(memberWorktreePath('/u/m/orca/workspaces', 'daring_tiger', 'ploy-client'))
      .toBe('/u/m/orca/workspaces/daring_tiger/ploy-client')
  })
})
```

**Step 2: Implement using `path.join` (cross-platform per AGENTS.md).**

```ts
import { join } from 'path'

export function resolveGroupParentPath(workspacesRoot: string, groupName: string): string {
  return join(workspacesRoot, groupName)
}

export function memberWorktreePath(
  workspacesRoot: string,
  groupName: string,
  repoFolderName: string
): string {
  return join(workspacesRoot, groupName, repoFolderName)
}
```

**Step 3: Run, commit.**

```bash
pnpm vitest run -- src/shared/workspace-group-paths.test.ts
git add src/shared/workspace-group-paths.ts src/shared/workspace-group-paths.test.ts
git commit -m "grouped-workspaces: helpers for group + member worktree paths"
```

---

## Phase C — Group Create IPC (transactional)

### Task C1: Define IPC types

**Files:**
- Modify: `src/shared/types.ts` (add near other Create*Args types)

**Step 1: Add types.**

```ts
export type CreateGroupMemberSpec = {
  repoId: string
  baseRef: string | null         // null = use repo's default base
  setupDecision: SetupDecision   // existing enum: 'inherit' | 'run' | 'skip'
}

export type CreateWorkspaceGroupArgs = {
  workspaceName: string
  displayName?: string
  branchName: string             // same in every member's repo
  members: CreateGroupMemberSpec[]  // length >= 2
  comment?: string
  createdByAutomationRunId?: string
  telemetrySource?: string
}

export type CreateWorkspaceGroupResult = {
  group: WorkspaceGroup
  memberWorktrees: Worktree[]
}
```

**Step 2: Commit.**

```bash
git add src/shared/types.ts
git commit -m "grouped-workspaces: shared types for group create IPC"
```

### Task C2: Failing happy-path test for create handler

**Files:**
- Create: `src/main/ipc/workspace-groups.test.ts`

**Step 1: Write the test.** Mock `Store`, `ipcMain`, and the git worktree-add helper. Verify:
- A `WorkspaceGroup` is created and persisted.
- One `Worktree` per member is created with `groupId` set.
- The parent folder is created on disk; each member subfolder is a real git worktree.
- The result returned matches the persisted state.

(Use existing patterns from `src/main/ipc/worktrees.test.ts` for mocking shape.)

**Step 2: Run; expect FAIL (handler not registered).**

```bash
pnpm vitest run -- src/main/ipc/workspace-groups.test.ts
```

### Task C3: Implement handler skeleton

**Files:**
- Create: `src/main/ipc/workspace-groups.ts`
- Modify: `src/main/index.ts` or wherever IPC handlers are wired (search for `registerWorktreeHandlers`)

**Step 1: Skeleton — register `workspace-groups:create` channel, validate args, return a TODO error.**

**Step 2: Verify test still fails for the right reason (assertion mismatch, not module-not-found).**

**Step 3: Commit.**

```bash
git add src/main/ipc/workspace-groups.ts src/main/index.ts
git commit -m "grouped-workspaces: register workspace-groups:create IPC skeleton"
```

### Task C4: Implement parallel `git worktree add` + persistence

**Files:**
- Modify: `src/main/ipc/workspace-groups.ts`

**Step 1:** In the handler, after validation:
1. Pre-validate namespace via `validateGroupName`.
2. Pre-validate connection-target consistency (all repos same `connectionId` or all null).
3. Create the parent folder (`mkdirSync(parentPath, { recursive: true })`).
4. In parallel (`Promise.all`), call `createLocalWorktree` (or `createRemoteWorktree` for SSH groups) for each member, passing the calculated `memberWorktreePath` and forcing branch name == `args.branchName`. Reuse the existing helpers — do not reimplement worktree-add.
5. After all succeed, persist the `WorkspaceGroup` record (id = `'group:' + randomUUID()`) and stamp `groupId` on each created `WorktreeMeta`.
6. Return `{ group, memberWorktrees }`.

**Step 2:** Run the happy-path test; verify pass.

**Step 3:** Commit.

```bash
git add src/main/ipc/workspace-groups.ts
git commit -m "grouped-workspaces: happy-path group create with parallel git worktree add"
```

### Task C5: Failing test for rollback on partial failure

**Files:**
- Modify: `src/main/ipc/workspace-groups.test.ts`

Add a test that makes the second member's `git worktree add` reject (mock the helper). Verify:
- No `WorkspaceGroup` is persisted.
- The first member's worktree dir is removed.
- The first member's git worktree is unregistered (`git worktree remove` called).
- The parent folder is removed.
- The thrown error names the failing repo.

**Run.** Expect FAIL (no rollback yet).

### Task C6: Implement rollback

**Files:**
- Modify: `src/main/ipc/workspace-groups.ts`

**Step 1:** Wrap the parallel-create section in try/catch. On failure:
1. For each successfully created member: call `git worktree remove --force <path>` and delete the directory.
2. Remove the parent folder (it should be empty after step 1).
3. Re-throw with a message identifying which member failed.

**Step 2:** Run test; verify pass.

**Step 3:** Commit.

```bash
git add src/main/ipc/workspace-groups.ts src/main/ipc/workspace-groups.test.ts
git commit -m "grouped-workspaces: roll back group create on partial member failure"
```

### Task C7: Namespace collision rejection

**Files:**
- Modify: `src/main/ipc/workspace-groups.test.ts`
- Modify: `src/main/ipc/workspace-groups.ts`

**Step 1:** Add tests for: name collides with repo folder, name collides with existing group, invalid characters, members < 2, duplicate repoIds.

**Step 2:** Run; expect FAIL.

**Step 3:** Implement the pre-validation block calling `validateGroupName` + `members.length >= 2` + `new Set(repoIds).size === repoIds.length`.

**Step 4:** Verify pass; commit.

```bash
git add src/main/ipc/workspace-groups.ts src/main/ipc/workspace-groups.test.ts
git commit -m "grouped-workspaces: reject invalid names, <2 members, duplicate repos"
```

### Task C8: Connection-target consistency

**Files:**
- Modify: `src/main/ipc/workspace-groups.test.ts`
- Modify: `src/main/ipc/workspace-groups.ts`

**Step 1:** Add test: mixing a local repo and an SSH repo is rejected with a clear error.

**Step 2:** Implement: all members' `repo.connectionId` must be equal (`null` and `undefined` treated as same).

**Step 3:** Verify, commit.

```bash
git add src/main/ipc/workspace-groups.ts src/main/ipc/workspace-groups.test.ts
git commit -m "grouped-workspaces: reject mixed local+SSH groups"
```

---

## Phase D — Renderer Store

### Task D1: Add `workspaceGroups` to store state

**Files:**
- Modify: `src/renderer/src/store/types.ts` (search for `AppState`)
- Modify: `src/renderer/src/store/slices/repos.ts` or create `slices/workspace-groups.ts`
- Modify: `src/renderer/src/store/index.ts`

**Step 1:** Create `src/renderer/src/store/slices/workspace-groups.ts` exporting `createWorkspaceGroupsSlice` with:
- State: `workspaceGroups: WorkspaceGroup[]`
- Actions: `setWorkspaceGroups`, `upsertWorkspaceGroup`, `removeWorkspaceGroup`
- Hydrated from main on startup via the existing persistence-sync mechanism (find where `repos` and `worktreeMeta` are hydrated and add `workspaceGroups`).

**Step 2:** Compose into the root store.

**Step 3:** Add a focused test for the slice.

**Step 4:** Run + commit.

```bash
pnpm vitest run -- src/renderer/src/store/slices/workspace-groups.test.ts
git add src/renderer/src/store/
git commit -m "grouped-workspaces: renderer store slice for groups"
```

### Task D2: Group selectors

**Files:**
- Create: `src/renderer/src/store/selectors/groups.ts`
- Create: `src/renderer/src/store/selectors/groups.test.ts`

**Step 1: Write tests** for:
- `getGroupById(state, id)` — returns the group or undefined.
- `getGroupByWorktreeId(state, worktreeId)` — finds the group whose `memberWorktreeIds` contains the id.
- `getMemberWorktreesForGroup(state, groupId)` — returns the ordered `Worktree[]` for a group.
- `isWorktreeGrouped(state, worktreeId)` — boolean.

**Step 2: Implement.**

**Step 3: Verify, commit.**

```bash
pnpm vitest run -- src/renderer/src/store/selectors/groups.test.ts
git add src/renderer/src/store/selectors/groups.ts src/renderer/src/store/selectors/groups.test.ts
git commit -m "grouped-workspaces: group selectors"
```

### Task D3: `createGroup` action

**Files:**
- Modify: `src/renderer/src/store/slices/workspace-groups.ts`
- Modify: `src/preload/index.ts` (add IPC binding for `workspace-groups:create`)

**Step 1:** Add preload binding (matches the existing `worktrees:create` pattern).

**Step 2:** Add a renderer-side action `createGroup(args: CreateWorkspaceGroupArgs)` that calls the preload bridge, then dispatches `upsertWorkspaceGroup` and `setWorktreeMeta` for each created member.

**Step 3:** Test (mock the preload bridge).

**Step 4:** Run + commit.

```bash
git add src/preload/index.ts src/renderer/src/store/slices/workspace-groups.ts
git commit -m "grouped-workspaces: createGroup renderer action + preload bridge"
```

---

## Phase E — Sidebar Groups Section

### Task E1: Filter group members from repo sections

**Files:**
- Modify: `src/renderer/src/components/sidebar/visible-worktrees.ts` (`computeVisibleWorktreeIds`)
- Modify: `src/renderer/src/components/sidebar/visible-worktrees.test.ts`

**Step 1:** Write a failing test: given two worktrees, one with `groupId` set, only the un-grouped one appears in `computeVisibleWorktreeIds` output.

**Step 2:** Add a filter line:

```ts
all = all.filter((w) => !w.groupId)
```

just below the existing `isArchived` filter (line 110).

**Step 3:** Verify pass + commit.

```bash
pnpm vitest run -- src/renderer/src/components/sidebar/visible-worktrees.test.ts
git add src/renderer/src/components/sidebar/visible-worktrees.ts src/renderer/src/components/sidebar/visible-worktrees.test.ts
git commit -m "grouped-workspaces: hide group members from per-repo sidebar sections"
```

### Task E2: Aggregation helpers

**Files:**
- Create: `src/renderer/src/components/sidebar/group-aggregation.ts`
- Create: `src/renderer/src/components/sidebar/group-aggregation.test.ts`

**Step 1: Tests.** Given a group + its members:
- `groupLastActivityAt(group, members)` = `max(member.lastActivityAt)`.
- `groupIsRunning(group, members, runningWorktreeIds)` = any member running.
- `groupHasUnread(group, members)` = group's own `isUnread` (truth is on group, members are noise).

**Step 2: Implement + verify.**

**Step 3: Commit.**

```bash
pnpm vitest run -- src/renderer/src/components/sidebar/group-aggregation.test.ts
git add src/renderer/src/components/sidebar/group-aggregation.ts src/renderer/src/components/sidebar/group-aggregation.test.ts
git commit -m "grouped-workspaces: aggregation helpers for group status"
```

### Task E3: `GroupCard` component

**Files:**
- Create: `src/renderer/src/components/sidebar/GroupCard.tsx`
- Create: `src/renderer/src/components/sidebar/GroupCard.test.tsx`

**Step 1: Test** rendering: header shows group name + running dot, body shows one stacked PR row per member (`● <repo>  #<num> <state>`), click on group opens it as the active workspace.

**Step 2: Implement** by reusing `WorktreeCardHelpers` / `WorktreeCardMeta` patterns. Use shadcn primitives + tokens from `src/renderer/src/assets/main.css`. Reuse the existing PR-state rendering helper (`worktree-card-pr-display.ts`) for each row.

**Step 3: Verify pass; commit.**

```bash
pnpm vitest run -- src/renderer/src/components/sidebar/GroupCard.test.tsx
git add src/renderer/src/components/sidebar/GroupCard.tsx src/renderer/src/components/sidebar/GroupCard.test.tsx
git commit -m "grouped-workspaces: GroupCard with stacked per-repo PR rows"
```

### Task E4: `GroupsSection` component

**Files:**
- Create: `src/renderer/src/components/sidebar/GroupsSection.tsx`
- Create: `src/renderer/src/components/sidebar/GroupsSection.test.tsx`

**Step 1: Test.** Hidden when `workspaceGroups.length === 0`; renders a `<GroupCard>` per non-archived group sorted by `sortOrder` then `lastActivityAt`.

**Step 2: Implement.**

**Step 3: Verify, commit.**

```bash
git add src/renderer/src/components/sidebar/GroupsSection.tsx src/renderer/src/components/sidebar/GroupsSection.test.tsx
git commit -m "grouped-workspaces: GroupsSection (sidebar top-level)"
```

### Task E5: Wire `GroupsSection` into Sidebar

**Files:**
- Modify: `src/renderer/src/components/sidebar/index.tsx`

**Step 1:** Render `<GroupsSection />` above the repo sections, gated on `settings.experimentalGroupedWorkspaces`.

**Step 2:** Manual smoke check (run the app, look at sidebar — flag off = no change, flag on = empty section if no groups).

**Step 3:** Commit.

```bash
git add src/renderer/src/components/sidebar/index.tsx
git commit -m "grouped-workspaces: render GroupsSection in sidebar"
```

### Task E6: Archived groups in Archived section

**Files:**
- Modify: `src/renderer/src/components/sidebar/ArchivedSection.tsx`
- Modify: `src/renderer/src/components/sidebar/ArchivedSection.test.tsx`

**Step 1: Test:** archived groups render as one row in the Archived section.

**Step 2: Implement** — extend the list to include `workspaceGroups.filter(g => g.isArchived)`.

**Step 3: Verify, commit.**

```bash
git add src/renderer/src/components/sidebar/ArchivedSection.tsx src/renderer/src/components/sidebar/ArchivedSection.test.tsx
git commit -m "grouped-workspaces: archived groups appear in Archived section"
```

---

## Phase F — New Grouped Workspace Composer

### Task F1: Composer mode toggle

**Files:**
- Modify: `src/renderer/src/components/NewWorkspaceComposerModal.tsx`
- Modify: `src/renderer/src/components/NewWorkspaceComposerCard.tsx`

**Step 1:** Add a top-of-modal segmented control: `[ Single repo ] [ Group of repos ]`, defaulting to Single. Hidden behind the experimental flag.

**Step 2:** Lift the mode into a local state; render the existing form for `single`, and a new (stub) `GroupedComposerForm` for `group`.

**Step 3:** Commit.

```bash
git add src/renderer/src/components/NewWorkspaceComposerModal.tsx src/renderer/src/components/NewWorkspaceComposerCard.tsx
git commit -m "grouped-workspaces: composer toggle for Single vs Group"
```

### Task F2: Grouped composer form

**Files:**
- Create: `src/renderer/src/components/GroupedComposerForm.tsx`
- Create: `src/renderer/src/components/GroupedComposerForm.test.tsx`

**Step 1: Test.** Fields: multi-select repo picker (>=2 required), group-name input (defaulted via `generateUniqueWorkspaceName`), branch-name input (defaulted to group name), per-repo base-ref picker, per-repo setup-decision picker. Submit disabled until valid.

**Step 2: Implement.** Reuse the BaseRefPicker and SetupDecisionPicker from the existing single-repo form. Branch-name change auto-updates only if user hasn't edited the branch field. Surface namespace validation errors inline.

**Step 3: Verify, commit.**

```bash
pnpm vitest run -- src/renderer/src/components/GroupedComposerForm.test.tsx
git add src/renderer/src/components/GroupedComposerForm.tsx src/renderer/src/components/GroupedComposerForm.test.tsx
git commit -m "grouped-workspaces: GroupedComposerForm with multi-repo picker"
```

### Task F3: Submit wiring

**Files:**
- Modify: `src/renderer/src/components/GroupedComposerForm.tsx`

**Step 1:** Submit handler builds `CreateWorkspaceGroupArgs` and calls `store.createGroup(args)`. On success, close modal and select the new group. On failure, surface the error.

**Step 2:** Add an integration test that mocks the store action and asserts the args shape.

**Step 3:** Verify, commit.

```bash
git add src/renderer/src/components/GroupedComposerForm.tsx src/renderer/src/components/GroupedComposerForm.test.tsx
git commit -m "grouped-workspaces: wire composer submit to createGroup"
```

---

## Phase G — Setup Tab Segmentation

### Task G1: `SegmentedRepoTabs` shared component

**Files:**
- Create: `src/renderer/src/components/right-sidebar/SegmentedRepoTabs.tsx`
- Create: `src/renderer/src/components/right-sidebar/SegmentedRepoTabs.test.tsx`

**Step 1: Test.** Given `members: { repoId, repoName, status: 'idle'|'running'|'failed'|'done' }[]` and `activeRepoId`, renders one segment per member, highlights the active one, shows a status dot per segment, fires `onSelect(repoId)` on click.

**Step 2: Implement.** Reuse shadcn `Tabs` primitive or build directly with tokens.

**Step 3: Verify, commit.**

```bash
pnpm vitest run -- src/renderer/src/components/right-sidebar/SegmentedRepoTabs.test.tsx
git add src/renderer/src/components/right-sidebar/SegmentedRepoTabs.tsx src/renderer/src/components/right-sidebar/SegmentedRepoTabs.test.tsx
git commit -m "grouped-workspaces: SegmentedRepoTabs shared component"
```

### Task G2: SetupPanel renders segmented for groups

**Files:**
- Modify: `src/renderer/src/components/right-sidebar/SetupPanel.tsx`
- Modify or create: `src/renderer/src/components/right-sidebar/SetupPanel.test.tsx`

**Step 1: Test.** When active workspace is a group:
- `<SegmentedRepoTabs>` renders at the top.
- Each segment streams that member worktree's setup output (mocked).
- Parent tab badge aggregates: any-failed → red; any-running → spinner; all-done → green.

**Step 2:** Detect group via `getGroupByWorktreeId` or a dedicated `activeGroupId` store field. Pass active-member's worktreeId down to the existing stream renderer.

**Step 3:** Verify pass + commit.

```bash
git add src/renderer/src/components/right-sidebar/SetupPanel.tsx src/renderer/src/components/right-sidebar/SetupPanel.test.tsx
git commit -m "grouped-workspaces: segmented Setup output per member"
```

### Task G3: Per-member "rerun setup" affordance

**Files:**
- Modify: `src/renderer/src/components/right-sidebar/SetupPanel.tsx`

Adds a small "Rerun this repo's setup" button inside the segment. Calls existing per-worktree setup-rerun action. Test + commit.

```bash
git add src/renderer/src/components/right-sidebar/SetupPanel.tsx src/renderer/src/components/right-sidebar/SetupPanel.test.tsx
git commit -m "grouped-workspaces: per-member rerun affordance in Setup"
```

---

## Phase H — Run Tab + Group-Atomic Semantics

### Task H1: RunPanel renders segmented for groups

Same approach as G2 but for `RunPanel.tsx`. Test + commit.

```bash
git add src/renderer/src/components/right-sidebar/RunPanel.tsx src/renderer/src/components/right-sidebar/RunPanel.test.tsx
git commit -m "grouped-workspaces: segmented Run output per member"
```

### Task H2: Group-atomic start/stop

**Files:**
- Modify: `src/renderer/src/components/right-sidebar/RunPanel.tsx`
- Modify: store action(s) that start/stop run scripts (search for the existing `startRunScript` / `stopRunScript` action)

**Step 1: Test.** Clicking Start while a group is active dispatches start to every member in parallel; Stop dispatches stop to every member. There is no per-member Start/Stop button.

**Step 2:** Implement: add `startGroupRun(groupId)` / `stopGroupRun(groupId)` actions that fan out to per-worktree run start/stop.

**Step 3:** Group "running" indicator (sidebar + status bar) reflects "any member running". Use the aggregation helper from Task E2.

**Step 4:** Verify, commit.

```bash
git add src/renderer/src/components/right-sidebar/RunPanel.tsx src/renderer/src/store/slices/
git commit -m "grouped-workspaces: group-atomic run start/stop"
```

### Task H3: Stop other run on group start

**Files:**
- Modify: the run-start logic

**Step 1: Test.** If any member's run script is alive from a prior single-repo run, starting the group's Run stops it first. (User requirement: "we will need to stop any other repo scripts running for any repo in the group".)

**Step 2:** Implement: before fanning out start, iterate group members and call stop for any with active run.

**Step 3:** Commit.

```bash
git add src/renderer/src/store/slices/
git commit -m "grouped-workspaces: stop conflicting per-repo runs when starting group run"
```

---

## Phase I — Diff Tab Segmentation

### Task I1: FileExplorer segmented per member

**Files:**
- Modify: `src/renderer/src/components/right-sidebar/FileExplorer.tsx`
- Modify or create: `FileExplorer.test.tsx`

**Step 1: Test.** When active workspace is a group, FileExplorer shows `<SegmentedRepoTabs>` and renders the active member's changed-files list. Tab badge = sum of changed-file counts across members.

**Step 2: Implement** with the same detection pattern as SetupPanel.

**Step 3: Verify, commit.**

```bash
git add src/renderer/src/components/right-sidebar/FileExplorer.tsx
git commit -m "grouped-workspaces: segmented Diff/FileExplorer per member"
```

### Task I2: Open-file from diff resolves to correct member

**Files:**
- Modify: existing file-open flow

**Step 1: Test.** Clicking a file in the orca member's diff opens an editor tab tagged with that member's `worktreeId`.

**Step 2:** Existing `worktreeId` plumbing on editor tabs already supports this; the only change needed is making sure the diff's "open file" handler passes the segmented member's worktreeId, not the group's. Update + test.

**Step 3:** Commit.

```bash
git add src/renderer/src/components/right-sidebar/FileExplorer.tsx
git commit -m "grouped-workspaces: open-from-diff tags editor tab with correct member"
```

---

## Phase J — Terminal & Agent at Group Parent

### Task J1: PTY default CWD for groups

**Files:**
- Modify: `src/main/ipc/pty-management.ts`
- Modify: `src/renderer/src/components/terminal-pane/pty-dispatcher.ts`

**Step 1: Test.** When the active workspace is a group, a new terminal pane starts with CWD = `group.parentPath`.

**Step 2:** Lookup chain in the PTY create handler: if the worktreeId is a group's member, use the group's `parentPath` as CWD instead of the worktree's path. Provide an explicit override (e.g. `cwdOverride: 'member'`) for "New terminal here" from a member file.

**Step 3:** Verify, commit.

```bash
git add src/main/ipc/pty-management.ts src/renderer/src/components/terminal-pane/pty-dispatcher.ts
git commit -m "grouped-workspaces: terminal CWD defaults to group parent"
```

### Task J2: `CONDUCTOR_WORKSPACE_REPOS` env var

**Files:**
- Modify: `src/main/hooks-runner.ts`

**Step 1: Test.** For a group, `CONDUCTOR_WORKSPACE_REPOS` is set to a comma-separated list of member subfolder names (in group order). For a single worktree, the var is absent.

**Step 2: Implement** alongside the existing `CONDUCTOR_WORKSPACE_NAME` injection.

**Step 3:** Document in `docs/STYLEGUIDE.md` or a dedicated env-vars reference if one exists.

**Step 4:** Commit.

```bash
git add src/main/hooks-runner.ts
git commit -m "grouped-workspaces: inject CONDUCTOR_WORKSPACE_REPOS for groups"
```

---

## Phase K — Archive Cascade

### Task K1: Archive group IPC handler

**Files:**
- Create: extend `src/main/ipc/workspace-groups.ts` with a `workspace-groups:archive` handler
- Modify: `src/main/ipc/workspace-groups.test.ts`

**Step 1: Test (happy path).** Archiving a group:
1. Runs each member's archive cleanup script in parallel.
2. Removes each member worktree dir + unregisters the git worktree.
3. Removes the parent folder.
4. Sets `group.isArchived = true`, `archivedAt = now`.

**Step 2: Implement.** Reuse `run-worktree-removal.ts` per member; await all in parallel.

**Step 3:** Verify, commit.

```bash
git add src/main/ipc/workspace-groups.ts src/main/ipc/workspace-groups.test.ts
git commit -m "grouped-workspaces: happy-path archive cascade"
```

### Task K2: All-or-nothing on failure

**Files:**
- Modify: `src/main/ipc/workspace-groups.ts`
- Modify: `src/main/ipc/workspace-groups.test.ts`

**Step 1: Test.** If any member's cleanup script fails:
- Group stays unarchived.
- Each member's `archiveCleanupError` is set (truncated to ~500 chars per existing pattern).
- The other members are NOT torn down (we keep state consistent).

**Step 2: Implement.** Use `Promise.allSettled`. If any rejected, set per-member error and return early.

**Step 3:** Verify, commit.

```bash
git add src/main/ipc/workspace-groups.ts src/main/ipc/workspace-groups.test.ts
git commit -m "grouped-workspaces: all-or-nothing archive cascade with per-member errors"
```

### Task K3: Renderer archive flow

**Files:**
- Modify: `src/renderer/src/components/sidebar/archive-worktree-flow.ts` (or add a sibling `archive-group-flow.ts`)
- Modify: `src/renderer/src/components/sidebar/GroupCard.tsx`
- Modify: tests

**Step 1: Test.** "Archive" context menu on a group card calls the new IPC and shows the same toast pattern as single archive.

**Step 2: Implement** sibling `archive-group-flow.ts` mirroring the existing single-archive flow.

**Step 3:** Commit.

```bash
git add src/renderer/src/components/sidebar/archive-group-flow.ts src/renderer/src/components/sidebar/GroupCard.tsx
git commit -m "grouped-workspaces: archive flow from GroupCard"
```

---

## Phase L — Automations: Group Target

### Task L1: `AutomationTarget` discriminator type

**Files:**
- Modify: `src/shared/automations-types.ts`

**Step 1: Add types.**

```ts
export type AutomationTarget =
  | { kind: 'single'; projectId: string }
  | { kind: 'group'; projectIds: string[]; groupBranchName?: string }
```

**Step 2:** Add optional `target?: AutomationTarget` to `Automation`, `AutomationCreateInput`, `AutomationUpdateInput`. Keep `projectId` as-is (legacy).

**Step 3:** Commit.

```bash
git add src/shared/automations-types.ts
git commit -m "grouped-workspaces: AutomationTarget discriminator type"
```

### Task L2: Migration helper (legacy → discriminator)

**Files:**
- Create: `src/shared/automation-target-migration.ts`
- Create: `src/shared/automation-target-migration.test.ts`

**Step 1: Test.** Given an automation with `projectId: 'orca'` and no `target`, the helper returns `{ kind: 'single', projectId: 'orca' }`. Given an automation already carrying `target`, returns it unchanged.

**Step 2: Implement.**

**Step 3:** Wire the helper at the read sites in `persistence.ts` and the dispatcher (read-time normalization, no on-disk migration).

**Step 4:** Commit.

```bash
pnpm vitest run -- src/shared/automation-target-migration.test.ts
git add src/shared/automation-target-migration.ts src/shared/automation-target-migration.test.ts src/main/persistence.ts
git commit -m "grouped-workspaces: normalize legacy automations into AutomationTarget"
```

### Task L3: Dispatcher resolves group target

**Files:**
- Modify: `src/main/ipc/automations.ts` and/or `src/main/runtime/rpc/dispatcher.ts`
- Modify: corresponding tests

**Step 1: Test.** Given `workspaceMode: 'new_per_run'` + `target.kind === 'group'`:
- Dispatcher creates a new `WorkspaceGroup` (calls the group-create IPC internally).
- `run.workspaceId` is the new group id.
- Agent CWD passed to the spawner is the group's `parentPath`.

**Step 2: Implement.** Branch on `target.kind`; route to the right create helper.

**Step 3:** Add test for `workspaceMode: 'existing'` + group `workspaceId`: dispatcher resolves CWD = group parent, no new worktrees created.

**Step 4:** Verify, commit.

```bash
git add src/main/ipc/automations.ts src/main/runtime/rpc/dispatcher.ts src/main/ipc/automations.test.ts
git commit -m "grouped-workspaces: dispatcher handles group automation target"
```

### Task L4: Automation editor target picker

**Files:**
- Modify: components under `src/renderer/src/components/automations/editor/`

**Step 1:** Identify the existing project-picker field. Replace it with a higher-level "Target" picker: radio between "Single repo" (today's UI) and "Group of repos" (multi-select). Gate the Group option on the experimental flag.

**Step 2:** Update save/load to populate `target` on the automation. For single mode, also keep `projectId` set to that repoId (legacy compat).

**Step 3:** Test the editor's read/write path.

**Step 4:** Commit.

```bash
git add src/renderer/src/components/automations/editor/
git commit -m "grouped-workspaces: automation editor Target picker"
```

---

## Phase M — Polish & Sweep

### Task M1: Activity bumps roll up to group

**Files:**
- Modify: wherever `bumpWorktreeActivity` (or equivalent) is called

When a member worktree's `lastActivityAt` is bumped, also bump the owning group's `lastActivityAt`. One commit.

### Task M2: Multi-select treats group as unit

**Files:**
- Modify: `src/renderer/src/components/sidebar/worktree-multi-selection.ts`

Test + implement that group selection is atomic: selecting a group selects only the group (not its members), and group + worktree selections coexist in the existing selection set.

### Task M3: Cmd+J jump palette includes groups

**Files:**
- Modify: the existing jump-palette component (search for `Cmd+J` or `JumpPalette`)

Groups appear alongside worktrees with a distinct icon. Test + commit.

### Task M4: Settings flag for experimental feature

**Files:**
- Modify: `src/shared/types.ts` (`GlobalSettings`)
- Modify: `src/shared/constants.ts` (`getDefaultSettings`)
- Modify: `src/renderer/src/components/settings/` (add toggle)

Add `experimentalGroupedWorkspaces: boolean` to `GlobalSettings`, default `false`. Surface as a toggle under Settings → Experimental. Used by every UI entry point added above.

### Task M5: Typecheck + full vitest sweep

```bash
pnpm tc
pnpm vitest run
```

Fix any issues. Commit any final fixes.

### Task M6: Manual QA checklist

Run the app, flip the flag on, and verify:
- [ ] "New grouped workspace" composer opens and validates names.
- [ ] Creating a group puts the parent folder + two member worktree dirs on disk in the expected places.
- [ ] Group appears in the new sidebar Groups section; members are absent from per-repo sections.
- [ ] PR rows in the group card update when PRs are created on either member's branch.
- [ ] Setup tab segments per repo; running setup in one segment doesn't disturb the other.
- [ ] Run tab Start/Stop is atomic across members; running indicator reflects the union.
- [ ] Terminal opens at the group parent; `pwd` confirms; `cd <repo>` works.
- [ ] `echo $CONDUCTOR_WORKSPACE_REPOS` lists the member subfolder names.
- [ ] Archiving the group cleans up both members' dirs and the parent folder.
- [ ] Archive failure on one member leaves the group unarchived with the per-member error surfaced.
- [ ] An automation with `target.kind === 'group'` + `new_per_run` creates a fresh group per run.
- [ ] Disabling the flag hides every group entry point without touching persisted data.

### Task M7: Update STYLEGUIDE.md if any new tokens added

If Phase E/G/H/I introduced new color/spacing tokens, document them in `docs/STYLEGUIDE.md`. Otherwise skip.

---

## Done criteria

- All tests pass (`pnpm vitest run`).
- `pnpm tc` clean.
- Manual QA checklist (M6) all green.
- Feature flag off → app behaves exactly as today (no group surfaces visible, persistence still loads & saves the new `workspaceGroups: []` field).
- Feature flag on → end-to-end create / use / archive / automate a grouped workspace.
