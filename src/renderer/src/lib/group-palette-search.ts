import type { WorkspaceGroup } from '../../../shared/types'

export type MatchRange = { start: number; end: number }

export type GroupPaletteSearchResult = {
  groupId: string
  displayNameRange: MatchRange | null
  branchRange: MatchRange | null
}

/**
 * Filter + match WorkspaceGroups against a Cmd+J query. Mirrors the surface
 * of `searchWorktrees` but operates on groups: an empty query returns every
 * non-archived group with null match metadata (Cmd+J's "recent" list); a
 * non-empty query keeps only groups that match on displayName or branchName.
 *
 * Why we don't index every field here: groups in v1 only carry displayName,
 * workspaceName, and branchName as searchable signals — comment / linkedIssue
 * exist on the type but are not surfaced in the GroupCard yet, so wiring them
 * into the palette would expose hidden state. Once group cards display those
 * fields we can extend the matcher.
 */
export function searchGroups(
  groups: readonly WorkspaceGroup[],
  query: string
): GroupPaletteSearchResult[] {
  const live = groups.filter((g) => !g.isArchived)
  if (!query) {
    return live.map((g) => ({
      groupId: g.id,
      displayNameRange: null,
      branchRange: null
    }))
  }

  const q = query.toLowerCase()
  const results: GroupPaletteSearchResult[] = []
  for (const group of live) {
    const displayNameMatch = findMatch(group.displayName, q)
    const branchMatch = findMatch(group.branchName, q)
    if (!displayNameMatch && !branchMatch) {
      continue
    }
    results.push({
      groupId: group.id,
      displayNameRange: displayNameMatch,
      branchRange: branchMatch
    })
  }
  return results
}

function findMatch(text: string, lowercaseQuery: string): MatchRange | null {
  const index = text.toLowerCase().indexOf(lowercaseQuery)
  if (index === -1) {
    return null
  }
  return { start: index, end: index + lowercaseQuery.length }
}
