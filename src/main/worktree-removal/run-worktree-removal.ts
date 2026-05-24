import type { BrowserWindow } from 'electron'
import { rm } from 'fs/promises'
import type { Store } from '../persistence'
import { isFolderRepo } from '../../shared/repo-kind'
import { deleteWorktreeHistoryDir } from '../terminal-history'
import { removeWorktree } from '../git/worktree'
import { gitExecFileAsync } from '../git/runner'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import { getEffectiveHooks, runHook } from '../hooks'
import { findGroupForWorktree, resolveGroupRepoNames } from '../workspace-group-runtime'
import {
  parseWorktreeId,
  formatWorktreeRemovalError,
  isOrphanedWorktreeError
} from '../ipc/worktree-logic'
import { notifyWorktreesChanged } from '../ipc/worktree-remote'
import { invalidateAuthorizedRootsCache } from '../ipc/filesystem-auth'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { killAllProcessesForWorktree } from '../runtime/worktree-teardown'
import { getLocalPtyProvider } from '../ipc/pty'
import { killRunForWorktree } from '../ipc/run-script'
import { killSetupForWorktree } from '../ipc/setup-script'
import { removeWorktreeSymlinks } from '../ipc/worktree-symlinks'

export type RunWorktreeRemovalArgs = {
  worktreeId: string
  force?: boolean
  skipArchive?: boolean
}

export type RunWorktreeRemovalDeps = {
  store: Store
  runtime: OrcaRuntimeService
  mainWindow: BrowserWindow
}

export async function runWorktreeRemoval(
  args: RunWorktreeRemovalArgs,
  deps: RunWorktreeRemovalDeps
): Promise<void> {
  const { store, runtime, mainWindow } = deps
  const { repoId, worktreePath } = parseWorktreeId(args.worktreeId)
  const repo = store.getRepo(repoId)
  if (!repo) {
    throw new Error(`Repo not found: ${repoId}`)
  }
  if (isFolderRepo(repo)) {
    throw new Error('Folder mode does not support deleting worktrees.')
  }

  // Why: clear the per-repo run + per-worktree setup script registries
  // BEFORE filesystem removal so the PTY's cwd still exists at shutdown
  // time and the renderer's scripts slice receives the *:exited
  // broadcasts (Phase 9). These registries live in main and apply to
  // both local and SSH repos, so they run regardless of connectionId —
  // unlike the local-only generic-PTY sweep below.
  await killRunForWorktree({ repoId, worktreeId: args.worktreeId }, { store }).catch((err) => {
    console.warn(`[run-script] cleanup failed for ${args.worktreeId}:`, err)
  })
  await killSetupForWorktree({ worktreeId: args.worktreeId }, { store }).catch((err) => {
    console.warn(`[setup-script] cleanup failed for ${args.worktreeId}:`, err)
  })

  // Why: kill every PTY belonging to this worktree BEFORE git-level
  // removal. The renderer pre-kills via shutdownWorktreeTerminals, but
  // defensive teardown here protects against: (a) a future renderer bug,
  // (b) a disconnected window, (c) an out-of-band window.api.worktrees.remove
  // caller. Placement is before the SSH early-return so local-host PTYs
  // are still reaped for local repos; SSH-backed PTYs are handled by the
  // remote provider's own teardown (design §4.3, §6).
  if (!repo.connectionId) {
    await killAllProcessesForWorktree(args.worktreeId, {
      runtime,
      localProvider: getLocalPtyProvider()
    })
      .then((r) => {
        const total = r.runtimeStopped + r.providerStopped + r.registryStopped
        if (total > 0) {
          console.info(
            `[worktree-teardown] ${args.worktreeId} killed runtime=${r.runtimeStopped} provider=${r.providerStopped} registry=${r.registryStopped}`
          )
        }
      })
      .catch((err) => {
        console.warn(`[worktree-teardown] failed for ${args.worktreeId}:`, err)
      })
  }

  if (repo.connectionId) {
    const provider = getSshGitProvider(repo.connectionId)
    if (!provider) {
      throw new Error(`No git provider for connection "${repo.connectionId}"`)
    }
    await provider.removeWorktree(worktreePath, args.force)
    runtime.clearOptimisticReconcileToken(args.worktreeId)
    store.removeWorktreeMeta(args.worktreeId)
    deleteWorktreeHistoryDir(args.worktreeId)
    notifyWorktreesChanged(mainWindow, repoId)
    return
  }

  // Run archive hook before removal
  const hooks = getEffectiveHooks(repo)
  if (hooks?.scripts.archive && !args.skipArchive) {
    // Why: pull workspaceName from the meta we're about to delete so the
    // archive script sees $CONDUCTOR_WORKSPACE_NAME — same value setup/run
    // used. removeWorktreeMeta runs after this returns, so the read is safe.
    const archiveWorkspaceName = store.getWorktreeMeta(args.worktreeId)?.workspaceName
    // Why: grouped worktrees also surface their sibling repos via
    // $CONDUCTOR_WORKSPACE_REPOS so archive scripts can fan out across the
    // group (e.g. drop Postgres DBs named after each sibling). Absent when
    // the worktree isn't a group member.
    const group = findGroupForWorktree(args.worktreeId, store.getWorkspaceGroups())
    const groupRepos = group ? resolveGroupRepoNames(group) : undefined
    const result = await runHook(
      'archive',
      worktreePath,
      repo,
      undefined,
      archiveWorkspaceName,
      groupRepos
    )
    if (!result.success) {
      console.error(`[hooks] archive hook failed for ${worktreePath}:`, result.output)
    }
  }

  // Why: `git worktree remove` (non-force) refuses to delete a worktree
  // that has untracked files, and a symlink pointing into the primary
  // checkout looks untracked to git. Unlink the user-configured symlinks
  // first so the normal delete path keeps working — otherwise every
  // deletion would require the Force Delete toast once the feature is on.
  if (repo.symlinkPaths && repo.symlinkPaths.length > 0) {
    await removeWorktreeSymlinks(worktreePath, repo.symlinkPaths)
  }

  try {
    await removeWorktree(repo.path, worktreePath, args.force ?? false)
  } catch (error) {
    // If git no longer tracks this worktree, clean up the directory and metadata
    if (isOrphanedWorktreeError(error)) {
      console.warn(`[worktrees] Orphaned worktree detected at ${worktreePath}, cleaning up`)
      await rm(worktreePath, { recursive: true, force: true }).catch(() => {})
      // Why: `git worktree remove` failed, so git's internal worktree tracking
      // (`.git/worktrees/<name>`) is still intact. Without pruning, `git worktree
      // list` continues to show the stale entry and the branch it had checked out
      // remains locked — other worktrees cannot check it out.
      await gitExecFileAsync(['worktree', 'prune'], { cwd: repo.path }).catch(() => {})
      runtime.clearOptimisticReconcileToken(args.worktreeId)
      store.removeWorktreeMeta(args.worktreeId)
      deleteWorktreeHistoryDir(args.worktreeId)
      invalidateAuthorizedRootsCache()
      notifyWorktreesChanged(mainWindow, repoId)
      return
    }
    throw new Error(formatWorktreeRemovalError(error, worktreePath, args.force ?? false))
  }
  runtime.clearOptimisticReconcileToken(args.worktreeId)
  store.removeWorktreeMeta(args.worktreeId)
  deleteWorktreeHistoryDir(args.worktreeId)
  invalidateAuthorizedRootsCache()

  notifyWorktreesChanged(mainWindow, repoId)
}
