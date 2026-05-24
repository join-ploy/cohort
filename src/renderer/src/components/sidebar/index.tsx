import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import SidebarHeader from './SidebarHeader'
import SidebarNav from './SidebarNav'
import WorktreeList from './WorktreeList'
import SidebarToolbar from './SidebarToolbar'
import WorktreeMetaDialog from './WorktreeMetaDialog'
import GroupMetaDialog from './GroupMetaDialog'
import DeleteWorktreeDialog from './DeleteWorktreeDialog'
import NonGitFolderDialog from './NonGitFolderDialog'
import RemoveFolderDialog from './RemoveFolderDialog'
import AddRepoDialog from './AddRepoDialog'
import OrcaYamlTrustDialog from './OrcaYamlTrustDialog'
import { ArchivedSection } from './ArchivedSection'
import { GroupsSection } from './GroupsSection'

const MIN_WIDTH = 220
const MAX_WIDTH = 500

function Sidebar(): React.JSX.Element {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth)
  const repos = useAppStore((s) => s.repos)
  const fetchAllWorktrees = useAppStore((s) => s.fetchAllWorktrees)
  // Why: gate the experimental Groups sidebar section. GroupsSection itself
  // returns null when there are no visible groups, so the flag is the only
  // condition needed at the call site. Optional chain mirrors other sidebar
  // settings reads — settings can be null during the initial bootstrap.
  const groupedWorkspacesEnabled = useAppStore(
    (s) => s.settings?.experimentalGroupedWorkspaces === true
  )

  // Fetch worktrees when repos are added/removed
  const repoCount = repos.length
  useEffect(() => {
    if (repoCount > 0) {
      fetchAllWorktrees()
    }
  }, [repoCount, fetchAllWorktrees])

  const { containerRef, onResizeStart } = useSidebarResize<HTMLDivElement>({
    isOpen: sidebarOpen,
    width: sidebarWidth,
    minWidth: MIN_WIDTH,
    maxWidth: MAX_WIDTH,
    deltaSign: 1,
    setWidth: setSidebarWidth
  })

  // Why: GroupsSection + WorktreeList + ArchivedSection now share this scroll
  // container so all three sections move together as one continuous list.
  // Previously WorktreeList owned its own scroll element, which left
  // GroupsSection frozen above a scrolling pane.
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // Why: WorktreeList virtualizes its rows against scrollContainerRef. Any
  // non-virtualized content above it (currently GroupsSection) shifts the
  // virtualizer's origin within the container — scrollMargin compensates by
  // telling the virtualizer how many pixels to skip. ResizeObserver on the
  // groups wrapper keeps the value in sync as groups are added/removed.
  const groupsWrapperRef = useRef<HTMLDivElement>(null)
  const [groupsHeight, setGroupsHeight] = useState(0)
  useLayoutEffect(() => {
    const el = groupsWrapperRef.current
    if (!el) {
      // Flag turned off (or no groups) — the wrapper is unmounted, so the
      // virtualizer's scrollMargin must drop to 0 to avoid empty space.
      setGroupsHeight(0)
      return
    }
    const measure = (): void => {
      setGroupsHeight(el.offsetHeight)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [groupedWorkspacesEnabled])

  // Why: WorktreeList's keyboard cycling navigator used to live on its own
  // scroll container. With the container hoisted, the handler is registered
  // up through this ref and the shared container's ArrowUp/Down handler
  // forwards to it. Stored as a ref instead of state to avoid re-renders.
  const navigateWorktreeRef = useRef<((direction: 'up' | 'down') => void) | null>(null)
  const registerNavigateWorktree = useCallback((handler: (direction: 'up' | 'down') => void) => {
    navigateWorktreeRef.current = handler
  }, [])

  // Why: aria-activedescendant lives on the listbox root (the shared scroll
  // container). WorktreeList surfaces the active option id through this
  // setter so the parent can apply it without remounting.
  const [activeDescendantId, setActiveDescendantId] = useState<string | undefined>(undefined)

  const handleContainerKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (e.target !== e.currentTarget) {
        return
      }
      navigateWorktreeRef.current?.(e.key === 'ArrowUp' ? 'up' : 'down')
      e.preventDefault()
    } else if (e.key === 'Enter') {
      const helper = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
      if (helper) {
        helper.focus()
      }
      e.preventDefault()
    }
  }, [])

  return (
    <TooltipProvider delayDuration={400}>
      <div
        ref={containerRef}
        // Why: --left-sidebar-background is its own token (separate from the
        // shared --sidebar token) so the right sidebar and other panels that
        // rely on bg-sidebar/sidebar-accent keep their existing surface color.
        style={{ background: 'var(--left-sidebar-background)' }}
        className="relative min-h-0 flex-shrink-0 flex flex-col overflow-hidden scrollbar-sleek-parent"
      >
        {/* Fixed controls */}
        <SidebarNav />
        <SidebarHeader />

        {/* Why: this single scroll container holds GroupsSection +
            WorktreeList + ArchivedSection so they all scroll together. It
            also owns the listbox role + a11y attrs the worktree list relied
            on, and keyboard arrow handling for cycling between worktrees. */}
        <div
          ref={scrollContainerRef}
          data-worktree-sidebar
          tabIndex={0}
          role="listbox"
          aria-label="Worktrees"
          aria-orientation="vertical"
          aria-multiselectable="true"
          aria-activedescendant={activeDescendantId}
          onKeyDown={handleContainerKeyDown}
          className="worktree-sidebar-scrollbar flex-1 overflow-y-scroll overflow-x-hidden pl-1 scrollbar-sleek outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset pt-px"
        >
          {groupedWorkspacesEnabled ? (
            <div ref={groupsWrapperRef}>
              <GroupsSection />
            </div>
          ) : null}

          <WorktreeList
            scrollContainerRef={scrollContainerRef}
            scrollMargin={groupsHeight}
            registerNavigateWorktree={registerNavigateWorktree}
            setActiveDescendantId={setActiveDescendantId}
          />
        </div>

        {/* Why: pinned between the scroll viewport and the toolbar so the
            Archived disclosure stays at a stable position regardless of how
            many worktrees the user has. Self-hides (returns null) when no
            archived entries exist. */}
        <ArchivedSection />

        {/* Fixed bottom toolbar */}
        <SidebarToolbar />

        {/* Resize handle */}
        <div
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-ring/20 active:bg-ring/30 transition-colors z-10"
          onMouseDown={onResizeStart}
        />
      </div>

      {/* Dialog (rendered outside sidebar to avoid clipping) */}
      <WorktreeMetaDialog />
      <GroupMetaDialog />
      <DeleteWorktreeDialog />
      <NonGitFolderDialog />
      <RemoveFolderDialog />
      <AddRepoDialog />
      <OrcaYamlTrustDialog />
    </TooltipProvider>
  )
}

export default React.memo(Sidebar)
