import React from 'react'
import { GitPullRequest } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { invokeSidebarPromptCommand } from '@/lib/invoke-sidebar-prompt-command'

type CreatePrButtonProps = {
  layout: 'top' | 'side'
}

function branchDisplayName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

/**
 * Right-sidebar header Create-PR dropdown. Only renders when the active
 * worktree's branch has no open PR in `prCache` — the button purpose is
 * "open one" and we don't want to encourage the user to spam create more.
 *
 * When a cached PR exists in any non-terminal state we hide. `merged` /
 * `closed` count as "had one and it's gone" so we still hide there too —
 * users who want to open a fresh PR for the same branch can switch agents
 * from a regular terminal.
 */
export function CreatePrButton({ layout }: CreatePrButtonProps): React.JSX.Element | null {
  const createPrCommands = useAppStore((s) => s.settings?.createPrCommands ?? [])
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeWorktree = useAppStore((s) =>
    s.activeWorktreeId ? findWorktreeById(s.worktreesByRepo, s.activeWorktreeId) : null
  )
  const activeRepo = useAppStore((s) =>
    activeWorktree ? s.repos.find((r) => r.id === activeWorktree.repoId) : null
  )
  // Why: read only the specific cache entry rather than the whole prCache
  // map so the button does not re-render on unrelated PR cache updates.
  const prCacheKey =
    activeRepo && activeWorktree
      ? `${activeRepo.path}::${branchDisplayName(activeWorktree.branch)}`
      : ''
  const prEntry = useAppStore((s) => (prCacheKey ? s.prCache[prCacheKey] : undefined))

  if (createPrCommands.length === 0 || !activeWorktreeId) {
    return null
  }
  // Why: a non-null `data` field means GitHub returned a PR for this branch.
  // The cache being missing or `data === null` means "no PR known", which
  // is the only state where the button should appear.
  if (prEntry?.data) {
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
              aria-label="Create PR"
              className={cn(
                'flex items-center justify-center text-muted-foreground/60 transition-colors hover:text-muted-foreground',
                isTop ? 'h-[36px] w-9' : 'h-10 w-10'
              )}
            >
              <GitPullRequest size={isTop ? 16 : 18} />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side={isTop ? 'bottom' : 'left'} sideOffset={6}>
          Create PR
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        {createPrCommands.map((cmd) => (
          <DropdownMenuItem
            key={cmd.id}
            onSelect={() => {
              void invokeSidebarPromptCommand(cmd, 'createPr')
            }}
          >
            {cmd.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
