import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import SegmentedRepoTabs, { type RepoSegment, type RepoSegmentStatus } from './SegmentedRepoTabs'

// Why: tests run in the `node` env (see config/vitest.config.ts), so we use
// renderToStaticMarkup for HTML assertions and direct component invocation
// (calling the function with props) to grab the React element tree for
// click-handler wiring tests.

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  cb(element)
  if (element.props?.children) {
    visit(element.props.children, cb)
  }
}

function findAllSegmentButtons(node: unknown): ReactElementLike[] {
  const found: ReactElementLike[] = []
  visit(node, (entry) => {
    if (entry.props?.role === 'tab') {
      found.push(entry)
    }
  })
  return found
}

const SEGMENTS: RepoSegment[] = [
  { repoId: 'repo-a', repoName: 'repo-a', status: 'idle' },
  { repoId: 'repo-b', repoName: 'repo-b', status: 'running' },
  { repoId: 'repo-c', repoName: 'repo-c', status: 'failed' },
  { repoId: 'repo-d', repoName: 'repo-d', status: 'done' }
]

describe('SegmentedRepoTabs', () => {
  it('renders one segment per entry', () => {
    const element = SegmentedRepoTabs({
      segments: SEGMENTS,
      activeRepoId: 'repo-a',
      onSelect: () => {}
    })
    const buttons = findAllSegmentButtons(element)
    expect(buttons).toHaveLength(SEGMENTS.length)
    const html = renderToStaticMarkup(element)
    for (const segment of SEGMENTS) {
      expect(html).toContain(segment.repoName)
    }
  })

  it('marks the active segment with aria-selected=true and only that one', () => {
    const element = SegmentedRepoTabs({
      segments: SEGMENTS,
      activeRepoId: 'repo-c',
      onSelect: () => {}
    })
    const buttons = findAllSegmentButtons(element)
    const active = buttons.filter((b) => b.props['aria-selected'] === true)
    expect(active).toHaveLength(1)
    expect(active[0].props['data-repo-id']).toBe('repo-c')
  })

  it('fires onSelect with the clicked repoId', () => {
    const onSelect = vi.fn()
    const element = SegmentedRepoTabs({
      segments: SEGMENTS,
      activeRepoId: 'repo-a',
      onSelect
    })
    const buttons = findAllSegmentButtons(element)
    const target = buttons.find((b) => b.props['data-repo-id'] === 'repo-b')
    if (!target) {
      throw new Error('expected to find repo-b segment')
    }
    ;(target.props.onClick as () => void)()
    expect(onSelect).toHaveBeenCalledOnce()
    expect(onSelect).toHaveBeenCalledWith('repo-b')
  })

  it('renders a distinct status indicator for each status value', () => {
    const element = SegmentedRepoTabs({
      segments: SEGMENTS,
      activeRepoId: 'repo-a',
      onSelect: () => {}
    })
    const html = renderToStaticMarkup(element)
    // Each status should produce a data-status attribute on its indicator.
    const expected: RepoSegmentStatus[] = ['idle', 'running', 'failed', 'done']
    for (const status of expected) {
      expect(html).toMatch(new RegExp(`data-status="${status}"`))
    }
  })
})
