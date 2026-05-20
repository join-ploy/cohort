import * as React from 'react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type {
  Automation,
  LinearIssuePayload,
  RunNowPayload
} from '../../../../../shared/automations-types'
import { LinearIssuePicker } from './LinearIssuePicker'
import { WorktreePicker } from './WorktreePicker'

export type RunNowConfirmModalProps = {
  open: boolean
  automation: Automation
  onClose: () => void
  onRun: (payload: RunNowPayload) => Promise<void>
}

/**
 * Sticky confirm modal mounted before a manual run when the automation's
 * trigger flags require additional inputs (Linear ticket and/or worktree).
 *
 * Uses the same fixed-position `<div role="dialog">` shape that
 * `ChainEditorModal` does — shadcn Dialog's Radix Portal isn't observable from
 * `renderToStaticMarkup` (Phase 5+7), so the test layer needs inline markup.
 */
export function RunNowConfirmModal(props: RunNowConfirmModalProps): React.JSX.Element | null {
  if (!props.open) {
    return null
  }
  return <RunNowConfirmModalBody {...props} />
}

function RunNowConfirmModalBody(props: RunNowConfirmModalProps): React.JSX.Element {
  const [pickedLinear, setPickedLinear] = useState<LinearIssuePayload | null>(null)
  const [pickedWorktreeId, setPickedWorktreeId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const needsLinear = !!props.automation.trigger?.acceptsLinearTicket
  const needsWorktree = !!props.automation.trigger?.acceptsWorktreeSelection
  const canRun =
    (!needsLinear || pickedLinear !== null) &&
    (!needsWorktree || pickedWorktreeId !== null) &&
    !running

  const handleRun = async (): Promise<void> => {
    if (!canRun) {
      return
    }
    setRunning(true)
    try {
      const payload: RunNowPayload = {}
      if (pickedLinear) {
        payload.linear = { issue: pickedLinear }
      }
      if (pickedWorktreeId) {
        payload.worktreeId = pickedWorktreeId
      }
      await props.onRun(payload)
      props.onClose()
    } finally {
      setRunning(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Confirm run"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    >
      <div className="bg-background rounded-lg shadow-xl border border-border w-[600px] max-w-[90vw] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 flex-col">
            <h2 className="truncate text-sm font-semibold">Run now</h2>
            <p className="truncate text-xs text-muted-foreground">{props.automation.name}</p>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
          {needsLinear ? (
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-foreground">Linear ticket</h3>
              {pickedLinear ? (
                <div className="flex items-center justify-between gap-2 rounded-md border border-input bg-muted/30 px-2 py-1.5 text-xs">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="font-mono text-muted-foreground">
                      {pickedLinear.identifier}
                    </span>
                    <span className="truncate font-medium text-foreground">
                      {pickedLinear.title}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setPickedLinear(null)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    Change
                  </button>
                </div>
              ) : (
                <LinearIssuePicker onSelect={(issue) => setPickedLinear(issue)} />
              )}
            </section>
          ) : null}

          {needsWorktree ? (
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-foreground">Worktree</h3>
              {pickedWorktreeId ? (
                <div className="flex items-center justify-between gap-2 rounded-md border border-input bg-muted/30 px-2 py-1.5 text-xs">
                  <span className="truncate text-foreground">{pickedWorktreeId}</span>
                  <button
                    type="button"
                    onClick={() => setPickedWorktreeId(null)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    Change
                  </button>
                </div>
              ) : (
                <WorktreePicker
                  projectId={props.automation.projectId}
                  onSelect={(id) => setPickedWorktreeId(id)}
                />
              )}
            </section>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/20 px-4 py-3">
          <Button variant="outline" size="sm" aria-label="Cancel run" onClick={props.onClose}>
            Cancel
          </Button>
          <Button size="sm" aria-label="Run" disabled={!canRun} onClick={() => void handleRun()}>
            {running ? 'Running…' : 'Run'}
          </Button>
        </div>
      </div>
    </div>
  )
}
