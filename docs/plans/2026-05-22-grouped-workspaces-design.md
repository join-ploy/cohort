# Grouped Workspaces — Design

**Status:** Draft
**Date:** 2026-05-22

## Summary

Introduce **workspace groups**: a workspace that owns 1+ git worktrees from different repos, co-located under a single parent folder so an agent can run at the parent and `cd` into each member repo. Groups are addressed as one unit in the sidebar, agent list, and automation surface — one branch name shared across all members, PRs from each member listed together, and archive cascades to all members atomically.

The current model is 1 worktree = 1 workspace. This design promotes "workspace" to a first-class concept that can own multiple worktrees. Single-repo workspaces (today's shape) remain unchanged on disk and in behavior.

## Terminology

- **Repo**: an entry in Orca's repo list. Backed by an on-disk git repository or a folder.
- **Worktree**: one git worktree of one repo. Identified by `${repoId}::${path}`.
- **Single-repo workspace** (today): one repo, one worktree, one workspace folder.
- **Grouped workspace** (new): one `WorkspaceGroup` that owns N member worktrees from N distinct repos.
- **Group folder**: the parent directory containing all member worktrees of one group.

## Model

### `WorkspaceGroup` (new first-class entity)

```ts
type WorkspaceGroup = {
  id: string                    // 'group:<uuid>'
  workspaceName: string         // e.g. 'daring_tiger' — also the parent folder name
  displayName: string
  parentPath: string            // 'workspaces/<workspaceName>/'
  memberWorktreeIds: string[]   // ordered; max one worktree per repo
  branchName: string            // applied as the branch in every member at create time

  // Lifecycle (mirrors WorktreeMeta)
  isArchived: boolean
  archivedAt: number | null
  archiveCleanupError?: string | null
  isPinned: boolean
  sortOrder: number
  lastActivityAt: number
  isUnread: boolean
  createdAt: number
  createdByAutomationRunId?: string
  comment: string
  linkedIssue: number | null
  linkedLinearIssue: string | null
}
```

### `Worktree` (existing, gains one field)

```ts
type Worktree = {
  // … all existing fields unchanged
  groupId?: string  // present iff this worktree is a member of a group
}
```

When `groupId` is set:
- The worktree is filtered out of its repo's sidebar list.
- Card-level state (`isPinned`, `sortOrder`, `isUnread`, `lastActivityAt`, `linkedIssue`, `displayName`, `comment`) is read from the **group**, not the member.
- Per-repo-essential fields stay on the member: `branch`, `baseRef`, `pushTarget`, `linkedPR`, `diffComments`, `sparseDirectories`/`sparseBaseRef`/`sparsePresetId`.

### Persistence

Add a `workspaceGroups: WorkspaceGroup[]` array to `orca-data.json`. Schema-validated at load using the same defensive pattern as `workspace-session-schema.ts` — unknown enum values, wrong types, and wrong shapes collapse to defaults rather than throwing into main.

## Disk layout

**Side-by-side, group-first.** Single-repo workspaces stay where they are. Groups get top-level folders next to repo folders:

```
workspaces/
  orca/                    ← REPO folder (today)
    daring_tiger/          ← single-repo worktree
    sturdy_panther/
  ploy-client/             ← REPO folder
    brave_otter/
  daring_tiger_group/      ← GROUP folder (new)
    orca/                  ← member worktree (git worktree of orca)
    ploy-client/           ← member worktree (git worktree of ploy-client)
```

**Resolution rule.** When Orca scans a top-level entry under `workspaces/`, it looks it up in its data store. Match a known **Repo** → children are per-repo worktrees (today's shape). Match a known **WorkspaceGroup** → children are member worktrees (subfolder name === member's `repoName`).

**Namespace constraints (enforced at create):**
- Group `workspaceName` must not collide with any existing repo folder name.
- Group `workspaceName` must not collide with any other group's `workspaceName`.
- Adding a new repo must not collide with any existing group name.
- Member subfolders are named after their repo; the per-repo-uniqueness rule prevents collisions inside the group.

**Git registration.** Each member subfolder is created via `git worktree add` in its own repo, registered in that repo's `.git/worktrees`. Git tracks worktrees by absolute path, so a non-standard parent folder is invisible to git itself.

## Creation flow

### Manual (UI)

New entry in the New Workspace dialog: **"New grouped workspace"**, alongside the existing single-repo flow.

Form fields:
- **Repos** — multi-select picker, ≥2 required, each repo selectable once. Repos must share connection target (all local or all on the same SSH host); mixing is rejected.
- **Group name** — defaults to a generated `workspaceName` (e.g. `daring_tiger`); editable; validated against namespace constraints.
- **Branch name** — single field, defaults to the group name. Applied as the branch name in every member's repo at create time.
- **Base ref per repo** — one row per selected repo, each defaulting to the repo's `worktreeBaseRef` (or `main`).
- **Setup decision per repo** — one row per repo with the existing `'inherit' | 'run' | 'skip'` picker.

### Transactional create

1. Validate namespace constraints and connection-target consistency.
2. Create the parent group folder.
3. For each member, run `git worktree add` in that repo in parallel.
4. If any member fails: delete created subfolders, unregister any git worktrees that did get created, surface the failing repo's error, leave nothing persisted.
5. On success, persist the `WorkspaceGroup` record and member `Worktree`s with `groupId` set.

### Automation integration

Automations today carry a single `projectId: string` (== repoId). For groups, automations need to address a *set* of repos.

Minimal model change — add a target discriminator alongside `projectId` (kept for backwards compat):

```ts
type AutomationTarget =
  | { kind: 'single'; projectId: string }
  | { kind: 'group'; projectIds: string[]; groupBranchName?: string }

type Automation = {
  // … existing fields
  projectId: string         // kept; for group targets, set to projectIds[0] so legacy code paths still resolve
  target?: AutomationTarget // new; absent ⇒ inferred as { kind: 'single', projectId }
}
```

Dispatch behavior:
- `workspaceMode: 'new_per_run'` with `target.kind === 'group'` → materialize a new `WorkspaceGroup` (parent folder + per-repo worktrees, same transactional create) for each run.
- `workspaceMode: 'existing'` → `workspaceId` resolves to either a single workspace or a group; the dispatcher sets agent CWD accordingly.

Automation editor: new "Target" picker at the top — "Single repo" (today) or "Group of repos" → multi-select.

## Sidebar rendering

**New top-level "Groups" section** above the existing per-repo sections. Hidden when no groups exist, so single-repo users see no change.

```
▼ Groups            (2)
  ┌─ daring_tiger ──────┐
  │ daring_tiger        │
  │ ● orca       #123  │
  │ ● ploy-client #456 │
  └─────────────────────┘
  ┌─ cozy_leopard ──────┐
  │ ...                 │
  └─────────────────────┘

▼ orca              (3)
  • sturdy_panther
  ...

▼ ploy-client       (4)
  • brave_otter
  ...
```

**Group card anatomy:**
- Header row: group name, running/automation status indicator, pin/sort handles.
- Body: one PR row per member repo, stacked: `● <repo-name>  #<num> <state>`.
- Multi-select: groups participate as a single unit; you can't half-select a group.

**Status aggregation:**
- "Running" dot lights when any member has a live PTY, active run, or dispatching automation.
- `lastActivityAt` for the group = `max(member lastActivityAt)`.
- `isUnread` clears for all members when cleared on the group.
- Automation badge follows the existing animated-while-running / static-after rules, keyed on `WorkspaceGroup.createdByAutomationRunId`.

**Members do not appear under their repo's section.** A worktree with `groupId` set is filtered out of its repo's worktree list — the group section is its sole sidebar presence.

**Archived groups** appear in the existing Archived section as a single row.

## Workspace surfaces

When a group is opened in the main pane, tab structure mirrors today's single-repo workspace; per-repo content surfaces use a segmented sub-tab pattern.

### Setup tab
- Segmented selector at the top: `[ orca ] [ ploy-client ]`, one segment per member in group order.
- Each segment streams that repo's `orca.yaml` setup script output, executed in its own member worktree subfolder.
- Parent tab badge: red if any failed, spinner if any running, green when all done.
- Members run in parallel by default; each segment has a "rerun this repo's setup" affordance.

### Run tab
- Same segmented layout as Setup.
- **Group-atomic semantics:** Start → starts run scripts in every member in parallel. Stop → stops them all. No per-member start/stop.
- Parent tab "Running" indicator: union across members.

### Diff tab
- Segmented per repo; each segment shows that repo's changed-files list and diffs (vs the member's own `baseRef`).
- Parent tab badge: sum of changed-file counts.
- Conflict-review surfaces follow the same segmentation.

### Terminal tab
- CWD defaults to the group's parent folder (`workspaces/<groupName>/`).
- Single terminal pane (no segmentation); user can `cd orca/` or `cd ploy-client/` freely.
- "New terminal here" from a member's file/diff view starts in that member's subfolder; the default terminal tab opens at the parent.
- Agent is launched at the parent. Env vars:
  - `CONDUCTOR_WORKSPACE_NAME` = group's `workspaceName` (unchanged semantics).
  - `CONDUCTOR_WORKSPACE_REPOS` = new; comma-separated list of member repo subfolder names so scripts/agents can discover structure.

### Editor / browser tabs
- Editor tabs carry their owning member via the existing `worktreeId` field; tab title shows a repo badge.
- Browser tabs unchanged.

## Branch & PR coordination

- At create time, the group's `branchName` is used as the new branch in every member repo, each branched off that member's chosen base ref.
- After creation, branches are **independent**. Renaming/rebasing one member's branch does not affect the others. The same-name invariant is a creation default, not an enforced runtime rule.
- If a member's branch is renamed externally, Orca records the drift on that member's row but does not attempt to re-align the group.
- Each member tracks its own `pushTarget` and `linkedPR` as today (per-repo concept, unchanged). The group card aggregates these into stacked rows.
- "Create PR" remains a per-row action — each PR is filed in its own repo. A "Create PRs for all members" convenience is out of v1.

## Archive cascade

- "Archive group" is the only archive action (no per-member archive in v1).
- Cleanup: each member's `orca.yaml` archive script runs in parallel in its own member subfolder.
- **All-or-nothing.** If any member's cleanup fails, the group stays unarchived; per-member `archiveCleanupError` strings surface inside the group card so the user can see which repo blocked it. Retry re-runs all members (idempotent scripts assumed, matches today).
- On success:
  - `WorkspaceGroup.isArchived = true`, `archivedAt = now`.
  - All member worktree directories are removed.
  - The parent group folder is removed.
  - Each member's git worktree is unregistered from its repo (`git worktree remove`).
  - Linked PRs are left alone (consistent with today's worktree-archive behavior).
- The group row moves to the Archived section as a single archived entry. "Restore" is not in v1, matching today's archive flow.

## Edge cases

- **Renaming a repo:** rejected if the new name would collide with any existing group name.
- **Importing a folder at a group path:** rejected — the group owns that path.
- **Group folder deleted externally:** detected on refresh; group is flagged "missing on disk" rather than silently re-created.
- **Member worktree removed externally** (e.g. `git worktree remove` outside Orca): the member entry is flagged stale; group surfaces a per-member error and offers a recreate action.
- **Connection-target drift:** a group cannot mix local + SSH members. If a host SSH connection is removed for one member, the whole group becomes unavailable until the connection is restored (same behavior as today's SSH-bound worktrees).

## Out of scope for v1

- Promoting a single-repo workspace into a group, or adding/removing a repo from an existing group.
- Per-member independent archive, pin, sort, or rename.
- The same repo appearing twice in one group.
- A group-level `orca.group.yaml` for cross-repo setup/run orchestration.
- Cross-host groups (mixing local + SSH members).
- Bulk "create PRs across all members" action.
- "Restore archived group" UI.
