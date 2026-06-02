import type { ReviewComment } from '@/store/slices/markdown-review'
import { rangeFromAnchor } from './markdown-annotation-anchors'

const HIGHLIGHT_NAME = 'markdown-review-comment'
const ACTIVE_HIGHLIGHT_NAME = 'markdown-review-comment-active'

// Why: the CSS Custom Highlight API may be absent in non-Chromium test/SSR
// contexts. Guard so importing this module never throws there.
function highlightsSupported(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'
}

/**
 * Repaint review highlights over the preview body. Ranges are derived fresh
 * from each comment's anchor so a re-render of the markdown body can't leave
 * stale Range objects behind. The `activeCommentId` range is painted into a
 * second, emphasised highlight layer.
 */
export function paintReviewHighlights(
  body: HTMLElement,
  comments: ReviewComment[],
  activeCommentId: string | null
): void {
  if (!highlightsSupported()) {
    return
  }
  const base = new Highlight()
  const active = new Highlight()
  for (const comment of comments) {
    const range = rangeFromAnchor(body, comment.anchor)
    if (!range) {
      continue
    }
    if (comment.id === activeCommentId) {
      active.add(range)
    } else {
      base.add(range)
    }
  }
  CSS.highlights.set(HIGHLIGHT_NAME, base)
  CSS.highlights.set(ACTIVE_HIGHLIGHT_NAME, active)
}

export function clearReviewHighlights(): void {
  if (!highlightsSupported()) {
    return
  }
  CSS.highlights.delete(HIGHLIGHT_NAME)
  CSS.highlights.delete(ACTIVE_HIGHLIGHT_NAME)
}
