import React from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ReviewComment } from '@/store/slices/markdown-review'

export function ReviewCommentCard({
  comment,
  index,
  isActive,
  onFocus,
  onChangeBody,
  onRemove
}: {
  comment: ReviewComment
  index: number
  isActive: boolean
  onFocus: () => void
  onChangeBody: (body: string) => void
  onRemove: () => void
}): React.JSX.Element {
  return (
    <div
      className={`rounded-md border p-2 text-xs ${
        isActive ? 'border-primary bg-accent/40' : 'border-border bg-background'
      }`}
      onClick={onFocus}
    >
      <div className="mb-1 flex items-start justify-between gap-2">
        <span className="font-medium text-muted-foreground">#{index + 1}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Delete comment"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
        >
          <X size={12} />
        </Button>
      </div>
      <blockquote className="mb-2 border-l-2 border-border pl-2 italic text-muted-foreground line-clamp-3">
        {comment.anchor.quote}
      </blockquote>
      <textarea
        className="w-full resize-y rounded border border-border bg-background p-1.5 text-xs outline-none focus:border-primary"
        rows={2}
        placeholder="Your comment…"
        value={comment.body}
        onChange={(e) => onChangeBody(e.target.value)}
        onFocus={onFocus}
      />
    </div>
  )
}
