// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

// Why: jsdom doesn't implement Range.getBoundingClientRect / getClientRects, which
// handleMouseUp (popover placement) and the highlight hit-test rely on. Stub them
// to a controllable rect so the selection → popover flow runs as it does in
// Chromium and a test can simulate the selected text moving as the preview scrolls.
const mockRangeRect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }
if (typeof Range !== 'undefined') {
  Range.prototype.getBoundingClientRect = () =>
    ({
      ...mockRangeRect,
      x: mockRangeRect.left,
      y: mockRangeRect.top,
      toJSON: () => ({})
    }) as DOMRect
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList
}
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {}
}

// Why: a minimal real store backed by the markdown-review slice so addReviewComment /
// removeReviewComment actually mutate state and re-render the layer — a static mock
// can't exercise the add → delete → re-add flow. Built inside the factory (which is
// hoisted) and read back via the mocked useAppStore's getState/setState.
vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  const { createMarkdownReviewSlice } = await import('@/store/slices/markdown-review')
  const useAppStore = create((set, get, api) => ({
    ...createMarkdownReviewSlice(set as never, get as never, api as never)
  }))
  return { useAppStore }
})

// Why: the layer lazy-loads MarkdownPreview (mermaid/react-markdown chain) and
// the submit hook reaches for window.api/sonner. Stub both so the test stays on
// the selection → comment interaction. The preview just needs a `.markdown-body`
// with real text nodes for anchor offsets to resolve against.
vi.mock('./MarkdownPreview', () => ({
  default: () => (
    <div className="markdown-body">
      <p>Hello brave world</p>
    </div>
  )
}))
vi.mock('./useSubmitMarkdownReview', () => ({
  useSubmitMarkdownReview: () => ({
    submit: vi.fn(),
    pickerTargets: null,
    pickTarget: vi.fn(),
    cancelPicker: vi.fn()
  })
}))
vi.mock('./SelectAgentPaneDialog', () => ({ SelectAgentPaneDialog: () => null }))

import { useAppStore } from '@/store'
import { MarkdownReviewLayer } from './MarkdownReviewLayer'

const FILE_PATH = '/repo/docs/notes.md'
const CONTENT = 'Hello brave world'

// Why: a controllable selection over "brave" backed by a mutable range list so a
// test can simulate the browser dropping the selection between mouseup and click.
function installSelection(container: HTMLElement): { select: () => void; collapse: () => void } {
  const body = container.querySelector('.markdown-body') as HTMLElement
  const textNode = body.querySelector('p')!.firstChild as Text
  let ranges: Range[] = []
  vi.spyOn(window, 'getSelection').mockReturnValue({
    get rangeCount() {
      return ranges.length
    },
    get isCollapsed() {
      return ranges.length === 0
    },
    getRangeAt: () => ranges[0],
    removeAllRanges: () => {
      ranges = []
    }
  } as unknown as Selection)
  const makeRange = (): Range => {
    const r = document.createRange()
    r.setStart(textNode, 6) // before "brave"
    r.setEnd(textNode, 11) // after "brave"
    return r
  }
  return {
    select: () => {
      ranges = [makeRange()]
    },
    collapse: () => {
      ranges = []
    }
  }
}

function wrapper(container: HTMLElement): HTMLElement {
  return container.querySelector('.markdown-body')!.parentElement as HTMLElement
}

function clickAddComment(): void {
  const btn = screen.getByText('Add comment')
  // Why: a real click is mousedown → mouseup → click; the mouseup bubbles back to
  // the wrapper, so the flow must survive it.
  fireEvent.mouseDown(btn)
  fireEvent.mouseUp(btn)
  fireEvent.click(btn)
}

function comments(): unknown[] {
  return useAppStore.getState().markdownReviewDraftsByFilePath[FILE_PATH]?.comments ?? []
}

function renderLayer(): ReturnType<typeof render> {
  return render(
    <MarkdownReviewLayer
      content={CONTENT}
      filePath={FILE_PATH}
      relativePath="docs/notes.md"
      worktreeId="wt-1"
      scrollCacheKey="k"
    />
  )
}

describe('MarkdownReviewLayer add/delete/re-add', () => {
  beforeEach(() => {
    useAppStore.setState({ markdownReviewDraftsByFilePath: {} })
    Object.assign(mockRangeRect, { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('creates a comment from a selection', async () => {
    const { container } = renderLayer()
    await screen.findByText('Hello brave world')
    const sel = installSelection(container)
    sel.select()
    fireEvent.mouseUp(wrapper(container))
    clickAddComment()
    expect(comments()).toHaveLength(1)
  })

  it('shows the Add comment button for a triple-click selection (element end boundary)', async () => {
    const { container } = renderLayer()
    await screen.findByText('Hello brave world')
    const body = container.querySelector('.markdown-body') as HTMLElement
    const p = body.querySelector('p')!
    // Triple-click selects the line and ends the range on the <p>, not a text node.
    const range = document.createRange()
    range.setStart(p.firstChild!, 0)
    range.setEnd(p, p.childNodes.length)
    vi.spyOn(window, 'getSelection').mockReturnValue({
      rangeCount: 1,
      isCollapsed: false,
      getRangeAt: () => range,
      removeAllRanges: () => {}
    } as unknown as Selection)
    fireEvent.mouseUp(wrapper(container))
    expect(screen.queryByText('Add comment')).not.toBeNull()
  })

  it('still creates the comment when the selection is dropped before clicking Add', async () => {
    // Why: after deleting a comment and re-selecting, the browser can drop the
    // live selection between the popover appearing (mouseup) and the click. The
    // anchor must be captured at mouseup so the click no longer depends on it.
    const { container } = renderLayer()
    await screen.findByText('Hello brave world')
    const sel = installSelection(container)
    sel.select()
    fireEvent.mouseUp(wrapper(container))
    sel.collapse()
    clickAddComment()
    expect(comments()).toHaveLength(1)
  })

  it('repositions the Add comment button when the preview scrolls', async () => {
    const { container } = renderLayer()
    await screen.findByText('Hello brave world')
    const sel = installSelection(container)
    sel.select()
    mockRangeRect.bottom = 100
    fireEvent.mouseUp(wrapper(container))
    const popoverEl = screen.getByText('Add comment').closest('div.absolute') as HTMLElement
    expect(popoverEl.style.top).toBe('104px') // bottom (100) + 4

    // The text scrolls up; the button must follow it.
    mockRangeRect.bottom = 40
    fireEvent.scroll(window)
    expect(popoverEl.style.top).toBe('44px')
  })

  it('lets you re-create a comment with the same selection after deleting one', async () => {
    const { container } = renderLayer()
    await screen.findByText('Hello brave world')
    const sel = installSelection(container)

    sel.select()
    fireEvent.mouseUp(wrapper(container))
    clickAddComment()
    expect(comments()).toHaveLength(1)

    fireEvent.click(screen.getByLabelText('Delete comment'))
    expect(comments()).toHaveLength(0)

    sel.select()
    fireEvent.mouseUp(wrapper(container))
    clickAddComment()
    expect(comments()).toHaveLength(1)
  })
})
