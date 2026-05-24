import type {
  BrowserTab as BrowserTabState,
  Tab,
  TabGroup,
  TerminalTab
} from '../../../../shared/types'
import type { OpenFile } from '../../store/slices/editor'

/**
 * Per-terminal tab item shape consumed by TabBar (mirrors the TerminalTabItem
 * type in useTabGroupWorkspaceModel). Kept here to avoid a cross-import that
 * would pull the hook into this pure module.
 */
export type AggregatedTerminalTabItem = {
  id: string
  unifiedTabId: string
  ptyId: string | null
  worktreeId: string
  title: string
  customTitle: string | null
  color: string | null
  sortOrder: number
  createdAt: number
}

export type AggregatedEditorItem = OpenFile & { tabId: string }
export type AggregatedBrowserItem = BrowserTabState & { tabId: string }

export type AggregatedTabBarSlice = {
  terminalTabs: AggregatedTerminalTabItem[]
  editorItems: AggregatedEditorItem[]
  browserItems: AggregatedBrowserItem[]
  tabBarOrder: string[]
  /**
   * Maps a visible tab id (entityId for terminals/browsers, unifiedTabId for
   * editors — same contract as TabBar.tsx) to the worktree that owns the tab.
   * Consumed by click handlers so a sibling-member tab activation can swap
   * activeWorktreeId before invoking the tab-type-specific activator.
   */
  ownerByVisibleId: Map<string, string>
}

export type AggregateGroupTabBarInput = {
  /** Anchor worktree whose strip we're aggregating into. The aggregator does
   *  NOT include the active member's own tabs — useTabGroupWorkspaceModel
   *  already builds those from the focused group; this function only adds the
   *  cross-member slice on top. */
  activeMemberWorktreeId: string
  /** Sibling worktree IDs in the order group members were declared. The
   *  resulting tabBarOrder follows this order. */
  siblingWorktreeIds: readonly string[]
  unifiedTabsByWorktree: Record<string, Tab[]>
  groupsByWorktree: Record<string, TabGroup[]>
  tabsByWorktree: Record<string, TerminalTab[]>
  openFiles: readonly OpenFile[]
  browserTabsByWorktree: Record<string, BrowserTabState[]>
}

/**
 * Build the sibling-member slice of a group's tab strip.
 *
 * Why pure / outside the hook: this can be unit-tested without React
 * machinery, and the orderings (sibling order, per-sibling tab order,
 * editor-vs-terminal vs browser entity id) are subtle enough that the test
 * surface is worth keeping flat. The hook composes the result with its own
 * focused-group output via simple array concat.
 */
export function aggregateGroupTabBar(input: AggregateGroupTabBarInput): AggregatedTabBarSlice {
  const terminalTabs: AggregatedTerminalTabItem[] = []
  const editorItems: AggregatedEditorItem[] = []
  const browserItems: AggregatedBrowserItem[] = []
  const tabBarOrder: string[] = []
  const ownerByVisibleId = new Map<string, string>()

  if (input.siblingWorktreeIds.length === 0) {
    return { terminalTabs, editorItems, browserItems, tabBarOrder, ownerByVisibleId }
  }

  // Why: build owner-keyed lookup tables once per worktree so the per-tab
  // walk stays O(tabs) instead of O(tabs * worktrees). The maps live for the
  // duration of this function only — no caching to worry about.
  for (const ownerId of input.siblingWorktreeIds) {
    if (ownerId === input.activeMemberWorktreeId) {
      // Why: defensive — never re-aggregate the active member’s own tabs.
      continue
    }
    const unifiedTabs = input.unifiedTabsByWorktree[ownerId]
    const groups = input.groupsByWorktree[ownerId]
    if (!unifiedTabs || !groups || groups.length === 0) {
      continue
    }
    const tabsById = new Map<string, Tab>(unifiedTabs.map((t) => [t.id, t]))
    const terminalsById = new Map<string, TerminalTab>(
      (input.tabsByWorktree[ownerId] ?? []).map((t) => [t.id, t])
    )
    const editorsById = new Map<string, OpenFile>(
      input.openFiles.filter((f) => f.worktreeId === ownerId).map((f) => [f.id, f])
    )
    const browsersById = new Map<string, BrowserTabState>(
      (input.browserTabsByWorktree[ownerId] ?? []).map((b) => [b.id, b])
    )

    for (const group of groups) {
      for (const unifiedId of group.tabOrder) {
        const tab = tabsById.get(unifiedId)
        if (!tab) {
          continue
        }
        if (tab.contentType === 'terminal') {
          const live = terminalsById.get(tab.entityId)
          if (!live) {
            // Why: drop orphan unified tabs whose backing TerminalTab record
            // has been removed (mid-shutdown, hydration race). The strip
            // would otherwise render a phantom tab the user cannot interact
            // with — same guard the per-group reconciler uses.
            continue
          }
          terminalTabs.push({
            id: live.id,
            unifiedTabId: tab.id,
            ptyId: null,
            worktreeId: ownerId,
            title: tab.label,
            customTitle: tab.customLabel ?? null,
            color: tab.color ?? null,
            sortOrder: tab.sortOrder,
            createdAt: tab.createdAt
          })
          tabBarOrder.push(live.id)
          ownerByVisibleId.set(live.id, ownerId)
        } else if (tab.contentType === 'browser') {
          const live = browsersById.get(tab.entityId)
          if (!live) {
            continue
          }
          browserItems.push({ ...live, tabId: tab.id })
          tabBarOrder.push(live.id)
          ownerByVisibleId.set(live.id, ownerId)
        } else {
          // editor / diff / conflict-review
          const file = editorsById.get(tab.entityId)
          if (!file) {
            continue
          }
          editorItems.push({ ...file, tabId: tab.id })
          tabBarOrder.push(tab.id)
          ownerByVisibleId.set(tab.id, ownerId)
        }
      }
    }
  }

  return { terminalTabs, editorItems, browserItems, tabBarOrder, ownerByVisibleId }
}
