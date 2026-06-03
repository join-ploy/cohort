import type { ReviewAnchor, ReviewComment } from '@/store/slices/markdown-review'

type BodyOffsets = {
  text: string
  nodes: { node: Text; start: number; end: number }[]
}

function collectTextNodes(body: HTMLElement): Text[] {
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let current = walker.nextNode()
  while (current) {
    if (current instanceof Text) {
      nodes.push(current)
    }
    current = walker.nextNode()
  }
  return nodes
}

export function bodyTextOffsets(body: HTMLElement): BodyOffsets {
  const nodes: BodyOffsets['nodes'] = []
  let text = ''
  for (const node of collectTextNodes(body)) {
    const value = node.textContent ?? ''
    nodes.push({ node, start: text.length, end: text.length + value.length })
    text += value
  }
  return { text, nodes }
}

function offsetForBoundary(
  offsets: BodyOffsets,
  container: Node,
  containerOffset: number
): number | null {
  for (const entry of offsets.nodes) {
    if (entry.node === container) {
      return entry.start + containerOffset
    }
  }
  return null
}

export function anchorFromRange(
  body: HTMLElement,
  range: Range,
  _sourceContent: string,
  lineHintFor: (quote: string) => number | null
): ReviewAnchor | null {
  const offsets = bodyTextOffsets(body)
  const startOffset = offsetForBoundary(offsets, range.startContainer, range.startOffset)
  const endOffset = offsetForBoundary(offsets, range.endContainer, range.endOffset)
  if (startOffset === null || endOffset === null || endOffset <= startOffset) {
    return null
  }
  const quote = offsets.text.slice(startOffset, endOffset)
  if (quote.trim().length === 0) {
    return null
  }
  return { startOffset, endOffset, quote, lineHint: lineHintFor(quote) }
}

function rangeForTextSpan(offsets: BodyOffsets, start: number, end: number): Range | null {
  let startNode: Text | null = null
  let startNodeOffset = 0
  let endNode: Text | null = null
  let endNodeOffset = 0
  for (const entry of offsets.nodes) {
    if (startNode === null && start >= entry.start && start < entry.end) {
      startNode = entry.node
      startNodeOffset = start - entry.start
    }
    if (end > entry.start && end <= entry.end) {
      endNode = entry.node
      endNodeOffset = end - entry.start
    }
  }
  if (!startNode || !endNode) {
    return null
  }
  const range = document.createRange()
  range.setStart(startNode, startNodeOffset)
  range.setEnd(endNode, endNodeOffset)
  return range
}

export function rangeFromAnchor(body: HTMLElement, anchor: ReviewAnchor): Range | null {
  const offsets = bodyTextOffsets(body)
  const atOffset = offsets.text.slice(anchor.startOffset, anchor.endOffset)
  if (atOffset === anchor.quote) {
    return rangeForTextSpan(offsets, anchor.startOffset, anchor.endOffset)
  }
  const found = offsets.text.indexOf(anchor.quote)
  if (found === -1) {
    return null
  }
  return rangeForTextSpan(offsets, found, found + anchor.quote.length)
}

export function findLineHintForQuote(content: string, quote: string): number | null {
  const direct = content.indexOf(quote)
  if (direct !== -1) {
    return content.slice(0, direct).split('\n').length
  }
  const normalizedQuote = quote.replace(/\s+/g, ' ').trim()
  if (normalizedQuote.length === 0) {
    return null
  }
  const lines = content.split('\n')
  const collapsed = lines.map((l) => l.replace(/\s+/g, ' ').trim())
  const joined = collapsed.join(' ')
  const idx = joined.indexOf(normalizedQuote)
  if (idx === -1) {
    return null
  }
  let consumed = 0
  for (let i = 0; i < collapsed.length; i += 1) {
    consumed += collapsed[i].length + (i > 0 ? 1 : 0)
    if (consumed > idx) {
      return i + 1
    }
  }
  return null
}

/**
 * Hit-test a viewport point against the rendered ranges of each comment. Tests
 * the actual painted rects (via the same `rangeFromAnchor` the highlighter uses)
 * so a click reliably maps to the highlight under the cursor. Iterates in
 * reverse so the most recently added comment wins where highlights overlap.
 */
export function commentIdAtPoint(
  body: HTMLElement,
  comments: ReviewComment[],
  clientX: number,
  clientY: number
): string | null {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const range = rangeFromAnchor(body, comments[i].anchor)
    if (!range) {
      continue
    }
    for (const rect of range.getClientRects()) {
      if (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      ) {
        return comments[i].id
      }
    }
  }
  return null
}
