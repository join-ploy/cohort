import * as React from 'react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { Worktree } from '../../../../../shared/types'

export type WorktreePickerProps = {
  projectId: string
  onSelect: (worktreeId: string) => void
  /** When the consumer already has a chosen value, suppress the auto-prefill
   *  side-effect — otherwise re-mounting after a manual change would clobber
   *  it back to the (still-only) option. */
  currentValue?: string
  onCancel?: () => void
  className?: string
}

function stripBranchPrefix(branch: string): string {
  return branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch
}

export function WorktreePicker(props: WorktreePickerProps): React.JSX.Element {
  const worktrees = useAppStore((s) => {
    const byRepo = s.worktreesByRepo as Record<string, Worktree[]>
    if (!props.projectId) {
      return [] as Worktree[]
    }
    return byRepo[props.projectId] ?? []
  })

  // Why: when the picker mounts with nothing chosen and there's exactly one
  // worktree to pick, skip the manual click — there's nothing else the user
  // could meaningfully choose. Guarded by `currentValue` (and by the fact
  // that we only fire once via the ref) so a later worktree appearing or the
  // user re-opening the picker after a change won't overwrite their value.
  const { onSelect, currentValue } = props
  const autoPrefilledRef = React.useRef(false)
  React.useEffect(() => {
    if (autoPrefilledRef.current) {
      return
    }
    if (currentValue && currentValue.length > 0) {
      return
    }
    if (worktrees.length !== 1) {
      return
    }
    autoPrefilledRef.current = true
    onSelect(worktrees[0].id)
  }, [worktrees, currentValue, onSelect])

  if (worktrees.length === 0) {
    return (
      <div className={cn('p-3 text-xs text-muted-foreground', props.className)}>
        No worktrees in this project.
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col gap-2', props.className)}>
      <ul className="flex flex-col divide-y divide-border rounded-md border border-input">
        {worktrees.map((wt) => {
          const branch = stripBranchPrefix(wt.branch ?? '')
          return (
            <li key={wt.id}>
              <button
                type="button"
                data-worktree-id={wt.id}
                onClick={() => props.onSelect(wt.id)}
                className="flex w-full items-baseline gap-2 px-2 py-2 text-left text-xs hover:bg-accent"
              >
                <span className="font-medium text-foreground">{wt.displayName}</span>
                {branch ? <span className="text-muted-foreground">{branch}</span> : null}
              </button>
            </li>
          )
        })}
      </ul>
      {props.onCancel ? (
        <button
          type="button"
          onClick={props.onCancel}
          className="self-end text-xs text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      ) : null}
    </div>
  )
}
