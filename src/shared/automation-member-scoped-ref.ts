/**
 * Sentinel wire format for "scope this run to repo X within group Y" — the
 * agent's CWD lands at the member worktree's path, but the terminal tab is
 * still bound to the group's lifecycle (status, tab strip, stop-all).
 *
 * Wire format (string-shape so it survives templating verbatim):
 *
 *     member:<groupId>:<worktreeId>
 *
 * Examples:
 *
 *     member:group:abc-uuid-1234:repo-a::/workspaces/feat-x/repo-a
 *     member:group:abc-uuid-1234:repo-b::/workspaces/feat-x/repo-b
 *
 * Parser shape: groupIds always match `group:<uuid>` (one colon, no `::`);
 * worktreeIds always contain `::` (the WORKTREE_ID_SEPARATOR). The boundary
 * between them is the third `:` from the start (after `member:` and `group:`).
 * Bytes after that boundary are the worktreeId verbatim.
 */

const PREFIX = 'member:'

/** True when `value` is shaped like a member-scoped ref. Cheap structural
 *  check — not a deep validation; full parsing happens in `parseMemberScopedRef`. */
export function isMemberScopedRef(value: string): boolean {
  return value.startsWith(PREFIX)
}

export type MemberScopedRef = {
  groupId: string
  worktreeId: string
}

/** Parse a wire-format ref into its components, or null if the format is
 *  malformed (missing prefix, missing group, missing worktreeId). */
export function parseMemberScopedRef(value: string): MemberScopedRef | null {
  if (!value.startsWith(PREFIX)) {
    return null
  }
  const rest = value.slice(PREFIX.length)
  // Why: groupId is exactly `group:<uuid>` — find the colon that ENDS the
  // groupId, which is the second colon in `rest` (`group:<uuid>:<worktreeId>`).
  if (!rest.startsWith('group:')) {
    return null
  }
  const afterGroupColon = rest.indexOf(':', 'group:'.length)
  if (afterGroupColon === -1) {
    return null
  }
  const groupId = rest.slice(0, afterGroupColon)
  const worktreeId = rest.slice(afterGroupColon + 1)
  if (groupId.length === 'group:'.length || worktreeId.length === 0) {
    return null
  }
  return { groupId, worktreeId }
}

/** Build a wire-format ref from its components. The output is a string so it
 *  flows through `resolveTemplate` and IPC unmodified. */
export function buildMemberScopedRef(groupId: string, worktreeId: string): string {
  return `${PREFIX}${groupId}:${worktreeId}`
}
