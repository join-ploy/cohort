import type { DraftReview } from '@/store/slices/markdown-review'

export function compileMarkdownReview(relativePath: string, draft: DraftReview): string | null {
  const overall = draft.overallNote.trim()
  const comments = draft.comments.filter((c) => c.body.trim().length > 0)

  if (overall.length === 0 && comments.length === 0) {
    return null
  }

  const lines: string[] = [
    `I've reviewed \`${relativePath}\` and left feedback inline. Please take it on board and revise the document accordingly.`
  ]

  if (overall.length > 0) {
    lines.push('', '## Overall', overall)
  }

  if (comments.length > 0) {
    lines.push('', '## Comments')
    comments.forEach((c, index) => {
      const quote = c.anchor.quote.trim()
      const header =
        c.anchor.lineHint !== null
          ? `${index + 1}. On "${quote}" (~line ${c.anchor.lineHint}):`
          : `${index + 1}. On "${quote}":`
      lines.push(header)
      for (const bodyLine of c.body.trim().split('\n')) {
        lines.push(`   ${bodyLine}`)
      }
      lines.push('')
    })
  }

  return lines.join('\n').trimEnd()
}
