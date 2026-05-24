import React, { useMemo } from 'react'
import { useActiveGroupId, useWorkspaceGroups } from '@/store/selectors'
import GroupCard from './GroupCard'

// Why: matches the "Workspaces" caption chrome in SidebarHeader so the
// top-level Groups section reads as a sibling section header, not a card.
// px-3 matches WorktreeList's repo-header `pl-3` indent so every sidebar
// section caption (Groups, repo group headers) sits at the same 12px gutter
// from the sidebar edge — without it the Groups caption read as more inset
// than the cards underneath.
const SECTION_HEADER_CLASS =
  'px-3 pt-2 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80 select-none'

export function GroupsSection(): React.JSX.Element | null {
  const workspaceGroups = useWorkspaceGroups()
  // Why: derive the active group from the active worktree so clicking any
  // member (or any other surface that flips activeWorktreeId to a group
  // member) paints the owning group as selected. The selector returns a
  // primitive, so it short-circuits re-renders cleanly.
  const activeGroupId = useActiveGroupId()

  const visibleGroups = useMemo(() => {
    return workspaceGroups
      .filter((g) => !g.isArchived)
      .slice()
      .sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) {
          return a.sortOrder - b.sortOrder
        }
        // Tie-break: newer activity first.
        return b.lastActivityAt - a.lastActivityAt
      })
  }, [workspaceGroups])

  if (visibleGroups.length === 0) {
    return null
  }

  return (
    <section aria-label="Groups" className="flex flex-col gap-0.5 pb-1">
      <div className={SECTION_HEADER_CLASS}>Groups</div>
      <div className="flex flex-col gap-0.5">
        {visibleGroups.map((g) => (
          <GroupCard key={g.id} group={g} isActive={g.id === activeGroupId} />
        ))}
      </div>
    </section>
  )
}

export default GroupsSection
