import * as React from 'react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { Repo } from '../../../../../shared/types'

export type ProjectPickerProps = {
  onSelect: (projectId: string) => void
  onCancel?: () => void
  className?: string
}

export function ProjectPicker(props: ProjectPickerProps): React.JSX.Element {
  const repos = useAppStore((s) => s.repos as Repo[])

  if (repos.length === 0) {
    return (
      <div className={cn('p-3 text-xs text-muted-foreground', props.className)}>
        No projects available.
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col gap-2', props.className)}>
      <ul className="flex flex-col divide-y divide-border rounded-md border border-input">
        {repos.map((repo) => (
          <li key={repo.id}>
            <button
              type="button"
              data-project-id={repo.id}
              onClick={() => props.onSelect(repo.id)}
              className="flex w-full items-baseline gap-2 px-2 py-2 text-left text-xs hover:bg-accent"
            >
              <span className="font-medium text-foreground">{repo.displayName}</span>
              {repo.path ? <span className="text-muted-foreground">{repo.path}</span> : null}
            </button>
          </li>
        ))}
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
