import { describe, expect, it } from 'vitest'
import { compileMarkdownReview } from './compile-markdown-review'
import type { DraftReview } from '@/store/slices/markdown-review'

function comment(quote: string, body: string, lineHint: number | null) {
  return { id: quote, anchor: { startOffset: 0, endOffset: 0, quote, lineHint }, body }
}

describe('compileMarkdownReview', () => {
  it('includes overall note and numbered comments with line hints', () => {
    const draft: DraftReview = {
      overallNote: 'Good structure overall.',
      comments: [comment('first passage', "this isn't right", 12), comment('second', 'good', 40)]
    }
    const out = compileMarkdownReview('docs/plan.md', draft)
    expect(out).toContain('`docs/plan.md`')
    expect(out).toContain('## Overall')
    expect(out).toContain('Good structure overall.')
    expect(out).toContain('1. On "first passage" (~line 12):')
    expect(out).toContain("   this isn't right")
    expect(out).toContain('2. On "second" (~line 40):')
  })

  it('omits the Overall section when the note is blank', () => {
    const draft: DraftReview = { overallNote: '   ', comments: [comment('x', 'y', 1)] }
    expect(compileMarkdownReview('a.md', draft)).not.toContain('## Overall')
  })

  it('omits the line hint when null', () => {
    const draft: DraftReview = { overallNote: '', comments: [comment('q', 'b', null)] }
    expect(compileMarkdownReview('a.md', draft)).toContain('1. On "q":')
  })

  it('returns null when there is nothing to submit', () => {
    expect(compileMarkdownReview('a.md', { overallNote: '', comments: [] })).toBeNull()
    expect(compileMarkdownReview('a.md', { overallNote: '  ', comments: [] })).toBeNull()
  })

  it('skips comments whose body is blank', () => {
    const draft: DraftReview = {
      overallNote: '',
      comments: [comment('kept', 'real', 1), comment('dropped', '   ', 2)]
    }
    const out = compileMarkdownReview('a.md', draft)
    expect(out).toContain('"kept"')
    expect(out).not.toContain('"dropped"')
  })
})
