import React from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// Why: shared segmented control for the right-sidebar panels (Setup now, Run
// + Diff in later phases of the grouped-workspaces plan). Each member repo
// of a workspace group owns its own script PTY / diff stream, and this strip
// lets the user pick which member's output the panel below should render.
// Kept generic — the consumer owns selection state and the meaning of each
// status; this component only renders + dispatches clicks.

export type RepoSegmentStatus = 'idle' | 'running' | 'failed' | 'done'

export type RepoSegment = {
  repoId: string
  repoName: string
  status: RepoSegmentStatus
  /** Optional numeric badge appended after the repo name. Used by the Diff
   *  view to surface per-member changed-file counts; setup/run leave it
   *  undefined so the rendered segment is unchanged. */
  badge?: number
}

type Props = {
  segments: RepoSegment[]
  activeRepoId: string
  onSelect: (repoId: string) => void
}

// Why: dot colors mirror the activity-bar STATUS_DOT_COLOR palette so the
// per-segment status reads consistently with the parent tab badge.
const STATUS_DOT_COLOR: Record<Exclude<RepoSegmentStatus, 'running'>, string> = {
  idle: 'bg-muted-foreground/50',
  failed: 'bg-rose-500',
  done: 'bg-emerald-500'
}

function SegmentStatusGlyph({ status }: { status: RepoSegmentStatus }): React.JSX.Element {
  // Why: spinner for running mirrors the activity-bar pulse intent — a glance
  // should tell "still working" apart from a settled exit. Static dot
  // otherwise; idle is dimmer than failure/success to avoid visual noise on
  // workspaces the user hasn't kicked off yet.
  if (status === 'running') {
    return (
      <Loader2
        size={10}
        className="animate-spin text-muted-foreground"
        aria-label="running"
        data-status="running"
      />
    )
  }
  return (
    <span
      className={cn('inline-block size-[7px] rounded-full', STATUS_DOT_COLOR[status])}
      aria-label={status}
      data-status={status}
    />
  )
}

export default function SegmentedRepoTabs({
  segments,
  activeRepoId,
  onSelect
}: Props): React.JSX.Element {
  return (
    <div
      role="tablist"
      aria-label="Repo segments"
      className="flex h-9 items-center gap-1 border-b border-border px-2 overflow-x-auto"
    >
      {segments.map((segment) => {
        const isActive = segment.repoId === activeRepoId
        return (
          <button
            key={segment.repoId}
            role="tab"
            type="button"
            aria-selected={isActive}
            data-active={isActive}
            data-repo-id={segment.repoId}
            onClick={() => onSelect(segment.repoId)}
            className={cn(
              'group inline-flex items-center gap-1.5 rounded-md px-2 h-7 text-xs whitespace-nowrap transition-colors',
              isActive
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'
            )}
          >
            <SegmentStatusGlyph status={segment.status} />
            <span className="truncate max-w-[140px]">{segment.repoName}</span>
            {/* Why: badge surfaces a numeric count (e.g. changed files for the
                Diff view). Hidden when the count is 0 so the unchanged segment
                still reads as quiet/idle. */}
            {typeof segment.badge === 'number' && segment.badge > 0 && (
              <span
                className="ml-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-muted px-1 text-[10px] font-medium leading-none text-muted-foreground"
                data-segment-badge={segment.badge}
              >
                {segment.badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
