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
}

export type AggregatedTabBarOutput = {
  /**
   * Tabs from sibling members whose canonical position in the group precedes
   * the active member. These render before the active member's local tabs in
   * the strip.
   */
  beforeLocal: AggregatedTabBarSlice
  /**
   * Tabs from sibling members whose canonical position follows the active
   * member. These render after the active member's local tabs.
   */
  afterLocal: AggregatedTabBarSlice
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
   *  cross-member slices on top. */
  activeMemberWorktreeId: string
  /**
   * Full ordered list of group member worktree ids INCLUDING the active
   * member's own id, in the group's declared order. Determines the canonical
   * sibling-tab positions: siblings before the active member emit into
   * beforeLocal, those after emit into afterLocal. Without this stable
   * ordering the strip would visually reshuffle whenever the active member
   * switched (the just-clicked sibling tab would jump position).
   */
  memberWorktreeIdsInOrder: readonly string[]
  unifiedTabsByWorktree: Record<string, Tab[]>
  groupsByWorktree: Record<string, TabGroup[]>
  tabsByWorktree: Record<string, TerminalTab[]>
  openFiles: readonly OpenFile[]
  browserTabsByWorktree: Record<string, BrowserTabState[]>
}

function emptySlice(): AggregatedTabBarSlice {
  return { terminalTabs: [], editorItems: [], browserItems: [], tabBarOrder: [] }
}

function appendOwnerTabs(
  ownerId: string,
  bucket: AggregatedTabBarSlice,
  ownerByVisibleId: Map<string, string>,
  input: Pick<
    AggregateGroupTabBarInput,
    | 'unifiedTabsByWorktree'
    | 'groupsByWorktree'
    | 'tabsByWorktree'
    | 'openFiles'
    | 'browserTabsByWorktree'
  >
): void {
  const unifiedTabs = input.unifiedTabsByWorktree[ownerId]
  const groups = input.groupsByWorktree[ownerId]
  if (!unifiedTabs || !groups || groups.length === 0) {
    return
  }
  // Why: build owner-keyed lookup tables once per worktree so the per-tab
  // walk stays O(tabs) instead of O(tabs * worktrees). The maps live for the
  // duration of this call only — no caching to worry about.
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
        bucket.terminalTabs.push({
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
        bucket.tabBarOrder.push(live.id)
        ownerByVisibleId.set(live.id, ownerId)
      } else if (tab.contentType === 'browser') {
        const live = browsersById.get(tab.entityId)
        if (!live) {
          continue
        }
        bucket.browserItems.push({ ...live, tabId: tab.id })
        bucket.tabBarOrder.push(live.id)
        ownerByVisibleId.set(live.id, ownerId)
      } else {
        // editor / diff / conflict-review
        const file = editorsById.get(tab.entityId)
        if (!file) {
          continue
        }
        bucket.editorItems.push({ ...file, tabId: tab.id })
        bucket.tabBarOrder.push(tab.id)
        ownerByVisibleId.set(tab.id, ownerId)
      }
    }
  }
}

/**
 * Build the sibling-member slices of a group's tab strip, split into the
 * portions that render before and after the active member's own tabs.
 *
 * Why split rather than emit one flat list: the active member's tabs must
 * appear at the member's canonical position in the group, not always at the
 * front. Walking members in declared order and switching buckets when we hit
 * the active member's slot keeps the strip's visual order stable as the user
 * activates different members — clicking a sibling tab still leaves that tab
 * in the same on-screen column after the active worktree changes.
 */
export function aggregateGroupTabBar(input: AggregateGroupTabBarInput): AggregatedTabBarOutput {
  const beforeLocal = emptySlice()
  const afterLocal = emptySlice()
  const ownerByVisibleId = new Map<string, string>()

  if (input.memberWorktreeIdsInOrder.length === 0) {
    return { beforeLocal, afterLocal, ownerByVisibleId }
  }

  let bucket = beforeLocal
  let sawActive = false
  for (const ownerId of input.memberWorktreeIdsInOrder) {
    if (ownerId === input.activeMemberWorktreeId) {
      bucket = afterLocal
      sawActive = true
      continue
    }
    appendOwnerTabs(ownerId, bucket, ownerByVisibleId, input)
  }
  if (!sawActive) {
    // Why: active member isn't in the declared order — should not happen under
    // normal grouping, but if it does (e.g., transient mid-rename) we surface
    // every sibling as "afterLocal" so the user still sees their tabs.
    return { beforeLocal: emptySlice(), afterLocal: bucket, ownerByVisibleId }
  }

  return { beforeLocal, afterLocal, ownerByVisibleId }
}
