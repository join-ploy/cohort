import { describe, it, expect } from 'vitest'
import type {
  BrowserTab as BrowserTabState,
  Tab,
  TabGroup,
  TerminalTab,
  Worktree
} from '../../../../shared/types'
import type { OpenFile } from '../../store/slices/editor'
import {
  aggregateGroupTabBar,
  type AggregateGroupTabBarInput,
  type AggregatedTabBarOutput
} from './aggregate-group-tab-bar'

// Why: focused fixture helpers keep each test compact so the aggregation
// contract — "before-local / after-local buckets split at the active member's
// canonical slot, owner-tagged" — is visible in the test bodies rather than
// in fixture noise.

function makeWorktree(id: string, repoId: string): Worktree {
  return {
    id,
    repoId,
    displayName: id,
    workspaceName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    archivedAt: null,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    path: `/r/${repoId}/${id}`,
    head: 'deadbeef',
    branch: `b-${id}`,
    isBare: false,
    isMainWorktree: false
  }
}

function makeTerminal(
  id: string,
  worktreeId: string,
  title = `Term-${id}`,
  sortOrder = 0
): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title,
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: 0
  }
}

function makeUnifiedTab(
  partial: Partial<Tab> & { id: string; entityId: string; groupId: string; worktreeId: string }
): Tab {
  return {
    contentType: 'terminal',
    label: 'tab',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...partial
  }
}

function makeGroup(partial: Partial<TabGroup> & { id: string; worktreeId: string }): TabGroup {
  return {
    activeTabId: null,
    tabOrder: [],
    ...partial
  }
}

function makeOpenFile(id: string, worktreeId: string, relativePath = 'file.ts'): OpenFile {
  return {
    id,
    filePath: `/abs/${relativePath}`,
    relativePath,
    worktreeId,
    language: 'typescript',
    isDirty: false,
    mode: 'edit'
  }
}

function makeBrowser(id: string, worktreeId: string, title = `Browser ${id}`): BrowserTabState {
  return {
    id,
    worktreeId,
    url: 'about:blank',
    title,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0
  }
}

function emptyInput(): AggregateGroupTabBarInput {
  return {
    activeMemberWorktreeId: 'wt-a',
    memberWorktreeIdsInOrder: [],
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    tabsByWorktree: {},
    openFiles: [],
    browserTabsByWorktree: {}
  }
}

describe('aggregateGroupTabBar', () => {
  it('returns empty buckets when there are no members', () => {
    const result = aggregateGroupTabBar(emptyInput())
    expect(result).toEqual<AggregatedTabBarOutput>({
      beforeLocal: { terminalTabs: [], editorItems: [], browserItems: [], tabBarOrder: [] },
      afterLocal: { terminalTabs: [], editorItems: [], browserItems: [], tabBarOrder: [] },
      ownerByVisibleId: new Map()
    })
  })

  it('emits a sibling that precedes the active member into beforeLocal', () => {
    const wtA = makeWorktree('wt-a', 'repoA')
    const wtB = makeWorktree('wt-b', 'repoB')
    void wtA
    const groupB = makeGroup({ id: 'gB', worktreeId: wtB.id, tabOrder: ['utabB1', 'utabB2'] })
    const unifiedB: Tab[] = [
      makeUnifiedTab({
        id: 'utabB1',
        entityId: 'termB1',
        groupId: 'gB',
        worktreeId: wtB.id,
        contentType: 'terminal',
        label: 'TermB1'
      }),
      makeUnifiedTab({
        id: 'utabB2',
        entityId: 'termB2',
        groupId: 'gB',
        worktreeId: wtB.id,
        contentType: 'terminal',
        label: 'TermB2'
      })
    ]
    const terminalsB: TerminalTab[] = [
      makeTerminal('termB1', wtB.id, 'Live B1'),
      makeTerminal('termB2', wtB.id, 'Live B2')
    ]

    const result = aggregateGroupTabBar({
      activeMemberWorktreeId: wtA.id,
      // B precedes A in declared member order → B's tabs should appear in beforeLocal.
      memberWorktreeIdsInOrder: [wtB.id, wtA.id],
      unifiedTabsByWorktree: { [wtB.id]: unifiedB },
      groupsByWorktree: { [wtB.id]: [groupB] },
      tabsByWorktree: { [wtB.id]: terminalsB },
      openFiles: [],
      browserTabsByWorktree: {}
    })

    expect(result.beforeLocal.terminalTabs.map((t) => t.id)).toEqual(['termB1', 'termB2'])
    expect(result.beforeLocal.terminalTabs.map((t) => t.unifiedTabId)).toEqual(['utabB1', 'utabB2'])
    expect(result.afterLocal.terminalTabs).toEqual([])
    expect(result.beforeLocal.tabBarOrder).toEqual(['termB1', 'termB2'])
    expect(result.afterLocal.tabBarOrder).toEqual([])
    // Why: each visible terminal id must resolve to its sibling owner so the
    // click handler can swap activeWorktreeId before activating.
    expect(result.ownerByVisibleId.get('termB1')).toBe(wtB.id)
    expect(result.ownerByVisibleId.get('termB2')).toBe(wtB.id)
  })

  it('splits siblings around the active member at its canonical slot', () => {
    // Members in declared order: [B, A, C]. Active = A.
    // → B's tabs go in beforeLocal, C's go in afterLocal.
    const groupB = makeGroup({ id: 'gB', worktreeId: 'wt-b', tabOrder: ['uB1'] })
    const groupC = makeGroup({ id: 'gC', worktreeId: 'wt-c', tabOrder: ['uC1'] })
    const unifiedB = [
      makeUnifiedTab({
        id: 'uB1',
        entityId: 'termB',
        groupId: 'gB',
        worktreeId: 'wt-b',
        contentType: 'terminal',
        label: 'B'
      })
    ]
    const unifiedC = [
      makeUnifiedTab({
        id: 'uC1',
        entityId: 'termC',
        groupId: 'gC',
        worktreeId: 'wt-c',
        contentType: 'terminal',
        label: 'C'
      })
    ]
    const result = aggregateGroupTabBar({
      activeMemberWorktreeId: 'wt-a',
      memberWorktreeIdsInOrder: ['wt-b', 'wt-a', 'wt-c'],
      unifiedTabsByWorktree: { 'wt-b': unifiedB, 'wt-c': unifiedC },
      groupsByWorktree: { 'wt-b': [groupB], 'wt-c': [groupC] },
      tabsByWorktree: {
        'wt-b': [makeTerminal('termB', 'wt-b')],
        'wt-c': [makeTerminal('termC', 'wt-c')]
      },
      openFiles: [],
      browserTabsByWorktree: {}
    })

    expect(result.beforeLocal.tabBarOrder).toEqual(['termB'])
    expect(result.afterLocal.tabBarOrder).toEqual(['termC'])
  })

  it('keeps the position stable as the active member changes', () => {
    // Why: this is the core regression — when active = A, B-tabs render in
    // afterLocal; when active = B, A-tabs render in beforeLocal. In both cases
    // the visible strip order [A's tabs, B's tabs] stays the same in the
    // composed view (after splicing local at the active member's slot).
    const wtA = 'wt-a'
    const wtB = 'wt-b'
    const groupA = makeGroup({ id: 'gA', worktreeId: wtA, tabOrder: ['uA'] })
    const groupB = makeGroup({ id: 'gB', worktreeId: wtB, tabOrder: ['uB'] })
    const unifiedA = [
      makeUnifiedTab({
        id: 'uA',
        entityId: 'tA',
        groupId: 'gA',
        worktreeId: wtA,
        contentType: 'terminal',
        label: 'A'
      })
    ]
    const unifiedB = [
      makeUnifiedTab({
        id: 'uB',
        entityId: 'tB',
        groupId: 'gB',
        worktreeId: wtB,
        contentType: 'terminal',
        label: 'B'
      })
    ]
    const baseInput: Omit<AggregateGroupTabBarInput, 'activeMemberWorktreeId'> = {
      memberWorktreeIdsInOrder: [wtA, wtB],
      unifiedTabsByWorktree: { [wtA]: unifiedA, [wtB]: unifiedB },
      groupsByWorktree: { [wtA]: [groupA], [wtB]: [groupB] },
      tabsByWorktree: {
        [wtA]: [makeTerminal('tA', wtA)],
        [wtB]: [makeTerminal('tB', wtB)]
      },
      openFiles: [],
      browserTabsByWorktree: {}
    }

    const activeA = aggregateGroupTabBar({ ...baseInput, activeMemberWorktreeId: wtA })
    expect(activeA.beforeLocal.tabBarOrder).toEqual([])
    expect(activeA.afterLocal.tabBarOrder).toEqual(['tB'])
    // Visible strip when A is active = [local tA] + afterLocal = [tA, tB].

    const activeB = aggregateGroupTabBar({ ...baseInput, activeMemberWorktreeId: wtB })
    expect(activeB.beforeLocal.tabBarOrder).toEqual(['tA'])
    expect(activeB.afterLocal.tabBarOrder).toEqual([])
    // Visible strip when B is active = beforeLocal + [local tB] = [tA, tB] — identical position.
  })

  it('includes editor and browser tabs in the order their unified tab id appears', () => {
    const groupB = makeGroup({
      id: 'gB',
      worktreeId: 'wt-b',
      tabOrder: ['uTermB', 'uEditB', 'uBrowB']
    })
    const unifiedB: Tab[] = [
      makeUnifiedTab({
        id: 'uTermB',
        entityId: 'termB',
        groupId: 'gB',
        worktreeId: 'wt-b',
        contentType: 'terminal',
        label: 'TB'
      }),
      makeUnifiedTab({
        id: 'uEditB',
        entityId: 'fileB',
        groupId: 'gB',
        worktreeId: 'wt-b',
        contentType: 'editor',
        label: 'FB'
      }),
      makeUnifiedTab({
        id: 'uBrowB',
        entityId: 'browB',
        groupId: 'gB',
        worktreeId: 'wt-b',
        contentType: 'browser',
        label: 'BB'
      })
    ]
    const result = aggregateGroupTabBar({
      activeMemberWorktreeId: 'wt-a',
      memberWorktreeIdsInOrder: ['wt-a', 'wt-b'],
      unifiedTabsByWorktree: { 'wt-b': unifiedB },
      groupsByWorktree: { 'wt-b': [groupB] },
      tabsByWorktree: { 'wt-b': [makeTerminal('termB', 'wt-b')] },
      openFiles: [makeOpenFile('fileB', 'wt-b', 'sib.ts')],
      browserTabsByWorktree: { 'wt-b': [makeBrowser('browB', 'wt-b')] }
    })

    expect(result.afterLocal.terminalTabs.map((t) => t.id)).toEqual(['termB'])
    expect(result.afterLocal.editorItems.map((f) => f.id)).toEqual(['fileB'])
    expect(result.afterLocal.browserItems.map((b) => b.id)).toEqual(['browB'])
    // Visible-id contract: editors use unifiedTabId, terminals/browsers use entityId.
    expect(result.afterLocal.tabBarOrder).toEqual(['termB', 'uEditB', 'browB'])
    expect(result.ownerByVisibleId.get('termB')).toBe('wt-b')
    expect(result.ownerByVisibleId.get('uEditB')).toBe('wt-b')
    expect(result.ownerByVisibleId.get('browB')).toBe('wt-b')
  })

  it('skips orphan unified tabs whose backing entity is missing (mirrors visible-worktrees archived filter contract)', () => {
    const groupB = makeGroup({
      id: 'gB',
      worktreeId: 'wt-b',
      tabOrder: ['uOrphan', 'uReal']
    })
    const unifiedB: Tab[] = [
      makeUnifiedTab({
        id: 'uOrphan',
        entityId: 'termGone',
        groupId: 'gB',
        worktreeId: 'wt-b',
        contentType: 'terminal',
        label: 'Gone'
      }),
      makeUnifiedTab({
        id: 'uReal',
        entityId: 'termReal',
        groupId: 'gB',
        worktreeId: 'wt-b',
        contentType: 'terminal',
        label: 'Real'
      })
    ]
    const result = aggregateGroupTabBar({
      activeMemberWorktreeId: 'wt-a',
      memberWorktreeIdsInOrder: ['wt-a', 'wt-b'],
      unifiedTabsByWorktree: { 'wt-b': unifiedB },
      groupsByWorktree: { 'wt-b': [groupB] },
      // termGone has no live TerminalTab record — it should be dropped.
      tabsByWorktree: { 'wt-b': [makeTerminal('termReal', 'wt-b')] },
      openFiles: [],
      browserTabsByWorktree: {}
    })
    expect(result.afterLocal.tabBarOrder).toEqual(['termReal'])
  })

  it('drops sibling members not present in unifiedTabsByWorktree without throwing', () => {
    const result = aggregateGroupTabBar({
      activeMemberWorktreeId: 'wt-a',
      memberWorktreeIdsInOrder: ['wt-a', 'wt-b'],
      unifiedTabsByWorktree: {},
      groupsByWorktree: {},
      tabsByWorktree: {},
      openFiles: [],
      browserTabsByWorktree: {}
    })
    expect(result.beforeLocal.tabBarOrder).toEqual([])
    expect(result.afterLocal.tabBarOrder).toEqual([])
  })

  it('iterates every group of a sibling member (not just the focused one)', () => {
    // Why: sibling members may have split panes too; the spec is "tabs across
    // every member" — picking only one group of a sibling would hide tabs the
    // user created in their other split. Both sibling groups’ tabOrder are
    // concatenated in groupsByWorktree order.
    const g1 = makeGroup({ id: 'g1', worktreeId: 'wt-b', tabOrder: ['u1'] })
    const g2 = makeGroup({ id: 'g2', worktreeId: 'wt-b', tabOrder: ['u2'] })
    const unifiedB: Tab[] = [
      makeUnifiedTab({
        id: 'u1',
        entityId: 't1',
        groupId: 'g1',
        worktreeId: 'wt-b',
        contentType: 'terminal',
        label: 'T1'
      }),
      makeUnifiedTab({
        id: 'u2',
        entityId: 't2',
        groupId: 'g2',
        worktreeId: 'wt-b',
        contentType: 'terminal',
        label: 'T2'
      })
    ]
    const result = aggregateGroupTabBar({
      activeMemberWorktreeId: 'wt-a',
      memberWorktreeIdsInOrder: ['wt-a', 'wt-b'],
      unifiedTabsByWorktree: { 'wt-b': unifiedB },
      groupsByWorktree: { 'wt-b': [g1, g2] },
      tabsByWorktree: { 'wt-b': [makeTerminal('t1', 'wt-b'), makeTerminal('t2', 'wt-b')] },
      openFiles: [],
      browserTabsByWorktree: {}
    })
    expect(result.afterLocal.tabBarOrder).toEqual(['t1', 't2'])
  })
})
