import { ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import type { Store } from '../persistence'
import { gitExecFileAsync } from '../git/runner'
import { getEffectiveHooks } from '../hooks'
import { getDefaultBaseRef } from '../git/repo'
import {
  getConfiguredToolCommand,
  substituteToolPlaceholders,
  type ExternalTool,
  type WorktreeToolPlaceholders
} from '../external-tools/resolve-worktree-tool-command'

export type RunExternalToolArgs = {
  tool: ExternalTool
  worktreeId: string
  worktreePath: string
  repoId: string
  workspaceName: string
  /** The user-facing label given to the workspace (Worktree.displayName), as
   *  opposed to the git-safe `workspaceName` slug. */
  displayName: string
}

export type RunExternalToolResult = { ok: boolean; error?: string }

// Why: refs are resolved tolerantly — an unborn HEAD or a missing merge-base
// must not abort the launch; the command just gets an empty string for that
// placeholder.
async function resolveRefSafe(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await gitExecFileAsync(args, { cwd })
    return stdout.trim()
  } catch {
    return ''
  }
}

export function registerExternalToolHandlers(store: Store): void {
  ipcMain.handle(
    'externalTool:run',
    async (_event, args: RunExternalToolArgs): Promise<RunExternalToolResult> => {
      const template = getConfiguredToolCommand(store.getSettings(), args.tool)
      if (!template.trim()) {
        return { ok: false, error: 'No command configured' }
      }

      const repo = store.getRepo(args.repoId)
      const meta = store.getWorktreeMeta(args.worktreeId)
      const baseBranch =
        meta?.baseRef ||
        meta?.sparseBaseRef ||
        repo?.worktreeBaseRef ||
        (repo ? getDefaultBaseRef(repo.path) : null) ||
        ''

      const head = await resolveRefSafe(['rev-parse', 'HEAD'], args.worktreePath)
      const mergeBase = baseBranch
        ? await resolveRefSafe(['merge-base', baseBranch, 'HEAD'], args.worktreePath)
        : ''

      const rawDatabaseUrl = repo
        ? (getEffectiveHooks(repo, args.worktreePath)?.databaseUrl ?? '')
        : ''
      const databaseUrl = rawDatabaseUrl.split('${WORKSPACE_NAME}').join(args.workspaceName)

      const values: WorktreeToolPlaceholders = {
        WORKTREE_PATH: args.worktreePath,
        WORKSPACE_NAME: args.workspaceName,
        WORKSPACE_DISPLAY_NAME: args.displayName,
        REPO_PATH: repo?.path ?? '',
        BASE_BRANCH: baseBranch,
        MERGE_BASE: mergeBase,
        HEAD: head,
        DATABASE_URL: databaseUrl
      }

      const command = substituteToolPlaceholders(template, values)

      return await new Promise<RunExternalToolResult>((resolve) => {
        try {
          // Why: shell:true so a full command string (incl. emacsclient eval)
          // runs through the platform shell; detached + unref so the launched
          // editor outlives Orca's main process, mirroring shell:openVscode.
          const child = spawn(command, { shell: true, detached: true, stdio: 'ignore' })
          child.once('error', (err: Error) => resolve({ ok: false, error: err.message }))
          child.once('spawn', () => {
            child.unref()
            resolve({ ok: true })
          })
        } catch (err) {
          resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })
    }
  )
}
