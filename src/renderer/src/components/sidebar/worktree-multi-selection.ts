export type WorktreeSelectionIntent = 'replace' | 'toggle' | 'range'

export type WorktreeSelectionResult = {
  selectedIds: Set<string>
  anchorId: string
}

export function getWorktreeSelectionIntent(
  event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>,
  isMac: boolean
): WorktreeSelectionIntent {
  if (event.shiftKey) {
    return 'range'
  }
  const toggle = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  return toggle ? 'toggle' : 'replace'
}

export function updateWorktreeSelection(params: {
  visibleIds: readonly string[]
  previousSelectedIds: ReadonlySet<string>
  previousAnchorId: string | null
  targetId: string
  intent: WorktreeSelectionIntent
}): WorktreeSelectionResult {
  const { visibleIds, previousSelectedIds, previousAnchorId, targetId, intent } = params

  if (intent === 'replace') {
    return { selectedIds: new Set([targetId]), anchorId: targetId }
  }

  if (intent === 'toggle') {
    const next = new Set(previousSelectedIds)
    if (next.has(targetId)) {
      next.delete(targetId)
    } else {
      next.add(targetId)
    }
    return { selectedIds: next, anchorId: targetId }
  }

  const anchorId = previousAnchorId
  if (!anchorId) {
    return { selectedIds: new Set([targetId]), anchorId: targetId }
  }
  const targetIndex = visibleIds.indexOf(targetId)
  const anchorIndex = visibleIds.indexOf(anchorId)
  if (targetIndex === -1 || anchorIndex === -1) {
    return { selectedIds: new Set([targetId]), anchorId: targetId }
  }

  const start = Math.min(anchorIndex, targetIndex)
  const end = Math.max(anchorIndex, targetIndex)
  return {
    selectedIds: new Set(visibleIds.slice(start, end + 1)),
    anchorId
  }
}

export function pruneWorktreeSelection(
  selectedIds: ReadonlySet<string>,
  anchorId: string | null,
  visibleIds: readonly string[]
): { selectedIds: Set<string>; anchorId: string | null } {
  const visible = new Set(visibleIds)
  const next = new Set<string>()
  for (const id of selectedIds) {
    if (visible.has(id)) {
      next.add(id)
    }
  }
  return {
    selectedIds: next,
    anchorId: anchorId && visible.has(anchorId) ? anchorId : (next.values().next().value ?? null)
  }
}

export function areWorktreeSelectionsEqual(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>
): boolean {
  if (a.size !== b.size) {
    return false
  }
  for (const id of a) {
    if (!b.has(id)) {
      return false
    }
  }
  return true
}

// Why (M2): selection ids are opaque strings inside the multi-selection model.
// WorkspaceGroup ids are already namespaced with a `group:<uuid>` prefix
// (see WorkspaceGroup.id in shared/types.ts), so we reuse that token directly
// here — selection-id == group-id. A separate prefix would mean two parallel
// id schemes and double the parsing in consumers.
const GROUP_SELECTION_PREFIX = 'group:'

export function groupSelectionId(groupId: string): string {
  return groupId
}

export function isGroupSelectionId(id: string): boolean {
  return id.startsWith(GROUP_SELECTION_PREFIX)
}

export function parseGroupSelectionId(id: string): string | null {
  return isGroupSelectionId(id) ? id : null
}

export type SelectionPartition = {
  groupIds: Set<string>
  worktreeIds: Set<string>
}

/**
 * Partition a mixed-id selection into group ids (`group:<uuid>`) and
 * worktree ids (everything else). Batch-action callers (archive, etc.) use
 * this to dispatch the right action per partition without having to inspect
 * each id at the call site.
 */
export function partitionSelectionIds(ids: ReadonlySet<string>): SelectionPartition {
  const groupIds = new Set<string>()
  const worktreeIds = new Set<string>()
  for (const id of ids) {
    if (isGroupSelectionId(id)) {
      groupIds.add(id)
    } else {
      worktreeIds.add(id)
    }
  }
  return { groupIds, worktreeIds }
}
