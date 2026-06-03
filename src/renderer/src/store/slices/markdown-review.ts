import type { StateCreator } from 'zustand'
import type { AppState } from '../types'

export type ReviewAnchor = {
  startOffset: number
  endOffset: number
  quote: string
  lineHint: number | null
}

export type ReviewComment = {
  id: string
  anchor: ReviewAnchor
  body: string
}

export type DraftReview = {
  overallNote: string
  comments: ReviewComment[]
}

export type MarkdownReviewSlice = {
  markdownReviewDraftsByFilePath: Record<string, DraftReview>
  addReviewComment: (filePath: string, anchor: ReviewAnchor, body: string) => string
  updateReviewCommentBody: (filePath: string, commentId: string, body: string) => void
  removeReviewComment: (filePath: string, commentId: string) => void
  setReviewOverallNote: (filePath: string, overallNote: string) => void
  clearReview: (filePath: string) => void
}

function emptyDraft(): DraftReview {
  return { overallNote: '', comments: [] }
}

let reviewCommentSeq = 0
function nextReviewCommentId(): string {
  reviewCommentSeq += 1
  return `review-comment-${reviewCommentSeq}`
}

export const createMarkdownReviewSlice: StateCreator<AppState, [], [], MarkdownReviewSlice> = (
  set
) => ({
  markdownReviewDraftsByFilePath: {},

  addReviewComment: (filePath, anchor, body) => {
    const id = nextReviewCommentId()
    set((s) => {
      const current = s.markdownReviewDraftsByFilePath[filePath] ?? emptyDraft()
      return {
        markdownReviewDraftsByFilePath: {
          ...s.markdownReviewDraftsByFilePath,
          [filePath]: { ...current, comments: [...current.comments, { id, anchor, body }] }
        }
      }
    })
    return id
  },

  updateReviewCommentBody: (filePath, commentId, body) =>
    set((s) => {
      const current = s.markdownReviewDraftsByFilePath[filePath]
      if (!current) {
        return s
      }
      return {
        markdownReviewDraftsByFilePath: {
          ...s.markdownReviewDraftsByFilePath,
          [filePath]: {
            ...current,
            comments: current.comments.map((c) => (c.id === commentId ? { ...c, body } : c))
          }
        }
      }
    }),

  removeReviewComment: (filePath, commentId) =>
    set((s) => {
      const current = s.markdownReviewDraftsByFilePath[filePath]
      if (!current) {
        return s
      }
      return {
        markdownReviewDraftsByFilePath: {
          ...s.markdownReviewDraftsByFilePath,
          [filePath]: {
            ...current,
            comments: current.comments.filter((c) => c.id !== commentId)
          }
        }
      }
    }),

  setReviewOverallNote: (filePath, overallNote) =>
    set((s) => {
      const current = s.markdownReviewDraftsByFilePath[filePath] ?? emptyDraft()
      return {
        markdownReviewDraftsByFilePath: {
          ...s.markdownReviewDraftsByFilePath,
          [filePath]: { ...current, overallNote }
        }
      }
    }),

  clearReview: (filePath) =>
    set((s) => {
      if (!(filePath in s.markdownReviewDraftsByFilePath)) {
        return s
      }
      const next = { ...s.markdownReviewDraftsByFilePath }
      delete next[filePath]
      return { markdownReviewDraftsByFilePath: next }
    })
})
