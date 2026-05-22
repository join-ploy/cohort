import * as React from 'react'
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
      className="absolute right-0 top-full z-30 mt-1 w-72 rounded-md border bg-popover p-3 text-xs shadow-md"
    >
      <div className="flex items-center justify-between">
        <h4 className="font-medium">Fired for {entries.length} issues</h4>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="rounded px-1 hover:bg-accent hover:text-foreground"
        >
          ✕
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="mt-2 text-muted-foreground">No fired issues recorded.</p>
      ) : (
        <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto">
          {entries.map((e) => {
            const label = e.entityIdentifier ?? e.entityId
            return (
              <li key={e.entityId} className="flex items-center justify-between gap-2">
                <span>
                  {label}
                  <span className="ml-1 text-muted-foreground">
                    {new Date(e.firedAt).toLocaleString()}
                  </span>
                </span>
                <button
                  type="button"
                  aria-label={`Clear ${label}`}
                  onClick={() => {
                    if (!window.confirm(`Clear ${label}?`)) {
                      return
                    }
                    onClearOne(e.entityId)
                  }}
                  className="rounded border border-border bg-background px-2 py-0.5 hover:bg-accent hover:text-foreground"
                >
                  Clear
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <div className="mt-3 flex justify-end">
        <button
          type="button"
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
          className="rounded border border-border bg-background px-2 py-0.5 hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          Clear all
        </button>
      </div>
    </div>
  )
}
