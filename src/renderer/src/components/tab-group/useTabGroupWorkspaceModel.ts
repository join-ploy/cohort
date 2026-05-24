import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import type { OpenFile } from '@/store/slices/editor'
import type { BrowserTab as BrowserTabState, Tab, TabGroup } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { getSiblingWorktreeIdsForGroupMember, useAllWorktrees } from '../../store/selectors'
import { createUntitledMarkdownFile } from '../../lib/create-untitled-markdown'
import { getConnectionId } from '../../lib/connection-context'
import { extractIpcErrorMessage } from '../../lib/ipc-error'
import { destroyWorkspaceWebviews } from '../../store/slices/browser-webview-cleanup'
import { requestEditorFileClose } from '../editor/editor-autosave'
import { focusTerminalTabSurface } from '../../lib/focus-terminal-tab-surface'
import { aggregateGroupTabBar } from '../tab-bar/aggregate-group-tab-bar'

export type GroupEditorItem = OpenFile & { tabId: string }
export type GroupBrowserItem = BrowserTabState & { tabId: string }

const EMPTY_GROUPS: readonly TabGroup[] = []
const EMPTY_UNIFIED_TABS: readonly Tab[] = []
const EMPTY_BROWSER_TABS: readonly BrowserTabState[] = []
const EMPTY_IDS: readonly string[] = []
const EMPTY_OPEN_FILES: readonly OpenFile[] = []
// Why: snapshot returned when aggregateGroupMemberTabs is off so the
// useShallow selector’s no-aggregation path keeps a stable reference and
// useMemo downstream doesn't rebuild on every store write.
const EMPTY_SIBLING_STATE = {
  unifiedTabsByWorktree: {} as Record<string, Tab[]>,
  groupsByWorktree: {} as Record<string, TabGroup[]>,
  tabsByWorktree: {} as Record<string, never[]>,
  browserTabsByWorktree: {} as Record<string, BrowserTabState[]>,
  openFiles: EMPTY_OPEN_FILES
}

type TerminalTabItem = {
  id: string
  unifiedTabId: string
  ptyId: null
  worktreeId: string
  title: string
  customTitle: string | null
  color: string | null
  sortOrder: number
  createdAt: number
}

export function useTabGroupWorkspaceModel({
  groupId,
  worktreeId,
  aggregateGroupMemberTabs = false
}: {
  groupId: string
  worktreeId: string
  /**
   * When true, the tab strip surfaces tabs from every sibling worktree that
   * shares a WorkspaceGroup with `worktreeId`, in addition to this group's
   * own tabs. Owned by the focused TabGroupPanel only — sibling-member tabs
   * appear in exactly one strip across all split panes to avoid duplicates.
   */
  aggregateGroupMemberTabs?: boolean
}) {
  const allWorktrees = useAllWorktrees()
  const worktreeState = useAppStore(
    useShallow((state) => ({
      // Why: Zustand v5 expects selector snapshots to be referentially stable
      // when the underlying store state has not changed. Allocating fresh
      // fallback arrays here (`?? []`) makes React think every snapshot is
      // new, which traps the split-group render path in an infinite update loop
      // and blanks the window as soon as TabGroupPanel mounts.
      groups: state.groupsByWorktree[worktreeId] ?? EMPTY_GROUPS,
      unifiedTabs: state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_UNIFIED_TABS,
      openFiles: state.openFiles,
      browserTabs: state.browserTabsByWorktree[worktreeId] ?? EMPTY_BROWSER_TABS,
      expandedPaneByTabId: state.expandedPaneByTabId
    }))
  )

  const focusGroup = useAppStore((state) => state.focusGroup)
  const activateTab = useAppStore((state) => state.activateTab)
  const closeUnifiedTab = useAppStore((state) => state.closeUnifiedTab)
  const closeEmptyGroup = useAppStore((state) => state.closeEmptyGroup)
  const createTab = useAppStore((state) => state.createTab)
  const closeTab = useAppStore((state) => state.closeTab)
  const setActiveTab = useAppStore((state) => state.setActiveTab)
  const setActiveFile = useAppStore((state) => state.setActiveFile)
  const setActiveTabType = useAppStore((state) => state.setActiveTabType)
  const createBrowserTab = useAppStore((state) => state.createBrowserTab)
  const closeFile = useAppStore((state) => state.closeFile)
  const pinFile = useAppStore((state) => state.pinFile)
  const closeBrowserTab = useAppStore((state) => state.closeBrowserTab)
  const setActiveBrowserTab = useAppStore((state) => state.setActiveBrowserTab)
  const setActiveWorktree = useAppStore((state) => state.setActiveWorktree)
  const dropUnifiedTab = useAppStore((state) => state.dropUnifiedTab)
  const createEmptySplitGroup = useAppStore((state) => state.createEmptySplitGroup)
  const setTabCustomTitle = useAppStore((state) => state.setTabCustomTitle)
  const setTabColor = useAppStore((state) => state.setTabColor)
  const openFile = useAppStore((state) => state.openFile)

  const group = useMemo(
    () => worktreeState.groups.find((item) => item.id === groupId) ?? null,
    [groupId, worktreeState.groups]
  )
  const worktree = useMemo(
    () => allWorktrees.find((candidate) => candidate.id === worktreeId) ?? null,
    [allWorktrees, worktreeId]
  )
  const groupTabs = useMemo(
    () => worktreeState.unifiedTabs.filter((item) => item.groupId === groupId),
    [groupId, worktreeState.unifiedTabs]
  )
  const activeItemId = group?.activeTabId ?? null
  const activeTab = groupTabs.find((item) => item.id === activeItemId) ?? null

  const terminalTabs = useMemo<TerminalTabItem[]>(
    () =>
      groupTabs
        .filter((item) => item.contentType === 'terminal')
        .map((item) => ({
          id: item.entityId,
          unifiedTabId: item.id,
          ptyId: null,
          worktreeId,
          title: item.label,
          customTitle: item.customLabel ?? null,
          color: item.color ?? null,
          sortOrder: item.sortOrder,
          createdAt: item.createdAt
        })),
    [groupTabs, worktreeId]
  )

  const editorItems = useMemo<GroupEditorItem[]>(
    () =>
      groupTabs
        .filter(
          (item) =>
            item.contentType === 'editor' ||
            item.contentType === 'diff' ||
            item.contentType === 'conflict-review'
        )
        .map((item) => {
          const file = worktreeState.openFiles.find((candidate) => candidate.id === item.entityId)
          return file ? { ...file, tabId: item.id } : null
        })
        .filter((item): item is GroupEditorItem => item !== null),
    [groupTabs, worktreeState.openFiles]
  )

  const browserItems = useMemo<GroupBrowserItem[]>(
    () =>
      groupTabs
        .filter((item) => item.contentType === 'browser')
        .map((item) => {
          const bt = worktreeState.browserTabs.find((candidate) => candidate.id === item.entityId)
          return bt ? { ...bt, tabId: item.id } : null
        })
        .filter((item): item is GroupBrowserItem => item !== null),
    [groupTabs, worktreeState.browserTabs]
  )

  // Why: only the focused pane aggregates sibling-member tabs. Splits within
  // the same worktree each render their own TabBar; surfacing sibling tabs in
  // every strip would duplicate them across panes and confuse drag/close.
  // Subscribing to the sibling ids (and slices) only when this flag is true
  // also keeps unrelated panes from re-rendering when a sibling member’s tabs
  // change.
  const siblingWorktreeIds = useAppStore(
    useShallow((state) =>
      aggregateGroupMemberTabs ? getSiblingWorktreeIdsForGroupMember(state, worktreeId) : EMPTY_IDS
    )
  )

  const siblingState = useAppStore(
    useShallow((state) => {
      if (siblingWorktreeIds.length === 0) {
        return EMPTY_SIBLING_STATE
      }
      const unifiedTabsByWorktree: Record<string, Tab[]> = {}
      const groupsByWorktree: Record<string, TabGroup[]> = {}
      const tabsByWorktree: Record<string, (typeof state.tabsByWorktree)[string]> = {}
      const browserTabsByWorktree: Record<string, BrowserTabState[]> = {}
      for (const id of siblingWorktreeIds) {
        const u = state.unifiedTabsByWorktree[id]
        if (u) {
          unifiedTabsByWorktree[id] = u
        }
        const g = state.groupsByWorktree[id]
        if (g) {
          groupsByWorktree[id] = g
        }
        const t = state.tabsByWorktree[id]
        if (t) {
          tabsByWorktree[id] = t
        }
        const b = state.browserTabsByWorktree[id]
        if (b) {
          browserTabsByWorktree[id] = b
        }
      }
      const openFiles = state.openFiles.filter((f) => siblingWorktreeIds.includes(f.worktreeId))
      return {
        unifiedTabsByWorktree,
        groupsByWorktree,
        tabsByWorktree,
        browserTabsByWorktree,
        openFiles
      }
    })
  )

  const aggregatedSiblings = useMemo(
    () =>
      aggregateGroupTabBar({
        activeMemberWorktreeId: worktreeId,
        siblingWorktreeIds,
        unifiedTabsByWorktree: siblingState.unifiedTabsByWorktree,
        groupsByWorktree: siblingState.groupsByWorktree,
        tabsByWorktree: siblingState.tabsByWorktree,
        openFiles: siblingState.openFiles,
        browserTabsByWorktree: siblingState.browserTabsByWorktree
      }),
    [siblingState, siblingWorktreeIds, worktreeId]
  )

  const aggregatedTerminalTabs = useMemo(
    () =>
      aggregatedSiblings.terminalTabs.length > 0
        ? [...terminalTabs, ...aggregatedSiblings.terminalTabs]
        : terminalTabs,
    [aggregatedSiblings.terminalTabs, terminalTabs]
  )
  const aggregatedEditorItems = useMemo(
    () =>
      aggregatedSiblings.editorItems.length > 0
        ? [...editorItems, ...aggregatedSiblings.editorItems]
        : editorItems,
    [aggregatedSiblings.editorItems, editorItems]
  )
  const aggregatedBrowserItems = useMemo(
    () =>
      aggregatedSiblings.browserItems.length > 0
        ? [...browserItems, ...aggregatedSiblings.browserItems]
        : browserItems,
    [aggregatedSiblings.browserItems, browserItems]
  )

  // Why: the click handlers need to find a sibling tab’s unifiedTabId from
  // either a terminal/browser entityId or an editor tabId. Pre-build the
  // lookup once per render so the per-click work is O(1) regardless of how
  // many sibling tabs exist.
  const siblingTabByVisibleId = useMemo(() => {
    const map = new Map<string, { ownerWorktreeId: string; tab: Tab }>()
    for (const siblingId of siblingWorktreeIds) {
      const tabs = siblingState.unifiedTabsByWorktree[siblingId]
      if (!tabs) {
        continue
      }
      for (const t of tabs) {
        const visibleId =
          t.contentType === 'terminal' || t.contentType === 'browser' ? t.entityId : t.id
        map.set(visibleId, { ownerWorktreeId: siblingId, tab: t })
      }
    }
    return map
  }, [siblingState.unifiedTabsByWorktree, siblingWorktreeIds])

  const closeEditorIfUnreferenced = useCallback(
    (entityId: string, closingTabId: string) => {
      const otherReference = (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).some(
        (item) =>
          item.id !== closingTabId &&
          item.entityId === entityId &&
          (item.contentType === 'editor' ||
            item.contentType === 'diff' ||
            item.contentType === 'conflict-review')
      )
      if (!otherReference) {
        const file = useAppStore.getState().openFiles.find((candidate) => candidate.id === entityId)
        if (file?.isDirty) {
          // Why: split-group close actions bypass Terminal.tsx, but the unsaved
          // confirmation + save/discard ordering must stay centralized there so
          // tab close, bulk close, and window quit share one queueing flow.
          requestEditorFileClose(entityId)
          return false
        }
        closeFile(entityId)
      }
      return true
    },
    [closeFile, worktreeId]
  )

  const leaveWorktreeIfEmpty = useCallback(() => {
    const state = useAppStore.getState()
    if (state.activeWorktreeId !== worktreeId) {
      return
    }
    // Why: split-group close actions bypass the legacy Terminal.tsx handlers
    // that used to deselect the worktree when its final visible surface
    // closed. Without the same guard here, the renderer keeps an empty
    // worktree selected and TabGroupPanel has nothing to render, producing a
    // blank workspace instead of Orca's landing screen.
    const { renderableTabCount } = state.reconcileWorktreeTabModel(worktreeId)
    if (renderableTabCount === 0) {
      setActiveWorktree(null)
    }
  }, [setActiveWorktree, worktreeId])

  // Why: sibling-member tabs route through the aggregated strip but use the
  // same cross-worktree store close helpers as the legacy terminal/browser/
  // editor paths. The visible id we receive is whatever TabBar emitted —
  // entityId for terminals/browsers, unifiedTabId for editors — so we map it
  // back to the unified tab to decide which close path applies.
  const closeAggregatedSiblingTab = useCallback(
    (visibleId: string) => {
      const sibling = siblingTabByVisibleId.get(visibleId)
      if (!sibling) {
        return
      }
      const { tab } = sibling
      if (tab.contentType === 'terminal') {
        closeTab(tab.entityId)
      } else if (tab.contentType === 'browser') {
        destroyWorkspaceWebviews(useAppStore.getState().browserPagesByWorkspace, tab.entityId)
        closeBrowserTab(tab.entityId)
      } else {
        // Editor-family: ask the file's own model whether the file should
        // close (handles dirty-state save dialog), then drop the unified tab.
        const otherReference = (
          useAppStore.getState().unifiedTabsByWorktree[sibling.ownerWorktreeId] ?? []
        ).some(
          (other) =>
            other.id !== tab.id &&
            other.entityId === tab.entityId &&
            (other.contentType === 'editor' ||
              other.contentType === 'diff' ||
              other.contentType === 'conflict-review')
        )
        if (!otherReference) {
          const file = useAppStore
            .getState()
            .openFiles.find((candidate) => candidate.id === tab.entityId)
          if (file?.isDirty) {
            requestEditorFileClose(tab.entityId)
            return
          }
          closeFile(tab.entityId)
        }
        closeUnifiedTab(tab.id)
      }
    },
    [closeBrowserTab, closeFile, closeTab, closeUnifiedTab, siblingTabByVisibleId]
  )

  const closeItem = useCallback(
    (itemId: string, opts?: { skipEmptyCheck?: boolean }) => {
      const item = groupTabs.find((candidate) => candidate.id === itemId)
      if (!item) {
        // Why: a sibling-member tab is being closed via the aggregated strip.
        // The store-level close helpers walk every worktree by tabId, so we
        // can route directly without needing the local groupTabs hit.
        // leaveWorktreeIfEmpty is intentionally skipped here — the sibling's
        // own model handles its emptiness when its surface activates.
        closeAggregatedSiblingTab(itemId)
        return
      }
      if (item.contentType === 'terminal') {
        closeTab(item.entityId)
      } else if (item.contentType === 'browser') {
        destroyWorkspaceWebviews(useAppStore.getState().browserPagesByWorkspace, item.entityId)
        closeBrowserTab(item.entityId)
      } else {
        const canCloseTab = closeEditorIfUnreferenced(item.entityId, item.id)
        if (!canCloseTab) {
          return
        }
        closeUnifiedTab(item.id)
      }
      if (!opts?.skipEmptyCheck) {
        leaveWorktreeIfEmpty()
      }
    },
    [
      closeAggregatedSiblingTab,
      closeBrowserTab,
      closeEditorIfUnreferenced,
      closeTab,
      closeUnifiedTab,
      groupTabs,
      leaveWorktreeIfEmpty
    ]
  )

  const closeMany = useCallback(
    (itemIds: string[]) => {
      for (const itemId of itemIds) {
        const item = groupTabs.find((candidate) => candidate.id === itemId)
        if (!item) {
          continue
        }
        if (item.contentType === 'terminal') {
          closeTab(item.entityId)
        } else if (item.contentType === 'browser') {
          destroyWorkspaceWebviews(useAppStore.getState().browserPagesByWorkspace, item.entityId)
          closeBrowserTab(item.entityId)
        } else {
          const canCloseTab = closeEditorIfUnreferenced(item.entityId, item.id)
          if (canCloseTab) {
            closeUnifiedTab(item.id)
          }
        }
      }
    },
    [closeBrowserTab, closeEditorIfUnreferenced, closeTab, closeUnifiedTab, groupTabs]
  )

  const activateTerminal = useCallback(
    (terminalId: string) => {
      const item = groupTabs.find(
        (candidate) => candidate.entityId === terminalId && candidate.contentType === 'terminal'
      )
      if (!item) {
        // Sibling-member terminal tab routed through the aggregated strip.
        const sibling = siblingTabByVisibleId.get(terminalId)
        if (sibling && sibling.tab.contentType === 'terminal') {
          // Why: switch the active worktree FIRST so when the sibling member's
          // surface becomes visible, its activate calls land on the right
          // worktree's PTY/tab maps. activateTab() then fixes up the sibling's
          // own activeGroupIdByWorktree/activeTabId via its cross-worktree
          // lookup, so the user lands on the clicked tab inside that surface.
          setActiveWorktree(sibling.ownerWorktreeId)
          activateTab(sibling.tab.id)
          setActiveTab(terminalId)
          setActiveTabType('terminal')
        }
        return
      }
      focusGroup(worktreeId, groupId)
      activateTab(item.id)
      setActiveTab(terminalId)
      setActiveTabType('terminal')
    },
    [
      activateTab,
      focusGroup,
      groupId,
      groupTabs,
      setActiveTab,
      setActiveTabType,
      setActiveWorktree,
      siblingTabByVisibleId,
      worktreeId
    ]
  )

  const activateEditor = useCallback(
    (tabId: string) => {
      const item = groupTabs.find((candidate) => candidate.id === tabId)
      if (!item) {
        const sibling = siblingTabByVisibleId.get(tabId)
        if (
          sibling &&
          sibling.tab.contentType !== 'terminal' &&
          sibling.tab.contentType !== 'browser'
        ) {
          setActiveWorktree(sibling.ownerWorktreeId)
          activateTab(sibling.tab.id)
          setActiveFile(sibling.tab.entityId)
          setActiveTabType('editor')
        }
        return
      }
      focusGroup(worktreeId, groupId)
      activateTab(item.id)
      setActiveFile(item.entityId)
      setActiveTabType('editor')
    },
    [
      activateTab,
      focusGroup,
      groupId,
      groupTabs,
      setActiveFile,
      setActiveTabType,
      setActiveWorktree,
      siblingTabByVisibleId,
      worktreeId
    ]
  )

  const activateBrowser = useCallback(
    (browserTabId: string) => {
      const item = groupTabs.find(
        (candidate) => candidate.entityId === browserTabId && candidate.contentType === 'browser'
      )
      if (!item) {
        const sibling = siblingTabByVisibleId.get(browserTabId)
        if (sibling && sibling.tab.contentType === 'browser') {
          setActiveWorktree(sibling.ownerWorktreeId)
          activateTab(sibling.tab.id)
          setActiveBrowserTab(browserTabId)
          setActiveTabType('browser')
        }
        return
      }
      focusGroup(worktreeId, groupId)
      activateTab(item.id)
      setActiveBrowserTab(browserTabId)
      setActiveTabType('browser')
    },
    [
      activateTab,
      focusGroup,
      groupId,
      groupTabs,
      setActiveBrowserTab,
      setActiveTabType,
      setActiveWorktree,
      siblingTabByVisibleId,
      worktreeId
    ]
  )

  const createSplitGroup = useCallback(
    (direction: 'left' | 'right' | 'up' | 'down', sourceVisibleTabId?: string) => {
      const sourceTab =
        groupTabs.find((candidate) =>
          candidate.contentType === 'terminal' || candidate.contentType === 'browser'
            ? candidate.entityId === sourceVisibleTabId
            : candidate.id === sourceVisibleTabId
        ) ?? activeTab

      focusGroup(worktreeId, groupId)
      if (!sourceTab) {
        return
      }

      // Why: for terminals specifically, splitting a single-tab group should
      // still produce a useful split — spawn a fresh terminal in the new pane
      // and leave the existing one behind. Moving the only tab would collapse
      // the split immediately (see the same-group guard in dropUnifiedTab),
      // giving the user nothing; a new terminal preserves the old shortcut
      // flow without duplicating a persistent tab like editors/browsers would.
      if (sourceTab.contentType === 'terminal' && groupTabs.length <= 1) {
        const newGroupId = createEmptySplitGroup(worktreeId, groupId, direction)
        if (!newGroupId) {
          return
        }
        const terminal = createTab(worktreeId, newGroupId)
        setActiveTab(terminal.id)
        setActiveTabType('terminal')
        return
      }

      // Why: split actions MOVE the source tab into the new pane rather than
      // leaving a duplicate in the origin. Delegating to dropUnifiedTab reuses
      // the same split+move path as drag-to-split so keyboard/menu splits and
      // drag splits stay behaviorally identical, including collapsing the
      // origin group if its last tab is the one we just moved.
      dropUnifiedTab(sourceTab.id, { groupId, splitDirection: direction })
    },
    [
      activeTab,
      createEmptySplitGroup,
      createTab,
      dropUnifiedTab,
      focusGroup,
      groupId,
      groupTabs,
      setActiveTab,
      setActiveTabType,
      worktreeId
    ]
  )

  const closeGroup = useCallback(() => {
    const items = [...(useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? [])].filter(
      (item) => item.groupId === groupId
    )
    for (const item of items) {
      closeItem(item.id, { skipEmptyCheck: true })
    }
    // Why: empty split groups are layout state, not tab state. The workspace
    // model owns collapsing those placeholder panes so views do not need to
    // understand when closing tabs is insufficient to remove a group shell.
    closeEmptyGroup(worktreeId, groupId)
    leaveWorktreeIfEmpty()
  }, [closeEmptyGroup, closeItem, groupId, leaveWorktreeIfEmpty, worktreeId])

  const closeAllEditorTabsInGroup = useCallback(() => {
    for (const item of groupTabs) {
      if (
        item.contentType === 'editor' ||
        item.contentType === 'diff' ||
        item.contentType === 'conflict-review'
      ) {
        closeItem(item.id)
      }
    }
  }, [closeItem, groupTabs])

  const closeOthers = useCallback(
    (itemId: string) => {
      const item = groupTabs.find((candidate) => candidate.id === itemId)
      if (!item) {
        return
      }
      // Why: the store's closeOtherTabs helper unconditionally closes every non-pinned
      // sibling unified tab, including dirty editor tabs — stranding those files in
      // openFiles without a tab if the user cancels the save dialog. Collect the target
      // ids here instead and route them through the same dirty-aware closeMany path
      // used by individual tab closes so the Cancel -> zombie-file hazard is impossible.
      const siblingIds = groupTabs
        .filter((candidate) => candidate.id !== itemId && !candidate.isPinned)
        .map((candidate) => candidate.id)
      closeMany(siblingIds)
    },
    [closeMany, groupTabs]
  )

  const closeToRight = useCallback(
    (itemId: string) => {
      // Why: see closeOthers — the store's closeTabsToRight helper pre-closes dirty
      // editor tabs before the save dialog resolves. Walking the group's tabOrder
      // locally (unifiedTabsByWorktree is append-ordered, not visually ordered, so
      // tabOrder is the canonical left-to-right sequence) and routing through
      // closeMany keeps the dirty-aware flow intact.
      const order = group?.tabOrder ?? []
      const index = order.indexOf(itemId)
      if (index === -1) {
        return
      }
      const tabById = new Map(groupTabs.map((candidate) => [candidate.id, candidate]))
      const rightIds = order.slice(index + 1).filter((id) => {
        const candidate = tabById.get(id)
        return candidate ? !candidate.isPinned : false
      })
      closeMany(rightIds)
    },
    [closeMany, group, groupTabs]
  )

  const tabBarOrder = useMemo(() => {
    const localOrder = (group?.tabOrder ?? []).map((itemId) => {
      const item = groupTabs.find((candidate) => candidate.id === itemId)
      if (!item) {
        return itemId
      }
      return item.contentType === 'terminal' || item.contentType === 'browser'
        ? item.entityId
        : item.id
    })
    return aggregatedSiblings.tabBarOrder.length > 0
      ? [...localOrder, ...aggregatedSiblings.tabBarOrder]
      : localOrder
  }, [aggregatedSiblings.tabBarOrder, group, groupTabs])

  return {
    group,
    activeTab,
    browserItems: aggregatedBrowserItems,
    editorItems: aggregatedEditorItems,
    terminalTabs: aggregatedTerminalTabs,
    tabBarOrder,
    groupTabs,
    /**
     * Maps a sibling-member tab’s visible id (entityId for terminals/browsers,
     * unifiedTabId for editors) to the worktree that owns it. Consumed by
     * TabBar surfaces that need to render a per-tab member affordance
     * (e.g. the repo badge) without re-deriving the lookup themselves.
     */
    ownerByVisibleId: aggregatedSiblings.ownerByVisibleId,
    expandedPaneByTabId: worktreeState.expandedPaneByTabId,
    commands: {
      focusGroup: () => {
        focusGroup(worktreeId, groupId)
      },
      activateBrowser,
      activateEditor,
      activateTerminal,
      closeAggregatedSiblingTab,
      closeAllEditorTabsInGroup,
      closeGroup,
      closeItem,
      closeOthers,
      closeToRight,
      createSplitGroup,
      newBrowserTab: () => {
        const defaultUrl = useAppStore.getState().browserDefaultUrl ?? 'about:blank'
        createBrowserTab(worktreeId, defaultUrl, {
          title: 'New Browser Tab',
          focusAddressBar: true
        })
      },
      duplicateBrowserTab: (browserTabId: string) => {
        const state = useAppStore.getState()
        const tabs = state.browserTabsByWorktree[worktreeId] ?? []
        const source = tabs.find((t) => t.id === browserTabId)
        if (!source) {
          return
        }
        createBrowserTab(worktreeId, source.url, {
          title: source.title,
          sessionProfileId: source.sessionProfileId
        })
      },
      // Why: split-group actions must target their owning group explicitly.
      // Relying on the ambient activeGroupIdByWorktree breaks keyboard and
      // assistive-tech activation because the "+" menu can be triggered from
      // an unfocused panel without first updating global group focus.
      newFileTab: async () => {
        const path = worktree?.path
        if (!path) {
          return
        }
        try {
          const connectionId = getConnectionId(worktreeId) ?? undefined
          const fileInfo = await createUntitledMarkdownFile(path, worktreeId, connectionId)
          openFile(fileInfo, { preview: false, targetGroupId: groupId })
        } catch (err) {
          toast.error(extractIpcErrorMessage(err, 'Failed to create untitled markdown file.'))
        }
      },
      newTerminalTab: () => {
        const terminal = createTab(worktreeId, groupId)
        setActiveTab(terminal.id)
        setActiveTabType('terminal')
        focusTerminalTabSurface(terminal.id)
      },
      newTerminalWithShell: (shellOverride: string) => {
        const terminal = createTab(worktreeId, groupId, shellOverride)
        setActiveTab(terminal.id)
        setActiveTabType('terminal')
        focusTerminalTabSurface(terminal.id)
      },
      pinFile,
      setTabColor,
      setTabCustomTitle
    }
  }
}
