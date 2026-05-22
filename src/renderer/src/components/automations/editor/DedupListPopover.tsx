import * as React from 'react'
import { Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { AutoDedupEntry } from '../../../../../shared/automations-types'

export type DedupListPopoverProps = {
  entries: AutoDedupEntry[]
  onClearOne: (entityId: string) => void
  onClearAll: () => void
  onClose: () => void
  open: boolean
}

// Why: rendered as a conditional inline <div> rather than a portal so the
// surface is testable via renderToStaticMarkup — same pattern as TriggersModal
// and TriggerPill's popover.
export function DedupListPopover(props: DedupListPopoverProps): React.JSX.Element | null {
  if (!props.open) {
    return null
  }
  const { entries, onClearOne, onClearAll, onClose } = props
  return (
    <div
      role="dialog"
      aria-label="Fired issues"
      className="absolute right-0 top-full z-30 mt-1 w-80 overflow-hidden rounded-lg border border-border bg-popover shadow-[0_10px_24px_rgba(0,0,0,0.18)]"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h4 className="text-sm font-semibold">Fired for {entries.length} issues</h4>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Close" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </div>
      {entries.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">
          No fired issues recorded.
        </p>
      ) : (
        <ul className="max-h-72 divide-y divide-border overflow-y-auto">
          {entries.map((e) => {
            const label = e.entityIdentifier ?? e.entityId
            return (
              <li
                key={e.entityId}
                className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-accent/50"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="font-mono text-xs">{label}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {new Date(e.firedAt).toLocaleString()}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Clear ${label}`}
                  onClick={() => {
                    if (!window.confirm(`Clear ${label}?`)) {
                      return
                    }
                    onClearOne(e.entityId)
                  }}
                >
                  <Trash2 className="size-3" />
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      <div className="flex justify-end border-t border-border px-3 py-2">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={entries.length === 0}
          onClick={() => {
            if (
              !window.confirm(
                'This will let already-handled issues fire again on the next poll. Continue?'
              )
            ) {
              return
            }
            onClearAll()
          }}
        >
          Clear all
        </Button>
      </div>
    </div>
  )
}
