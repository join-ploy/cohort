import React from 'react'
import { Files, Search, GitBranch, ListChecks, Cable, Play, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { RightSidebarTab, ActivityBarPosition } from '@/store/slices/editor'
import type { CheckStatus } from '../../../../shared/types'
import type { ScriptStatus } from '@/store/slices/scripts'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem
} from '@/components/ui/context-menu'

export type ActivityBarItem = {
  id: RightSidebarTab
  icon: React.ComponentType<{ size?: number; className?: string }>
  title: string
  shortcut: string
  /** When true, hidden for non-git (folder-mode) repos. */
  gitOnly?: boolean
  /** When true, only shown when at least one SSH connection is active. */
  sshOnly?: boolean
}

const isMac = navigator.userAgent.includes('Mac')
const mod = isMac ? '⌘' : 'Ctrl+'
const shift = isMac ? '⇧' : 'Shift+'

export const ACTIVITY_ITEMS: ActivityBarItem[] = [
  // Why: run/setup lead because they're the primary "do something with this
  // worktree" actions — pinned leftmost so users land on the run terminal
  // (the new default tab) without scrolling past file-browsing surfaces.
  // gitOnly because per-repo run/setup scripts only make sense for git repos
  // (folder repos have no worktrees that own a script PTY). See Phase 5 of
  // docs/plans/2026-05-14-per-repo-run-script.md.
  { id: 'run', icon: Play, title: 'Run', shortcut: `${mod}R`, gitOnly: true },
  { id: 'setup', icon: Wrench, title: 'Setup', shortcut: '', gitOnly: true },
  { id: 'explorer', icon: Files, title: 'Explorer', shortcut: `${shift}${mod}E` },
  { id: 'search', icon: Search, title: 'Search', shortcut: `${shift}${mod}F` },
  {
    id: 'source-control',
    icon: GitBranch,
    title: 'Source Control',
    shortcut: `${shift}${mod}G`,
    gitOnly: true
  },
  {
    id: 'checks',
    icon: ListChecks,
    title: 'Checks',
    shortcut: `${shift}${mod}K`,
    gitOnly: true
  },
  {
    id: 'ports',
    icon: Cable,
    title: 'Ports',
    // Why: Ctrl+Shift+I is the DevTools accelerator on Windows/Linux, so this
    // shortcut is macOS-only. On other platforms the tooltip omits it.
    shortcut: isMac ? `${shift}${mod}I` : '',
    sshOnly: true
  }
]

// ─── Status indicator dot color mapping ──────
const STATUS_DOT_COLOR: Record<CheckStatus, string> = {
  success: 'bg-emerald-500',
  failure: 'bg-rose-500',
  pending: 'bg-amber-500',
  neutral: 'bg-muted-foreground'
}

// Why: the activity-bar dot signals "is this script live right now?" — once
// it exits (success or failure), the dot vanishes so the bar isn't littered
// with stale post-mortem dots. Run/setup share this rule. Final exit status
// is still surfaced inside the panels themselves; the activity-bar dot is
// purely a "running" pulse.
export function scriptStatusToCheckStatus(status: ScriptStatus): CheckStatus | null {
  return status === 'running' ? 'pending' : null
}

// ─── Activity Bar Button (shared for top + side) ──────
export function ActivityBarButton({
  item,
  active,
  onClick,
  layout,
  statusIndicator,
  statusIndicatorPulse
}: {
  item: ActivityBarItem
  active: boolean
  onClick: () => void
  layout: 'top' | 'side'
  statusIndicator?: CheckStatus | null
  // Why: Run/Setup's 'running' state pulses the dot so a glance can
  // distinguish "still working" from a settled exit code. Checks reuses the
  // same palette but never pulses (CI 'pending' is more passive — refresh
  // cycles, not a live process the user just started).
  statusIndicatorPulse?: boolean
}): React.JSX.Element {
  const Icon = item.icon
  const isTop = layout === 'top'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={cn(
            'relative flex items-center justify-center transition-colors',
            isTop ? 'h-[36px] w-9' : 'w-10 h-10',
            active ? 'text-foreground' : 'text-muted-foreground/60 hover:text-muted-foreground'
          )}
          onClick={onClick}
          aria-label={item.shortcut ? `${item.title} (${item.shortcut})` : item.title}
        >
          <Icon size={isTop ? 16 : 18} />

          {/* Status indicator dot */}
          {statusIndicator && statusIndicator !== 'neutral' && (
            <div
              className={cn(
                'absolute rounded-full size-[7px] ring-1 ring-sidebar',
                isTop ? 'top-[8px] right-[5px]' : 'top-[7px] right-[7px]',
                STATUS_DOT_COLOR[statusIndicator] ?? 'bg-muted-foreground',
                statusIndicatorPulse && 'animate-pulse'
              )}
            />
          )}

          {/* Active indicator */}
          {active && isTop && (
            <div className="absolute bottom-0 left-[25%] right-[25%] h-[2px] bg-foreground rounded-t" />
          )}
          {active && !isTop && (
            <div className="absolute right-0 top-[25%] bottom-[25%] w-[2px] bg-foreground rounded-l" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side={isTop ? 'bottom' : 'left'} sideOffset={6}>
        {item.shortcut ? `${item.title} (${item.shortcut})` : item.title}
      </TooltipContent>
    </Tooltip>
  )
}

// ─── Context Menu for Activity Bar Position ───────────
export function ActivityBarPositionMenu({
  currentPosition,
  onChangePosition
}: {
  currentPosition: ActivityBarPosition
  onChangePosition: (pos: ActivityBarPosition) => void
}): React.JSX.Element {
  return (
    <ContextMenuContent>
      <ContextMenuLabel>Activity Bar Position</ContextMenuLabel>
      <ContextMenuRadioGroup
        value={currentPosition}
        onValueChange={(v) => onChangePosition(v as ActivityBarPosition)}
      >
        <ContextMenuRadioItem value="top">Top</ContextMenuRadioItem>
        <ContextMenuRadioItem value="side">Side</ContextMenuRadioItem>
      </ContextMenuRadioGroup>
    </ContextMenuContent>
  )
}
