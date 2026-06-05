import { isFolderRepo } from '../../shared/repo-kind'
import type { CreateWorktreeArgs, GitPushTarget, Repo } from '../../shared/types'
import { gitExecFileAsync } from './runner'
import { getDefaultRemote } from './repo'
import { getPullRequestPushTarget, getWorkItem } from '../github/client'

/**
 * Resolves the base branch (and optional push target) for starting a worktree
 * from a PR. Extracted from the `worktrees:resolvePrBase` IPC handler so it can
 * be reused outside Electron IPC; the caller supplies an already-resolved repo.
 */
export async function resolvePrBaseCore(args: {
  repo: Repo
  prNumber: number
  headRefName?: string
  isCrossRepository?: boolean
}): Promise<{ baseBranch: string; pushTarget?: GitPushTarget } | { error: string }> {
  const repo = args.repo
  // Why: remote SSH repos are out of scope in v1. The picker already
  // disables its PR tab for them — this guard belt-and-suspenders it.
  if (repo.connectionId) {
    return { error: 'PR start points are not supported for remote repos yet.' }
  }
  if (isFolderRepo(repo)) {
    return { error: 'Folder mode does not support creating worktrees.' }
  }

  let headRefName = args.headRefName?.trim() ?? ''
  let isCrossRepository = args.isCrossRepository === true
  let pushTarget: CreateWorktreeArgs['pushTarget'] | undefined

  // Skip the gh lookup when both hints are present (picker already has them).
  if (!headRefName) {
    // Why: the caller already knows this is a PR number, so scope the
    // lookup to `type: 'pr'` and skip the speculative issue-first probe
    // that would hit the upstream issue tracker for fork checkouts.
    const item = await getWorkItem(repo.path, args.prNumber, 'pr')
    if (!item || item.type !== 'pr') {
      return { error: `PR #${args.prNumber} not found.` }
    }
    headRefName = (item.branchName ?? '').trim()
    if (!headRefName) {
      return { error: `PR #${args.prNumber} has no head branch.` }
    }
    if (item.isCrossRepository === true) {
      isCrossRepository = true
    }
  }
  if (isCrossRepository) {
    try {
      pushTarget = (await getPullRequestPushTarget(repo.path, args.prNumber)) ?? undefined
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : `Could not resolve PR #${args.prNumber} head push target.`
      }
    }
    if (!pushTarget) {
      return { error: `Could not resolve PR #${args.prNumber} head push target.` }
    }
  }

  let remote: string
  try {
    remote = await getDefaultRemote(repo.path)
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not resolve git remote.' }
  }

  // Why: fork PR heads live on a remote we don't have configured, so
  // `git fetch <remote> <headRefName>` would fail. GitHub exposes every
  // PR head (fork or same-repo) as refs/pull/<N>/head on the upstream
  // repo. Fetch that and snapshot the SHA — the new worktree branch is
  // derived from the workspace name, so there's no tracking ref to set
  // up, which makes SHA semantics ("branch from this commit") cleaner
  // than returning a ref that would go stale on force-push.
  if (isCrossRepository) {
    const pullRef = `refs/pull/${args.prNumber}/head`
    try {
      await gitExecFileAsync(['fetch', remote, pullRef], { cwd: repo.path })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        error: `Failed to fetch ${pullRef}: ${message.split('\n')[0]}`
      }
    }
    let sha: string
    try {
      const { stdout } = await gitExecFileAsync(['rev-parse', '--verify', 'FETCH_HEAD'], {
        cwd: repo.path
      })
      sha = stdout.trim()
    } catch {
      return { error: `Could not resolve fork PR #${args.prNumber} head after fetch.` }
    }
    if (!sha) {
      return { error: `Empty SHA resolving fork PR #${args.prNumber} head.` }
    }
    return { baseBranch: sha, ...(pushTarget ? { pushTarget } : {}) }
  }

  try {
    await gitExecFileAsync(
      ['fetch', remote, `+refs/heads/${headRefName}:refs/remotes/${remote}/${headRefName}`],
      { cwd: repo.path }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      error: `Failed to fetch ${remote}/${headRefName}: ${message.split('\n')[0]}`
    }
  }

  const remoteRef = `${remote}/${headRefName}`
  try {
    await gitExecFileAsync(['rev-parse', '--verify', remoteRef], { cwd: repo.path })
  } catch {
    return { error: `Remote ref ${remoteRef} does not exist after fetch.` }
  }

  if (!pushTarget) {
    pushTarget = { remoteName: remote, branchName: headRefName }
  }
  return { baseBranch: remoteRef, pushTarget }
}
