import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/types'

// Why: tests run in the `node` env (see config/vitest.config.ts) and the real
// FileExplorerInner pulls in xterm-free but still IPC-heavy hooks (file watch,
// tree readDir, undo history, etc.). We stub it with a marker element so the
// group-view tests can assert which worktreeId the inner pane is mounted with
// without booting the whole explorer subsystem.
vi.mock('./FileExplorer', () => ({
  FileExplorerInner: ({ worktreeId }: { worktreeId: string | null }) => (
    <div data-testid="file-explorer-inner" data-worktree-id={worktreeId ?? ''}>
      inner
    </div>
  ),
  default: () => null
}))

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
  // Why: expand function-component children so SegmentedRepoTabs renders its
  // own <button> tree the assertions need to inspect. Mirrors SetupPanel.test.
  if (typeof element.type === 'function') {
    try {
      const expanded = (element.type as (props: unknown) => unknown)(element.props ?? {})
      visit(expanded, cb)
      return
    } catch {
      // Why: a component that touches context (none here, but kept for
      // forward-compat) can throw — fall through to plain-children walk.
    }
  }
  if (element.props?.children) {
    visit(element.props.children, cb)
  }
}

function makeMember(overrides: { id: string; repoId: string }): Worktree {
  return {
    id: overrides.id,
    repoId: overrides.repoId,
    displayName: overrides.id,
    workspaceName: overrides.id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    archivedAt: null,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    branch: 'main',
    path: `/tmp/${overrides.id}`,
    isMainWorktree: false
  } as unknown as Worktree
}

function makeRepoMap(
  entries: { id: string; displayName: string }[]
): Map<string, { id: string; displayName: string }> {
  return new Map(entries.map((e) => [e.id, e]))
}

describe('FileExplorerGroupView — segmented mode', () => {
  it('renders one segment per member when the workspace is grouped', async () => {
    const { FileExplorerGroupView } = await import('./FileExplorerGroupView')
    const members = [
      makeMember({ id: 'wt-a', repoId: 'repo-a' }),
      makeMember({ id: 'wt-b', repoId: 'repo-b' }),
      makeMember({ id: 'wt-c', repoId: 'repo-c' })
    ]
    const repoMap = makeRepoMap([
      { id: 'repo-a', displayName: 'frontend' },
      { id: 'repo-b', displayName: 'backend' },
      { id: 'repo-c', displayName: 'shared' }
    ])
    const html = renderToStaticMarkup(
      <FileExplorerGroupView
        members={members}
        memberChangedCounts={[2, 0, 5]}
        repoMap={repoMap}
        activeRepoId="repo-a"
        onSelectRepo={() => {}}
      />
    )
    expect(html).toContain('frontend')
    expect(html).toContain('backend')
    expect(html).toContain('shared')
    // Why: badge surfaces non-zero changed-file counts; zero counts stay
    // hidden so clean segments don't read as noisy.
    expect(html).toContain('data-segment-badge="2"')
    expect(html).toContain('data-segment-badge="5"')
    expect(html).not.toContain('data-segment-badge="0"')
  })

  it('renders the active member’s worktreeId into the inner explorer', async () => {
    const { FileExplorerGroupView } = await import('./FileExplorerGroupView')
    const members = [
      makeMember({ id: 'wt-a', repoId: 'repo-a' }),
      makeMember({ id: 'wt-b', repoId: 'repo-b' })
    ]
    const repoMap = makeRepoMap([
      { id: 'repo-a', displayName: 'alpha' },
      { id: 'repo-b', displayName: 'bravo' }
    ])
    const htmlA = renderToStaticMarkup(
      <FileExplorerGroupView
        members={members}
        memberChangedCounts={[0, 0]}
        repoMap={repoMap}
        activeRepoId="repo-a"
        onSelectRepo={() => {}}
      />
    )
    expect(htmlA).toContain('data-worktree-id="wt-a"')
    expect(htmlA).not.toContain('data-worktree-id="wt-b"')

    const htmlB = renderToStaticMarkup(
      <FileExplorerGroupView
        members={members}
        memberChangedCounts={[0, 0]}
        repoMap={repoMap}
        activeRepoId="repo-b"
        onSelectRepo={() => {}}
      />
    )
    expect(htmlB).toContain('data-worktree-id="wt-b"')
    expect(htmlB).not.toContain('data-worktree-id="wt-a"')
  })

  it('clicking a segment fires onSelectRepo with that member’s repoId', async () => {
    const { FileExplorerGroupView } = await import('./FileExplorerGroupView')
    const members = [
      makeMember({ id: 'wt-a', repoId: 'repo-a' }),
      makeMember({ id: 'wt-b', repoId: 'repo-b' })
    ]
    const repoMap = makeRepoMap([
      { id: 'repo-a', displayName: 'alpha' },
      { id: 'repo-b', displayName: 'bravo' }
    ])
    const onSelectRepo = vi.fn()
    const element = FileExplorerGroupView({
      members,
      memberChangedCounts: [0, 0],
      repoMap,
      activeRepoId: 'repo-a',
      onSelectRepo
    })
    const tabs: ReactElementLike[] = []
    visit(element, (entry) => {
      if (entry.props?.role === 'tab') {
        tabs.push(entry)
      }
    })
    const bTab = tabs.find((t) => t.props['data-repo-id'] === 'repo-b')
    if (!bTab) {
      throw new Error('expected to find repo-b tab')
    }
    ;(bTab.props.onClick as () => void)()
    expect(onSelectRepo).toHaveBeenCalledOnce()
    expect(onSelectRepo).toHaveBeenCalledWith('repo-b')
  })
})

describe('aggregateGroupChangedCount', () => {
  it('sums member changed-file counts', async () => {
    const { aggregateGroupChangedCount } = await import('./FileExplorerGroupView')
    expect(aggregateGroupChangedCount([2, 0, 5])).toBe(7)
    expect(aggregateGroupChangedCount([])).toBe(0)
    expect(aggregateGroupChangedCount([0, 0])).toBe(0)
  })
})

describe('changedCountToSegmentStatus', () => {
  it('maps 0 to idle and >0 to done', async () => {
    const { changedCountToSegmentStatus } = await import('./FileExplorerGroupView')
    expect(changedCountToSegmentStatus(0)).toBe('idle')
    expect(changedCountToSegmentStatus(1)).toBe('done')
    expect(changedCountToSegmentStatus(42)).toBe('done')
  })
})
