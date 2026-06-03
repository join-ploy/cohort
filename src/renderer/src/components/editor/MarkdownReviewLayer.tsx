import React, { lazy, useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { MessageSquarePlus } from 'lucide-react'
import { useAppStore } from '@/store'
import type { DraftReview, ReviewAnchor } from '@/store/slices/markdown-review'
import { ReviewCommentRail } from './ReviewCommentRail'
import { SelectAgentPaneDialog } from './SelectAgentPaneDialog'
import { useSubmitMarkdownReview } from './useSubmitMarkdownReview'
import {
  anchorFromRange,
  commentIdAtPoint,
  findLineHintForQuote
} from './markdown-annotation-anchors'
import { paintReviewHighlights, clearReviewHighlights } from './markdown-annotation-highlights'
import type { MarkdownDocument } from '../../../../shared/types'

const MarkdownPreview = lazy(() => import('./MarkdownPreview'))

// Why: a stable empty-draft reference for files with no draft yet, so the
// highlight effect's `draft.comments` dependency doesn't churn every render.
const EMPTY_DRAFT: DraftReview = { overallNote: '', comments: [] }

type PopoverState = { x: number; y: number; anchor: ReviewAnchor } | null

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
  const popoverRef = useRef<HTMLDivElement>(null)
  // Why: the live selection Range whose rect the popover sits beside. Held in a
  // ref so scroll repositioning can read its rect without re-rendering.
  const popoverRangeRef = useRef<Range | null>(null)
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

  // Why: the popover sits in the wrapper's coordinate space and is fixed at mouseup,
  // so scrolling the preview would leave it behind while the selected text moves.
  // Repositioning via React state stutters (renders lag behind native scroll), so
  // write the button's position directly from the selection's live rect instead —
  // it then tracks the text smoothly, frame for frame. Capture-phase + passive so
  // the nested preview scroller is caught without blocking the scroll.
  useEffect(() => {
    if (!popover) {
      return
    }
    const reposition = (): void => {
      const el = popoverRef.current
      const wrapper = wrapperRef.current
      const range = popoverRangeRef.current
      if (!el || !wrapper || !range) {
        return
      }
      const rect = range.getBoundingClientRect()
      const wrapperRect = wrapper.getBoundingClientRect()
      el.style.left = `${rect.left - wrapperRect.left}px`
      el.style.top = `${rect.bottom - wrapperRect.top + 4}px`
    }
    window.addEventListener('scroll', reposition, { capture: true, passive: true })
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, { capture: true })
      window.removeEventListener('resize', reposition)
    }
  }, [popover])

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
    // Why: resolve the anchor now, while the selection is provably valid. The
    // browser can drop the live selection between this mouseup and the user
    // clicking "Add comment" (e.g. deleting a card shifts focus first), so
    // re-reading it at click time silently failed to create the comment.
    const anchor = anchorFromRange(body, range, content, (quote) =>
      findLineHintForQuote(content, quote)
    )
    if (!anchor) {
      setPopover(null)
      return
    }
    // Why: clone so the stored range survives selection.removeAllRanges() / a new
    // selection — scroll repositioning reads its rect after the popover is shown.
    popoverRangeRef.current = range.cloneRange()
    const rect = range.getBoundingClientRect()
    const wrapperRect = wrapperRef.current.getBoundingClientRect()
    setPopover({ x: rect.left - wrapperRect.left, y: rect.bottom - wrapperRect.top, anchor })
  }, [getBody, content])

  const handleAddComment = useCallback(() => {
    if (!popover) {
      return
    }
    const id = addReviewComment(filePath, popover.anchor, '')
    setActiveCommentId(id)
    setPopover(null)
    window.getSelection()?.removeAllRanges()
  }, [addReviewComment, filePath, popover])

  const handleSelectCommentAtPoint = useCallback(
    (event: React.MouseEvent) => {
      // Why: a drag-select is a new-comment gesture (handled on mouseup), so only
      // treat a plain click (collapsed selection) as "select the comment here".
      const selection = window.getSelection()
      if (selection && !selection.isCollapsed) {
        return
      }
      const body = getBody()
      if (!body) {
        return
      }
      const id = commentIdAtPoint(body, draft.comments, event.clientX, event.clientY)
      if (id) {
        setActiveCommentId(id)
      }
    },
    [draft.comments, getBody]
  )

  return (
    <div className="flex h-full min-h-0">
      <div
        ref={wrapperRef}
        className="relative min-w-0 flex-1"
        onMouseUp={handleMouseUp}
        onClick={handleSelectCommentAtPoint}
      >
        <MarkdownPreview
          content={content}
          filePath={filePath}
          scrollCacheKey={scrollCacheKey}
          markdownDocuments={markdownDocuments}
          onOpenDocument={onOpenDocument}
        />
        {popover && (
          <div
            ref={popoverRef}
            className="absolute z-10"
            style={{ left: popover.x, top: popover.y + 4 }}
          >
            <Button
              type="button"
              size="sm"
              // Why: stopPropagation keeps the button's own mouseup/click from
              // bubbling to the wrapper's handleMouseUp / handleSelectCommentAtPoint,
              // which would re-read the (now possibly empty) selection and clear the
              // popover before the click lands. preventDefault keeps focus/selection
              // from shifting on mousedown.
              onMouseDown={(e) => e.preventDefault()}
              onMouseUp={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                handleAddComment()
              }}
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
