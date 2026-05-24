import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { CheckStatus, Worktree } from '../../../../shared/types'

// Why: tests run in the `node` env (see config/vitest.config.ts) and the real
// ChecksPanelInner pulls in IPC-heavy hooks (PR fetch, checks polling, comments
// polling, conflict-summary refresh, etc.). We stub it with a marker element
// so the group-view tests can assert which worktreeId the inner pane is
// mounted with without booting the whole checks subsystem. Mirrors the
// SourceControlGroupView test mock.
vi.mock('./ChecksPanel', () => ({
  ChecksPanelInner: ({ worktreeId }: { worktreeId: string | null }) => (
    <div data-testid="checks-panel-inner" data-worktree-id={worktreeId ?? ''}>
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
  // own <button> tree the assertions need to inspect.
  if (typeof element.type === 'function') {
    try {
      const expanded = (element.type as (props: unknown) => unknown)(element.props ?? {})
      visit(expanded, cb)
      return
    } catch {
      // Why: a component that touches context can throw — fall through.
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

describe('ChecksPanelGroupView — segmented mode', () => {
  it('renders one segment per member with the right repo names and status dots', async () => {
    const { ChecksPanelGroupView } = await import('./ChecksPanelGroupView')
    const members = [
      makeMember({ id: 'wt-a', repoId: 'repo-a' }),
      makeMember({ id: 'wt-b', repoId: 'repo-b' }),
      makeMember({ id: 'wt-c', repoId: 'repo-c' }),
      makeMember({ id: 'wt-d', repoId: 'repo-d' })
    ]
    const repoMap = makeRepoMap([
      { id: 'repo-a', displayName: 'frontend' },
      { id: 'repo-b', displayName: 'backend' },
      { id: 'repo-c', displayName: 'shared' },
      { id: 'repo-d', displayName: 'tools' }
    ])
    const statuses: (CheckStatus | undefined)[] = ['success', 'failure', 'pending', undefined]
    const html = renderToStaticMarkup(
      <ChecksPanelGroupView
        members={members}
        memberChecksStatuses={statuses}
        repoMap={repoMap}
        activeRepoId="repo-a"
        onSelectRepo={() => {}}
      />
    )
    expect(html).toContain('frontend')
    expect(html).toContain('backend')
    expect(html).toContain('shared')
    expect(html).toContain('tools')
    // Why: each checksStatus maps to one segment status — assert the dot
    // markers SegmentedRepoTabs writes onto each glyph so the mapping is
    // verified end-to-end rather than only at the helper level.
    expect(html).toContain('data-status="done"')
    expect(html).toContain('data-status="failed"')
    expect(html).toContain('data-status="running"')
    expect(html).toContain('data-status="idle"')
  })

  it('passes the active member’s worktreeId down to the inner panel', async () => {
    const { ChecksPanelGroupView } = await import('./ChecksPanelGroupView')
    const members = [
      makeMember({ id: 'wt-a', repoId: 'repo-a' }),
      makeMember({ id: 'wt-b', repoId: 'repo-b' })
    ]
    const repoMap = makeRepoMap([
      { id: 'repo-a', displayName: 'alpha' },
      { id: 'repo-b', displayName: 'bravo' }
    ])
    const htmlA = renderToStaticMarkup(
      <ChecksPanelGroupView
        members={members}
        memberChecksStatuses={[undefined, undefined]}
        repoMap={repoMap}
        activeRepoId="repo-a"
        onSelectRepo={() => {}}
      />
    )
    expect(htmlA).toContain('data-worktree-id="wt-a"')
    expect(htmlA).not.toContain('data-worktree-id="wt-b"')

    const htmlB = renderToStaticMarkup(
      <ChecksPanelGroupView
        members={members}
        memberChecksStatuses={[undefined, undefined]}
        repoMap={repoMap}
        activeRepoId="repo-b"
        onSelectRepo={() => {}}
      />
    )
    expect(htmlB).toContain('data-worktree-id="wt-b"')
    expect(htmlB).not.toContain('data-worktree-id="wt-a"')
  })

  it('clicking a segment fires onSelectRepo with that member’s repoId', async () => {
    const { ChecksPanelGroupView } = await import('./ChecksPanelGroupView')
    const members = [
      makeMember({ id: 'wt-a', repoId: 'repo-a' }),
      makeMember({ id: 'wt-b', repoId: 'repo-b' })
    ]
    const repoMap = makeRepoMap([
      { id: 'repo-a', displayName: 'alpha' },
      { id: 'repo-b', displayName: 'bravo' }
    ])
    const onSelectRepo = vi.fn()
    const element = ChecksPanelGroupView({
      members,
      memberChecksStatuses: [undefined, undefined],
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

describe('checksStatusToSegmentStatus', () => {
  it('maps each PR check status to the right segment status', async () => {
    const { checksStatusToSegmentStatus } = await import('./ChecksPanelGroupView')
    expect(checksStatusToSegmentStatus('success')).toBe('done')
    expect(checksStatusToSegmentStatus('failure')).toBe('failed')
    expect(checksStatusToSegmentStatus('pending')).toBe('running')
    expect(checksStatusToSegmentStatus('neutral')).toBe('idle')
    expect(checksStatusToSegmentStatus(undefined)).toBe('idle')
  })
})
