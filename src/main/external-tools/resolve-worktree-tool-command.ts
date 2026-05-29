import type { GlobalSettings } from '../../shared/types'

export type ExternalTool = 'editor' | 'diff' | 'database'

export type WorktreeToolPlaceholders = {
  WORKTREE_PATH: string
  WORKSPACE_NAME: string
  REPO_PATH: string
  BASE_BRANCH: string
  MERGE_BASE: string
  HEAD: string
  DATABASE_URL: string
}

/** Custom-command string the user configured for `tool`. Empty string means the
 *  tool has no custom command (button stays disabled in the bar). */
export function getConfiguredToolCommand(settings: GlobalSettings, tool: ExternalTool): string {
  switch (tool) {
    case 'editor':
      return settings.externalEditorCommand
    case 'diff':
      return settings.externalDiffCommand
    case 'database':
      return settings.externalDatabaseCommand
  }
}

// Why: textual `${KEY}` substitution rather than shell env expansion — the same
// command must work inside an emacsclient eval form, which the shell never
// expands because it is single-quoted. Unknown `${...}` tokens are left as-is.
// Values are inserted verbatim; the user quotes them as in any shell command
// (same trust model as git's core.editor).
export function substituteToolPlaceholders(
  template: string,
  values: WorktreeToolPlaceholders
): string {
  return (Object.keys(values) as (keyof WorktreeToolPlaceholders)[]).reduce(
    // Why: the escaped `\$` keeps the literal token `${KEY}` from being read as
    // a template interpolation — we want to match that text, not expand it.
    (acc, key) => acc.split(`\${${key}}`).join(values[key]),
    template
  )
}
