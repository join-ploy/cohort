import { describe, expect, it } from 'vitest'
import { createTestStore } from './store-test-helpers'

const anchor = { startOffset: 0, endOffset: 5, quote: 'hello', lineHint: 1 }

describe('markdown-review slice', () => {
  it('starts with no draft for a file', () => {
    const store = createTestStore()
    expect(store.getState().markdownReviewDraftsByFilePath['/a.md']).toBeUndefined()
  })

  it('adds a comment and returns its id', () => {
    const store = createTestStore()
    const id = store.getState().addReviewComment('/a.md', anchor, 'needs work')
    const draft = store.getState().markdownReviewDraftsByFilePath['/a.md']
    expect(draft.comments).toHaveLength(1)
    expect(draft.comments[0]).toMatchObject({ id, anchor, body: 'needs work' })
    expect(draft.overallNote).toBe('')
  })

  it('updates and removes a comment', () => {
    const store = createTestStore()
    const id = store.getState().addReviewComment('/a.md', anchor, '')
    store.getState().updateReviewCommentBody('/a.md', id, 'fixed body')
    expect(store.getState().markdownReviewDraftsByFilePath['/a.md'].comments[0].body).toBe(
      'fixed body'
    )
    store.getState().removeReviewComment('/a.md', id)
    expect(store.getState().markdownReviewDraftsByFilePath['/a.md'].comments).toHaveLength(0)
  })

  it('sets the overall note', () => {
    const store = createTestStore()
    store.getState().setReviewOverallNote('/a.md', 'overall feedback')
    expect(store.getState().markdownReviewDraftsByFilePath['/a.md'].overallNote).toBe(
      'overall feedback'
    )
  })

  it('clears the whole draft for a file', () => {
    const store = createTestStore()
    store.getState().addReviewComment('/a.md', anchor, 'x')
    store.getState().clearReview('/a.md')
    expect(store.getState().markdownReviewDraftsByFilePath['/a.md']).toBeUndefined()
  })
})
