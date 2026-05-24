import { basename } from 'path'

import { buildMemberScopedRef } from '../shared/automation-member-scoped-ref'
import type { Repo, WorkspaceGroup } from '../shared/types'
import { splitWorktreeId } from '../shared/worktree-id'

/**
 * Resolve the ordered list of member subfolder names for a group.
 * Each entry is the basename of the corresponding member worktree's path
 * (i.e. the `<repoFolderName>` segment under `<parentPath>/`). Used to
 * populate the `CONDUCTOR_WORKSPACE_REPOS` env var.
 */
export function resolveGroupRepoNames(group: WorkspaceGroup): string[] {
  // Why: members live at `<parentPath>/<repoFolderName>`, encoded in the
  // worktreeId as `<repoId>::<path>`. Pull the basename out of the path
  // segment so the list mirrors what users see on disk.
  return group.memberWorktreeIds
    .map((id) => splitWorktreeId(id)?.worktreePath)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map((p) => basename(p))
}

/**
 * Find the group that owns `worktreeId`, if any. Linear scan over a small N
 * (typically < 10 groups); fine for terminal-spawn frequency.
 */
export function findGroupForWorktree(
  worktreeId: string,
  groups: readonly WorkspaceGroup[]
): WorkspaceGroup | undefined {
  return groups.find((g) => g.memberWorktreeIds.includes(worktreeId))
}

/**
 * Find a group by its `group:<uuid>` id. Returns undefined when nothing
 * matches — callers decide whether to fail-fast or silently fall through.
 * Linear scan: same N + frequency reasoning as findGroupForWorktree.
 */
export function findGroupById(
  groupId: string,
  groups: readonly WorkspaceGroup[]
): WorkspaceGroup | undefined {
  return groups.find((g) => g.id === groupId)
}

/**
 * Templating-shape view of a workspace group, suitable to dump into a chain
 * run's context as `group.*`. Lets steps reference
 *
 *     {{group.id}}
 *     {{group.parentPath}}
 *     {{group.members.<repoFolderName>.worktreeId}}
 *     {{group.members.<repoFolderName>.path}}
 *     {{group.members.<repoFolderName>.scoped}}    // member-scoped wire ref
 *     {{group.members.<repoFolderName>.description}}
 *
 * Members are keyed by `basename(memberPath)` — the same `<repoFolderName>`
 * segment users see on disk under `<parentPath>/`. Member entries are
 * primitive-leaf only (strings) so `resolveTemplate` accepts them; that's why
 * `repoId` is also a string rather than a richer object.
 */
export type GroupTemplateContext = {
  id: string
  parentPath: string
  members: Record<
    string,
    {
      worktreeId: string
      path: string
      repoId: string
      /** Pre-built member-scoped wire ref so authors can paste
       *  `{{group.members.<repoName>.scoped}}` straight into a `worktreeRef`
       *  slot instead of hand-assembling the `member:<groupId>:<worktreeId>`
       *  string. Recognized by the run-prompt runner's member-scoped branch. */
      scoped: string
      /** User-authored Repo.description (empty string when absent). Lets
       *  automation templates hand repo context to agents. The empty leaf is
       *  intentional — `resolveTemplate` accepts the empty string cleanly so
       *  prompts with this slot still render in groups whose members haven't
       *  set a description yet. */
      description: string
    }
  >
}

/**
 * Resolver for a member's user-authored `Repo.description`. Caller supplies
 * the lookup (typically `store.getRepo`) rather than the runtime importing
 * Store, so workspace-group-runtime stays a leaf module that test fixtures
 * can drive with a plain map.
 */
export type RepoDescriptionLookup = (repoId: string) => string | undefined

export function buildGroupTemplateContext(
  group: WorkspaceGroup,
  getRepoDescription?: RepoDescriptionLookup
): GroupTemplateContext {
  const members: GroupTemplateContext['members'] = {}
  for (const id of group.memberWorktreeIds) {
    const parsed = splitWorktreeId(id)
    if (!parsed) {
      continue
    }
    const folder = basename(parsed.worktreePath)
    if (!folder) {
      continue
    }
    members[folder] = {
      worktreeId: id,
      path: parsed.worktreePath,
      repoId: parsed.repoId,
      scoped: buildMemberScopedRef(group.id, id),
      description: getRepoDescription?.(parsed.repoId) ?? ''
    }
  }
  return {
    id: group.id,
    parentPath: group.parentPath,
    members
  }
}

/** Convenience adapter so callers with a Repo lookup don't need to write the
 *  `r => r?.description` glue themselves. */
export function repoDescriptionFromGetRepo(
  getRepo: (repoId: string) => Repo | undefined
): RepoDescriptionLookup {
  return (repoId) => getRepo(repoId)?.description
}

/**
 * Decide the effective `cwd` for a new terminal in a group member.
 *
 * Default new terminals (no supplied cwd, or supplied cwd equal to the
 * worktree path the renderer fed in) land at the group's `parentPath` so
 * `pwd` shows the shared workspace folder and users can `cd` into any
 * member. Explicit overrides — "Open terminal here" from a file pane, or
 * a Cmd+D split inheriting a live cwd — keep whatever the caller supplied.
 *
 * Non-grouped worktrees fall through unchanged.
 */
export function resolveTerminalCwd(input: {
  worktreePath: string | undefined
  group: WorkspaceGroup | undefined
  suppliedCwd: string | undefined
}): string | undefined {
  const { worktreePath, group, suppliedCwd } = input
  if (!group) {
    return suppliedCwd
  }
  if (suppliedCwd === undefined || suppliedCwd === worktreePath) {
    return group.parentPath
  }
  return suppliedCwd
}
