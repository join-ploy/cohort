import { mkdirSync, rmSync } from 'fs'
import { basename } from 'path'
import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type {
  CreateWorkspaceGroupArgs,
  CreateWorkspaceGroupResult,
  CreateWorktreeArgs,
  CreateWorktreeResult,
  Repo,
  WorkspaceGroup,
  Worktree
} from '../../shared/types'
import { memberWorktreePath, resolveGroupParentPath } from '../../shared/workspace-group-paths'
import { validateGroupName } from '../../shared/workspace-group-namespace'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { runWorktreeRemoval } from '../worktree-removal/run-worktree-removal'
import { createLocalWorktree, createRemoteWorktree } from './worktree-remote'

// Why: repo folders are derived from the on-disk basename (stripped of the
// `.git` suffix bare repos carry) so member layouts match the convention
// `computeWorktreePath` already uses for nested workspaces.
export function repoFolderName(repo: Repo): string {
  return basename(repo.path).replace(/\.git$/, '')
}

/**
 * Core create-workspace-group flow, lifted out of the IPC handler so the
 * automations chain runner (`create-workspace-group-runner`) can invoke it
 * directly without going through ipcMain. Validates inputs (namespace,
 * member count, uniform connection target), creates every member worktree
 * in parallel, rolls back successes on any failure, and persists the
 * resulting WorkspaceGroup plus member meta. The IPC handler is now a thin
 * wrapper around this function.
 */
export async function createWorkspaceGroup(
  args: CreateWorkspaceGroupArgs,
  deps: { store: Store; runtime: OrcaRuntimeService; mainWindow: BrowserWindow }
): Promise<CreateWorkspaceGroupResult> {
  const { store, runtime, mainWindow } = deps
  // Why (C7/C8): validate up front so invalid inputs reject cleanly with no
  // filesystem side effects. Each rule throws a distinct, user-readable
  // message so the renderer can surface specific guidance.
  if (!Array.isArray(args.members) || args.members.length < 2) {
    throw new Error('A workspace group needs at least 2 member repos.')
  }

  const repoIds = args.members.map((m) => m.repoId)
  const seen = new Set<string>()
  for (const repoId of repoIds) {
    if (seen.has(repoId)) {
      throw new Error(`A repo can appear at most once in a group: ${repoId} listed twice.`)
    }
    seen.add(repoId)
  }

  const repos: Repo[] = []
  for (const member of args.members) {
    const repo = store.getRepo(member.repoId)
    if (!repo) {
      throw new Error(`Repo not found: ${member.repoId}.`)
    }
    repos.push(repo)
  }

  // Why: namespace check uses on-disk folder names of every existing repo +
  // all persisted group workspaceNames so the new group can never collide
  // with a sibling that already occupies the workspaces/<name> slot.
  const namespaceResult = validateGroupName(args.workspaceName, {
    repoFolderNames: store.getRepos().map(repoFolderName),
    existingGroupNames: store.getWorkspaceGroups().map((g) => g.workspaceName)
  })
  if (!namespaceResult.ok) {
    switch (namespaceResult.reason) {
      case 'empty':
        throw new Error('Group name cannot be empty.')
      case 'invalid-chars':
        throw new Error(`Group name "${args.workspaceName}" contains invalid characters.`)
      case 'collides-with-repo':
        throw new Error(`Group name "${args.workspaceName}" collides with an existing repo folder.`)
      case 'collides-with-group':
        throw new Error(`Group name "${args.workspaceName}" collides with an existing group.`)
    }
  }

  // Why: a single group cannot span local + SSH because the worktree layout
  // and create paths differ per connection target. Treat null/undefined as
  // the same "local" value so older persisted Repos without an explicit
  // connectionId still match local-to-local.
  const firstConnectionId = repos[0].connectionId ?? null
  for (const repo of repos) {
    if ((repo.connectionId ?? null) !== firstConnectionId) {
      throw new Error('A workspace group cannot mix local and SSH repos.')
    }
  }

  const settings = store.getSettings()
  const parentPath = resolveGroupParentPath(settings.workspaceDir, args.workspaceName)
  // Why: `git worktree add` will create its own leaf directory, so we only
  // need to ensure the shared parent exists. `recursive: true` makes the
  // call a no-op when prior members of the same group already created it.
  mkdirSync(parentPath, { recursive: true })

  const memberCreatePromises = args.members.map((member, index) => {
    const repo = repos[index]
    const path = memberWorktreePath(settings.workspaceDir, args.workspaceName, repoFolderName(repo))
    const createArgs: CreateWorktreeArgs = {
      repoId: member.repoId,
      name: args.workspaceName,
      workspaceName: args.workspaceName,
      ...(args.displayName ? { displayName: args.displayName } : {}),
      ...(member.baseRef ? { baseBranch: member.baseRef } : {}),
      setupDecision: member.setupDecision,
      // Why: stamp createdWithAgent per-member so the worktree-reopen flow
      // (buildCreatedAgentReopenStartup) can re-seed the same agent if the
      // user closes the terminal and re-activates the member later. Mirrors
      // the single-repo CreateWorktreeArgs path.
      ...(member.createdWithAgent ? { createdWithAgent: member.createdWithAgent } : {}),
      ...(args.createdByAutomationRunId
        ? { createdByAutomationRunId: args.createdByAutomationRunId }
        : {}),
      pathOverride: path
    }
    // Why: createRemoteWorktree currently derives its own remote-side path
    // and does not honor `pathOverride`. The uniform-connection guard
    // above means we still funnel SSH members through it; full remote
    // grouped-layout support is C8/C9 work.
    return repo.connectionId
      ? createRemoteWorktree(createArgs, repo, store, mainWindow)
      : createLocalWorktree(createArgs, repo, store, mainWindow, runtime)
  })

  // Why (C5/C6): use allSettled instead of all so a single member failure
  // doesn't leak orphan worktrees + persisted WorktreeMeta from the members
  // that already succeeded. We need every outcome to decide what to roll
  // back from disk and the store.
  const settled = await Promise.allSettled(memberCreatePromises)
  const failures = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  const successes = settled.filter(
    (r): r is PromiseFulfilledResult<CreateWorktreeResult> => r.status === 'fulfilled'
  )

  if (failures.length > 0) {
    // Roll back each successful member via the shared per-worktree removal
    // helper — it handles `git worktree remove --force`, optimistic-token
    // clear, WorktreeMeta deletion, and history dir cleanup in one shot,
    // and is tolerant of an already-gone directory (orphan fallback).
    for (const success of successes) {
      const worktree = success.value.worktree
      try {
        await runWorktreeRemoval(
          { worktreeId: worktree.id, force: true, skipArchive: true },
          { store, runtime, mainWindow }
        )
      } catch (cleanupError) {
        // Why: don't let a cleanup failure mask the original create error —
        // the user needs to see why the group create rejected, not why
        // a cleanup step further down the chain blew up. Log loudly so the
        // operator can still find any leftover state.
        console.warn(
          `[workspace-groups] rollback failed to remove worktree ${worktree.id}:`,
          cleanupError
        )
      }
    }
    try {
      rmSync(parentPath, { recursive: true, force: true })
    } catch (cleanupError) {
      console.warn(
        `[workspace-groups] rollback failed to remove parent folder ${parentPath}:`,
        cleanupError
      )
    }

    const firstFailure = failures[0]
    const failedMemberIndex = settled.indexOf(firstFailure)
    const failedRepo = repos[failedMemberIndex]
    const cause = firstFailure.reason
    const causeMessage = cause instanceof Error ? cause.message : String(cause)
    throw new Error(
      `Failed to create workspace group "${args.workspaceName}": ` +
        `member "${failedRepo?.id ?? 'unknown'}" failed — ${causeMessage}`
    )
  }

  const memberWorktrees: Worktree[] = successes.map((result) => result.value.worktree)

  const groupId = `group:${randomUUID()}`
  const now = Date.now()
  const group: WorkspaceGroup = {
    id: groupId,
    workspaceName: args.workspaceName,
    displayName: args.displayName ?? args.workspaceName,
    parentPath,
    memberWorktreeIds: memberWorktrees.map((wt) => wt.id),
    branchName: args.branchName,
    isArchived: false,
    archivedAt: null,
    isPinned: false,
    sortOrder: now,
    lastActivityAt: now,
    isUnread: false,
    comment: args.comment ?? '',
    createdAt: now,
    ...(args.createdByAutomationRunId
      ? { createdByAutomationRunId: args.createdByAutomationRunId }
      : {}),
    linkedIssue: null,
    linkedLinearIssue: null
  }
  store.setWorkspaceGroup(group)

  // Why: stamp `groupId` on each member's persisted meta so card-level
  // state (pin, archive, activity) resolves through the group going
  // forward — see WorktreeMeta.groupId.
  for (const worktree of memberWorktrees) {
    store.setWorktreeMeta(worktree.id, { groupId })
  }

  return { group, memberWorktrees }
}

export function registerWorkspaceGroupHandlers(
  mainWindow: BrowserWindow,
  store: Store,
  runtime: OrcaRuntimeService
): void {
  // Why: idempotent re-registration matches the pattern used by other IPC
  // modules (registerWorktreeHandlers) so macOS app re-activation, which
  // rebuilds the main window, can re-attach handlers without throwing.
  ipcMain.removeHandler('workspace-groups:list')
  ipcMain.handle('workspace-groups:list', (): WorkspaceGroup[] => store.getWorkspaceGroups())

  ipcMain.removeHandler('workspace-groups:archive')
  ipcMain.handle(
    'workspace-groups:archive',
    async (_event, args: { groupId: string }): Promise<WorkspaceGroup> => {
      const existing = store.getWorkspaceGroups().find((g) => g.id === args.groupId)
      if (!existing) {
        throw new Error(`Workspace group not found: ${args.groupId}`)
      }
      // Why: archive is idempotent. A second click (or a retry after a partial
      // success in a previous run that the user manually cleaned up) shouldn't
      // re-run removal on already-gone members.
      if (existing.isArchived) {
        return existing
      }

      // Why (K1): fan out per-member archive in parallel via the shared
      // runWorktreeRemoval helper. We keep skipArchive=false so the user's
      // archive hook still fires inside each member, and force=false so the
      // hook can refuse on dirty state — matching today's single-worktree
      // archive cleanup semantics from cleanup-service.ts.
      const memberIds = existing.memberWorktreeIds
      const settled = await Promise.allSettled(
        memberIds.map((worktreeId) =>
          runWorktreeRemoval(
            { worktreeId, force: false, skipArchive: false },
            { store, runtime, mainWindow }
          )
        )
      )

      const failures: { worktreeId: string; reason: unknown }[] = []
      settled.forEach((result, index) => {
        if (result.status === 'rejected') {
          failures.push({ worktreeId: memberIds[index], reason: result.reason })
        }
      })

      if (failures.length > 0) {
        // Why (K2): all-or-nothing on the group flag — failed members keep the
        // group in the unarchived list so the user can retry. Concatenate
        // per-member errors into the single archiveCleanupError string the
        // schema already carries; ArchivedSection.tsx surfaces this verbatim
        // in the tooltip but groups stay in the visible list when not archived.
        const errorSummary = failures
          .map((f) => {
            const message = f.reason instanceof Error ? f.reason.message : String(f.reason)
            return `${f.worktreeId}: ${message}`
          })
          .join('; ')
        const updated: WorkspaceGroup = {
          ...existing,
          archiveCleanupError: errorSummary
        }
        store.setWorkspaceGroup(updated)
        throw new Error(
          `Failed to archive workspace group "${existing.displayName}": ` +
            `${failures.length} of ${memberIds.length} member(s) failed — ${errorSummary}`
        )
      }

      // Why: every member's runWorktreeRemoval has already removed the leaf
      // directory and deleted its WorktreeMeta, so the parent folder is now
      // an empty shell that nothing else owns. rmSync is best-effort: a stray
      // .DS_Store left by Finder shouldn't block the archive flip.
      try {
        rmSync(existing.parentPath, { recursive: true, force: true })
      } catch (cleanupError) {
        console.warn(
          `[workspace-groups] archive: failed to remove parent folder ${existing.parentPath}:`,
          cleanupError
        )
      }

      const archived: WorkspaceGroup = {
        ...existing,
        isArchived: true,
        archivedAt: Date.now(),
        archiveCleanupError: null
      }
      store.setWorkspaceGroup(archived)
      return archived
    }
  )

  ipcMain.removeHandler('workspace-groups:create')

  ipcMain.handle(
    'workspace-groups:create',
    async (_event, args: CreateWorkspaceGroupArgs): Promise<CreateWorkspaceGroupResult> =>
      createWorkspaceGroup(args, { store, runtime, mainWindow })
  )

  // Why: small allow-list of mutable group fields so the renderer can rename,
  // edit comments, and toggle pin without growing a separate IPC per field.
  // Mirrors the single-worktree `worktrees:updateMeta` allow-list pattern —
  // never trust the renderer to write archive flags or memberWorktreeIds
  // through this seam; those have their own dedicated flows.
  ipcMain.removeHandler('workspace-groups:update')
  ipcMain.handle(
    'workspace-groups:update',
    async (
      _event,
      args: {
        groupId: string
        partial: { displayName?: string; comment?: string; isPinned?: boolean }
      }
    ): Promise<WorkspaceGroup> => {
      const existing = store.getWorkspaceGroups().find((g) => g.id === args.groupId)
      if (!existing) {
        throw new Error(`Workspace group not found: ${args.groupId}`)
      }
      const next: WorkspaceGroup = {
        ...existing,
        ...(typeof args.partial.displayName === 'string' &&
        args.partial.displayName.trim().length > 0
          ? { displayName: args.partial.displayName.trim() }
          : {}),
        ...(typeof args.partial.comment === 'string' ? { comment: args.partial.comment } : {}),
        ...(typeof args.partial.isPinned === 'boolean' ? { isPinned: args.partial.isPinned } : {})
      }
      store.setWorkspaceGroup(next)
      return next
    }
  )
}
