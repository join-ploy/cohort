import React from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { ReviewTarget } from './markdown-review-target'

export function SelectAgentPaneDialog({
  open,
  targets,
  onPick,
  onCancel
}: {
  open: boolean
  targets: ReviewTarget[]
  onPick: (tabId: string) => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onCancel() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send review to which agent?</DialogTitle>
          <DialogDescription>
            More than one agent is running in this worktree. Choose where to send your review.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {targets.map((target) => (
            <Button
              key={target.tabId}
              variant="outline"
              className="justify-start"
              onClick={() => onPick(target.tabId)}
            >
              {target.label}
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
