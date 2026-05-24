import { describe, expect, it } from 'vitest'
import {
  getWorktreeSelectionIntent,
  groupSelectionId,
  isGroupSelectionId,
  parseGroupSelectionId,
  partitionSelectionIds,
  pruneWorktreeSelection,
  updateWorktreeSelection
} from './worktree-multi-selection'

const visibleIds = ['wt-1', 'wt-2', 'wt-3', 'wt-4']

describe('worktree multi selection', () => {
  it('uses Cmd on Mac and Ctrl elsewhere for toggle selection', () => {
    expect(
      getWorktreeSelectionIntent({ metaKey: true, ctrlKey: false, shiftKey: false }, true)
    ).toBe('toggle')
    expect(
      getWorktreeSelectionIntent({ metaKey: false, ctrlKey: true, shiftKey: false }, false)
    ).toBe('toggle')
    expect(
      getWorktreeSelectionIntent({ metaKey: false, ctrlKey: false, shiftKey: true }, false)
    ).toBe('range')
  })

  it('replaces selection on plain click', () => {
    const result = updateWorktreeSelection({
      visibleIds,
      previousSelectedIds: new Set(['wt-1', 'wt-2']),
      previousAnchorId: 'wt-1',
      targetId: 'wt-3',
      intent: 'replace'
    })

    expect([...result.selectedIds]).toEqual(['wt-3'])
    expect(result.anchorId).toBe('wt-3')
  })

  it('toggles one worktree without dropping the rest', () => {
    const result = updateWorktreeSelection({
      visibleIds,
      previousSelectedIds: new Set(['wt-1', 'wt-2']),
      previousAnchorId: 'wt-2',
      targetId: 'wt-3',
      intent: 'toggle'
    })

    expect([...result.selectedIds]).toEqual(['wt-1', 'wt-2', 'wt-3'])
    expect(result.anchorId).toBe('wt-3')
  })

  it('allows toggling the last selected worktree off', () => {
    const result = updateWorktreeSelection({
      visibleIds,
      previousSelectedIds: new Set(['wt-2']),
      previousAnchorId: 'wt-2',
      targetId: 'wt-2',
      intent: 'toggle'
    })

    expect([...result.selectedIds]).toEqual([])
    expect(result.anchorId).toBe('wt-2')
  })

  it('selects the visible range from the anchor to the target', () => {
    const result = updateWorktreeSelection({
      visibleIds,
      previousSelectedIds: new Set(['wt-1']),
      previousAnchorId: 'wt-1',
      targetId: 'wt-3',
      intent: 'range'
    })

    expect([...result.selectedIds]).toEqual(['wt-1', 'wt-2', 'wt-3'])
    expect(result.anchorId).toBe('wt-1')
  })

  it('prunes selection when filtering hides selected worktrees', () => {
    const result = pruneWorktreeSelection(new Set(['wt-1', 'wt-3']), 'wt-1', ['wt-2', 'wt-3'])

    expect([...result.selectedIds]).toEqual(['wt-3'])
    expect(result.anchorId).toBe('wt-3')
  })
})

// Why (M2): group selection ids live in the same multi-selection set as
// worktree ids. The 'group:' prefix already namespaces persisted group ids
// (see WorkspaceGroup.id in shared/types.ts), so we re-use that token here
// for the selection-id form to avoid a parallel id scheme.
describe('group selection ids', () => {
  it('mints a group selection id from a group uuid', () => {
    expect(groupSelectionId('group:abc-123')).toBe('group:abc-123')
  })

  it('detects group selection ids by prefix', () => {
    expect(isGroupSelectionId('group:abc')).toBe(true)
    expect(isGroupSelectionId('repoA::/wt')).toBe(false)
  })

  it('parses the group uuid back out of a group selection id', () => {
    expect(parseGroupSelectionId('group:abc-123')).toBe('group:abc-123')
    expect(parseGroupSelectionId('repoA::/wt')).toBeNull()
  })

  it('partitionSelectionIds splits mixed ids into group ids and worktree ids', () => {
    const partition = partitionSelectionIds(
      new Set(['group:abc', 'repoA::/wt1', 'group:def', 'repoB::/wt2'])
    )
    expect([...partition.groupIds].sort()).toEqual(['group:abc', 'group:def'])
    expect([...partition.worktreeIds].sort()).toEqual(['repoA::/wt1', 'repoB::/wt2'])
  })

  it('partitionSelectionIds returns empty sets for an empty input', () => {
    const partition = partitionSelectionIds(new Set<string>())
    expect(partition.groupIds.size).toBe(0)
    expect(partition.worktreeIds.size).toBe(0)
  })
})

// Why (M2): toggling a group is the same set operation as toggling a worktree
// because the underlying Set<string> doesn't care what the id means. These
// specs pin that contract: a group id and a worktree id can coexist in the
// selection, and the existing intent logic carries over unchanged.
describe('worktree multi selection with groups', () => {
  it('toggle adds a group selection id alongside existing worktree selections', () => {
    const visibleIds = ['group:abc', 'wt-1', 'wt-2']
    const result = updateWorktreeSelection({
      visibleIds,
      previousSelectedIds: new Set(['wt-1']),
      previousAnchorId: 'wt-1',
      targetId: 'group:abc',
      intent: 'toggle'
    })

    expect([...result.selectedIds].sort()).toEqual(['group:abc', 'wt-1'])
    expect(result.anchorId).toBe('group:abc')
  })

  it('replace on a group id selects ONLY the group', () => {
    const visibleIds = ['group:abc', 'wt-1', 'wt-2']
    const result = updateWorktreeSelection({
      visibleIds,
      previousSelectedIds: new Set(['wt-1', 'wt-2']),
      previousAnchorId: 'wt-1',
      targetId: 'group:abc',
      intent: 'replace'
    })

    expect([...result.selectedIds]).toEqual(['group:abc'])
    expect(result.anchorId).toBe('group:abc')
  })
})
