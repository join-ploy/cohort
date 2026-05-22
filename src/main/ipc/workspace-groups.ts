import { mkdirSync } from 'fs'
import { basename } from 'path'
import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type {
  CreateWorkspaceGroupArgs,
  CreateWorkspaceGroupResult,
  CreateWorktreeArgs,
  Repo,
  WorkspaceGroup,
  Worktree
} from '../../shared/types'
import { memberWorktreePath, resolveGroupParentPath } from '../../shared/workspace-group-paths'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { createLocalWorktree, createRemoteWorktree } from './worktree-remote'

// Why: repo folders are derived from the on-disk basename (stripped of the
// `.git` suffix bare repos carry) so member layouts match the convention
// `computeWorktreePath` already uses for nested workspaces.
function repoFolderName(repo: Repo): string {
  return basename(repo.path).replace(/\.git$/, '')
}

export function registerWorkspaceGroupHandlers(
  mainWindow: BrowserWindow,
  store: Store,
  runtime: OrcaRuntimeService
): void {
  // Why: idempotent re-registration matches the pattern used by other IPC
  // modules (registerWorktreeHandlers) so macOS app re-activation, which
  // rebuilds the main window, can re-attach handlers without throwing.
  ipcMain.removeHandler('workspace-groups:create')

  ipcMain.handle(
    'workspace-groups:create',
    async (_event, args: CreateWorkspaceGroupArgs): Promise<CreateWorkspaceGroupResult> => {
      if (!Array.isArray(args.members) || args.members.length < 2) {
        throw new Error('A workspace group needs at least two members.')
      }

      const seenRepoIds = new Set<string>()
      const repos: Repo[] = []
      for (const member of args.members) {
        if (seenRepoIds.has(member.repoId)) {
          throw new Error(`Duplicate member repo: ${member.repoId}`)
        }
        seenRepoIds.add(member.repoId)
        const repo = store.getRepo(member.repoId)
        if (!repo) {
          throw new Error(`Repo not found: ${member.repoId}`)
        }
        repos.push(repo)
      }

      // Why: full connection-uniformity validation lands in C8; this stub keeps
      // the happy path honest by rejecting obviously-mixed targets so the
      // path-derivation below can assume a single workspace root.
      const firstConnectionId = repos[0].connectionId ?? null
      for (const repo of repos) {
        if ((repo.connectionId ?? null) !== firstConnectionId) {
          throw new Error('All members of a workspace group must share the same connection target.')
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
        const path = memberWorktreePath(
          settings.workspaceDir,
          args.workspaceName,
          repoFolderName(repo)
        )
        const createArgs: CreateWorktreeArgs = {
          repoId: member.repoId,
          name: args.workspaceName,
          workspaceName: args.workspaceName,
          ...(args.displayName ? { displayName: args.displayName } : {}),
          ...(member.baseRef ? { baseBranch: member.baseRef } : {}),
          setupDecision: member.setupDecision,
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

      const results = await Promise.all(memberCreatePromises)
      const memberWorktrees: Worktree[] = results.map((result) => result.worktree)

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
  )
}
