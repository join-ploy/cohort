import React from 'react'
import { Eye } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { invokeSidebarPromptCommand } from '@/lib/invoke-sidebar-prompt-command'

type ReviewButtonProps = {
  layout: 'top' | 'side'
}

/**
 * Right-sidebar header Review dropdown. Each entry, when clicked, writes the
 * configured prompt to `~/.orca/prompts/<label>.md` and opens a new central
 * terminal tab running `<command> "$(cat <prompt-path>)"`.
 *
 * Hides itself entirely when no review commands are configured so the
 * header doesn't show an empty trigger.
 */
export function ReviewButton({ layout }: ReviewButtonProps): React.JSX.Element | null {
  const reviewCommands = useAppStore((s) => s.settings?.reviewCommands ?? [])
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  // Why: without an active worktree there is no terminal surface to spawn the
  // command into. Hide the trigger entirely rather than render a disabled
  // button — keeps the header uncluttered when the user is on a non-worktree
  // surface (Settings, Tasks).
  if (reviewCommands.length === 0 || !activeWorktreeId) {
    return null
  }

  const isTop = layout === 'top'
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Review"
              className={cn(
                'flex items-center justify-center text-muted-foreground/60 transition-colors hover:text-muted-foreground',
                isTop ? 'h-[36px] w-9' : 'h-10 w-10'
              )}
            >
              <Eye size={isTop ? 16 : 18} />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side={isTop ? 'bottom' : 'left'} sideOffset={6}>
          Review
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        {reviewCommands.map((cmd) => (
          <DropdownMenuItem
            key={cmd.id}
            onSelect={() => {
              void invokeSidebarPromptCommand(cmd, 'review')
            }}
          >
            {cmd.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
