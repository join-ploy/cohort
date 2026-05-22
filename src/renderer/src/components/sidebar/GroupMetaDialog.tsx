import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// Why: groups share the same rename/comment surface affordances as worktrees
// but their persisted fields are narrower (no PR/issue links yet), so a
// dedicated dialog keeps the form trimmed instead of pretending an irrelevant
// row away. Mirrors WorktreeMetaDialog's open/close/auto-focus shape so the
// keyboard flow feels identical between single and group rename.
const GroupMetaDialog = React.memo(function GroupMetaDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const updateWorkspaceGroup = useAppStore((s) => s.updateWorkspaceGroup)

  const isOpen = activeModal === 'edit-group-meta'

  const groupId = typeof modalData.groupId === 'string' ? modalData.groupId : ''
  const currentDisplayName =
    typeof modalData.currentDisplayName === 'string' ? modalData.currentDisplayName : ''
  const currentComment =
    typeof modalData.currentComment === 'string' ? modalData.currentComment : ''
  const focusField = typeof modalData.focus === 'string' ? modalData.focus : 'displayName'

  const [displayNameInput, setDisplayNameInput] = useState('')
  const [commentInput, setCommentInput] = useState('')
  const [saving, setSaving] = useState(false)
  const isMac = navigator.userAgent.includes('Mac')

  const displayNameInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const prevIsOpenRef = useRef(false)
  if (isOpen && !prevIsOpenRef.current) {
    setDisplayNameInput(currentDisplayName)
    setCommentInput(currentComment)
  }
  prevIsOpenRef.current = isOpen

  // Why: auto-grow the comment textarea up to its max-h so short comments stay
  // compact while longer ones aren't shoved into a scroller until really long.
  const autoResize = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) {
      return
    }
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }, [])

  useEffect(() => {
    if (isOpen) {
      autoResize()
    }
  }, [isOpen, commentInput, autoResize])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeModal()
      }
    },
    [closeModal]
  )

  const canSave = groupId !== '' && displayNameInput.trim().length > 0

  const handleSave = useCallback(async () => {
    if (!canSave) {
      return
    }
    setSaving(true)
    try {
      await updateWorkspaceGroup(groupId, {
        displayName: displayNameInput.trim(),
        comment: commentInput
      })
      closeModal()
    } finally {
      setSaving(false)
    }
  }, [canSave, closeModal, commentInput, displayNameInput, groupId, updateWorkspaceGroup])

  const handleDisplayNameKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void handleSave()
      }
    },
    [handleSave]
  )

  const handleCommentKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
        e.preventDefault()
        e.stopPropagation()
        void handleSave()
      }
    },
    [handleSave]
  )

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-md"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          if (focusField === 'comment') {
            textareaRef.current?.focus()
          } else {
            displayNameInputRef.current?.focus()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">Edit Group Details</DialogTitle>
          <DialogDescription className="text-xs">
            Edit the group&apos;s display name and notes. The on-disk folder is not changed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">Display Name</label>
            <Input
              ref={displayNameInputRef}
              value={displayNameInput}
              onChange={(e) => setDisplayNameInput(e.target.value)}
              onKeyDown={handleDisplayNameKeyDown}
              placeholder="Group display name..."
              className="h-8 text-xs"
            />
            <p className="text-[10px] text-muted-foreground">
              Only changes the name shown in the sidebar — the workspaces folder on disk stays the
              same.
            </p>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">Comment</label>
            <textarea
              ref={textareaRef}
              value={commentInput}
              onChange={(e) => setCommentInput(e.target.value)}
              onKeyDown={handleCommentKeyDown}
              placeholder="Notes about this group..."
              rows={3}
              className="w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 resize-none max-h-60 overflow-y-auto"
            />
            <p className="text-[10px] text-muted-foreground">
              Supports **markdown**. Press Enter or {isMac ? 'Cmd' : 'Ctrl'}+Enter to save,
              Shift+Enter for a new line.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenChange(false)}
            className="text-xs"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void handleSave()}
            disabled={!canSave || saving}
            className="text-xs"
          >
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default GroupMetaDialog
