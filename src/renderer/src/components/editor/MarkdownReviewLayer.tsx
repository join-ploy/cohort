import React, { lazy, useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { MessageSquarePlus } from 'lucide-react'
import { useAppStore } from '@/store'
import type { DraftReview } from '@/store/slices/markdown-review'
import { ReviewCommentRail } from './ReviewCommentRail'
import { SelectAgentPaneDialog } from './SelectAgentPaneDialog'
import { useSubmitMarkdownReview } from './useSubmitMarkdownReview'
import { anchorFromRange, findLineHintForQuote } from './markdown-annotation-anchors'
import { paintReviewHighlights, clearReviewHighlights } from './markdown-annotation-highlights'
import type { MarkdownDocument } from '../../../../shared/types'

const MarkdownPreview = lazy(() => import('./MarkdownPreview'))

// Why: a stable empty-draft reference for files with no draft yet, so the
// highlight effect's `draft.comments` dependency doesn't churn every render.
const EMPTY_DRAFT: DraftReview = { overallNote: '', comments: [] }

type PopoverState = { x: number; y: number } | null

export function MarkdownReviewLayer({
  content,
  filePath,
  relativePath,
  worktreeId,
  scrollCacheKey,
  markdownDocuments,
  onOpenDocument
}: {
  content: string
  filePath: string
  relativePath: string
  worktreeId: string
  scrollCacheKey: string
  markdownDocuments?: MarkdownDocument[]
  onOpenDocument?: (document: MarkdownDocument) => void | Promise<void>
}): React.JSX.Element {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [popover, setPopover] = useState<PopoverState>(null)
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null)

  const draft = useAppStore((s) => s.markdownReviewDraftsByFilePath[filePath]) ?? EMPTY_DRAFT
  const addReviewComment = useAppStore((s) => s.addReviewComment)
  const updateReviewCommentBody = useAppStore((s) => s.updateReviewCommentBody)
  const removeReviewComment = useAppStore((s) => s.removeReviewComment)
  const setReviewOverallNote = useAppStore((s) => s.setReviewOverallNote)

  const { submit, pickerTargets, pickTarget, cancelPicker } = useSubmitMarkdownReview({
    filePath,
    relativePath,
    worktreeId
  })

  const getBody = useCallback(
    (): HTMLElement | null => wrapperRef.current?.querySelector('.markdown-body') ?? null,
    []
  )

  useEffect(() => {
    const body = getBody()
    if (!body) {
      return
    }
    paintReviewHighlights(body, draft.comments, activeCommentId)
    return () => clearReviewHighlights()
  }, [draft.comments, activeCommentId, content, getBody])

  // Why: a submit clears the whole draft, so drop a now-dangling active id
  // (it never matches a card, but keeping it would misfocus the next comment).
  useEffect(() => {
    if (activeCommentId && !draft.comments.some((c) => c.id === activeCommentId)) {
      setActiveCommentId(null)
    }
  }, [draft.comments, activeCommentId])

  const handleMouseUp = useCallback(() => {
    const selection = window.getSelection()
    const body = getBody()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !body) {
      setPopover(null)
      return
    }
    const range = selection.getRangeAt(0)
    if (!body.contains(range.commonAncestorContainer) || !wrapperRef.current) {
      setPopover(null)
      return
    }
    const rect = range.getBoundingClientRect()
    const wrapperRect = wrapperRef.current.getBoundingClientRect()
    setPopover({ x: rect.left - wrapperRect.left, y: rect.bottom - wrapperRect.top })
  }, [getBody])

  const handleAddComment = useCallback(() => {
    const selection = window.getSelection()
    const body = getBody()
    if (!selection || selection.rangeCount === 0 || !body) {
      return
    }
    const range = selection.getRangeAt(0)
    const anchor = anchorFromRange(body, range, content, (quote) =>
      findLineHintForQuote(content, quote)
    )
    if (!anchor) {
      setPopover(null)
      return
    }
    const id = addReviewComment(filePath, anchor, '')
    setActiveCommentId(id)
    setPopover(null)
    selection.removeAllRanges()
  }, [addReviewComment, content, filePath, getBody])

  return (
    <div className="flex h-full min-h-0">
      <div ref={wrapperRef} className="relative min-w-0 flex-1" onMouseUp={handleMouseUp}>
        <MarkdownPreview
          content={content}
          filePath={filePath}
          scrollCacheKey={scrollCacheKey}
          markdownDocuments={markdownDocuments}
          onOpenDocument={onOpenDocument}
        />
        {popover && (
          <div className="absolute z-10" style={{ left: popover.x, top: popover.y + 4 }}>
            <Button
              type="button"
              size="sm"
              // Why: preventDefault stops the click from collapsing the selection before handleAddComment reads it.
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleAddComment}
            >
              <MessageSquarePlus size={12} />
              Add comment
            </Button>
          </div>
        )}
      </div>
      <ReviewCommentRail
        draft={draft}
        activeCommentId={activeCommentId}
        onOverallNoteChange={(note) => setReviewOverallNote(filePath, note)}
        onCommentFocus={setActiveCommentId}
        onCommentBodyChange={(commentId, body) =>
          updateReviewCommentBody(filePath, commentId, body)
        }
        onCommentRemove={(commentId) => {
          removeReviewComment(filePath, commentId)
          setActiveCommentId((cur) => (cur === commentId ? null : cur))
        }}
        onSubmit={submit}
      />
      <SelectAgentPaneDialog
        open={pickerTargets !== null}
        targets={pickerTargets ?? []}
        onPick={pickTarget}
        onCancel={cancelPicker}
      />
    </div>
  )
}
