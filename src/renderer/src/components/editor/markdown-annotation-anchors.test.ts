// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  anchorFromRange,
  bodyTextOffsets,
  findLineHintForQuote,
  rangeFromAnchor
} from './markdown-annotation-anchors'

function makeBody(html: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'markdown-body'
  el.innerHTML = html
  return el
}

describe('findLineHintForQuote', () => {
  it('returns the 1-based line of the first occurrence', () => {
    const content = 'line one\nthe quote here\nline three'
    expect(findLineHintForQuote(content, 'quote here')).toBe(2)
  })

  it('collapses internal whitespace when matching across wrapped lines', () => {
    const content = 'alpha beta\ngamma delta'
    expect(findLineHintForQuote(content, 'beta gamma')).toBe(1)
  })

  it('returns null when the quote is not found', () => {
    expect(findLineHintForQuote('nothing here', 'absent')).toBeNull()
  })
})

describe('anchor offsets round-trip', () => {
  it('builds an anchor from a range and rebuilds the same range', () => {
    const body = makeBody('<p>Hello brave world</p>')
    const textNode = body.querySelector('p')!.firstChild as Text
    const range = document.createRange()
    range.setStart(textNode, 6) // before "brave"
    range.setEnd(textNode, 11) // after "brave"

    const anchor = anchorFromRange(body, range, 'Hello brave world', () => null)
    expect(anchor).toMatchObject({ startOffset: 6, endOffset: 11, quote: 'brave' })

    const rebuilt = rangeFromAnchor(body, anchor!)
    expect(rebuilt?.toString()).toBe('brave')
  })

  it('resolves a triple-click selection whose end boundary is an element', () => {
    // Why: triple-click selects the whole line; the browser ends the range on the
    // <p> element (after its text child), not a text node.
    const body = makeBody('<p>Hello brave world</p>')
    const p = body.querySelector('p')!
    const range = document.createRange()
    range.setStart(p.firstChild!, 0)
    range.setEnd(p, p.childNodes.length)

    const anchor = anchorFromRange(body, range, 'Hello brave world', () => null)
    expect(anchor).toMatchObject({ startOffset: 0, endOffset: 17, quote: 'Hello brave world' })
  })

  it('resolves a selection whose boundaries are both element nodes', () => {
    const body = makeBody('<p>one two</p><p>three four</p>')
    const range = document.createRange()
    range.setStart(body, 0)
    range.setEnd(body, body.childNodes.length)

    const anchor = anchorFromRange(body, range, 'one two\nthree four', () => null)
    expect(anchor).toMatchObject({ startOffset: 0, endOffset: 17, quote: 'one twothree four' })
  })

  it('spans multiple block elements', () => {
    const body = makeBody('<p>one two</p><p>three four</p>')
    const offsets = bodyTextOffsets(body)
    expect(offsets.text).toBe('one twothree four')
  })

  it('falls back to a quote search when offsets no longer match', () => {
    const body = makeBody('<p>shifted prefix brave world</p>')
    const anchor = { startOffset: 6, endOffset: 11, quote: 'brave', lineHint: null }
    const rebuilt = rangeFromAnchor(body, anchor)
    expect(rebuilt?.toString()).toBe('brave')
  })

  it('returns null when the quote is gone entirely', () => {
    const body = makeBody('<p>completely different</p>')
    const anchor = { startOffset: 0, endOffset: 5, quote: 'brave', lineHint: null }
    expect(rangeFromAnchor(body, anchor)).toBeNull()
  })
})
