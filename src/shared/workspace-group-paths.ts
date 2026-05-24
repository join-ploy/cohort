import { join } from 'path'

// Group worktrees live under `<workspacesRoot>/<groupName>/<repoFolderName>`.
// Use path.join so Windows/Linux/Mac all produce a valid separator.

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
