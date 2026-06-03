import React from 'react'
import { Button } from '@/components/ui/button'
import { ReviewCommentCard } from './ReviewCommentCard'
import type { DraftReview } from '@/store/slices/markdown-review'

export function ReviewCommentRail({
  draft,
  activeCommentId,
  onOverallNoteChange,
  onCommentFocus,
  onCommentBodyChange,
  onCommentRemove,
  onSubmit
}: {
  draft: DraftReview
  activeCommentId: string | null
  onOverallNoteChange: (note: string) => void
  onCommentFocus: (commentId: string) => void
  onCommentBodyChange: (commentId: string, body: string) => void
  onCommentRemove: (commentId: string) => void
  onSubmit: () => void
}): React.JSX.Element {
  const submittableCount =
    draft.comments.filter((c) => c.body.trim().length > 0).length +
    (draft.overallNote.trim().length > 0 ? 1 : 0)

  return (
    <div className="flex h-full w-72 flex-shrink-0 flex-col border-l border-border bg-editor-surface">
      <div className="border-b border-border p-2">
        <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Overall
        </label>
        <textarea
          className="w-full resize-y rounded border border-border bg-background p-1.5 text-xs outline-none focus:border-primary"
          rows={3}
          placeholder="Overall feedback (optional)…"
          value={draft.overallNote}
          onChange={(e) => onOverallNoteChange(e.target.value)}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2 scrollbar-editor">
        {draft.comments.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">
            Select text in the document to add a comment.
          </p>
        ) : (
          draft.comments.map((comment, index) => (
            <ReviewCommentCard
              key={comment.id}
              comment={comment}
              index={index}
              isActive={comment.id === activeCommentId}
              onFocus={() => onCommentFocus(comment.id)}
              onChangeBody={(body) => onCommentBodyChange(comment.id, body)}
              onRemove={() => onCommentRemove(comment.id)}
            />
          ))
        )}
      </div>
      <div className="border-t border-border p-2">
        <Button
          type="button"
          className="w-full"
          size="sm"
          disabled={submittableCount === 0}
          onClick={onSubmit}
        >
          Submit review{submittableCount > 0 ? ` (${submittableCount})` : ''}
        </Button>
      </div>
    </div>
  )
}
