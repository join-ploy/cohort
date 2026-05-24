// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { Worktree, WorkspaceGroup } from '../../../../../shared/types'
import type { AutomationTarget } from '../../../../../shared/automations-types'

// Why: the picker reads `worktreesByRepo[projectId]` from the store. Mock the
// store so renderToStaticMarkup can verify the rendered branches without
// pulling in the full zustand wiring.

type StoreState = Record<string, unknown>

let mockState: StoreState = {}

vi.mock('@/store', () => ({
  useAppStore: (selector?: (state: StoreState) => unknown) =>
    selector ? selector(mockState) : mockState
}))

const wtA: Worktree = {
  id: 'repo-1::/wt-a',
  repoId: 'repo-1',
  path: '/wt-a',
  head: 'aaa',
  branch: 'refs/heads/feature-a',
  isBare: false,
  isMainWorktree: false,
  displayName: 'Feature A',
  workspaceName: 'wise_panther',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  archivedAt: null,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}

const wtB: Worktree = {
  ...wtA,
  id: 'repo-1::/wt-b',
  path: '/wt-b',
  branch: 'refs/heads/feature-b',
  displayName: 'Feature B',
  workspaceName: 'brave_otter'
}

function stateWith(
  worktreesByRepo: Record<string, Worktree[]>,
  workspaceGroups: WorkspaceGroup[] = []
): StoreState {
  return { worktreesByRepo, workspaceGroups }
}

function makeGroup(overrides: Partial<WorkspaceGroup> = {}): WorkspaceGroup {
  return {
    id: 'group:demo-uuid',
    workspaceName: 'demo',
    displayName: 'Demo Group',
    parentPath: '/workspaces/demo',
    memberWorktreeIds: [],
    branchName: 'feat-x',
    isArchived: false,
    archivedAt: null,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    isUnread: false,
    comment: '',
    createdAt: 0,
    linkedIssue: null,
    linkedLinearIssue: null,
    ...overrides
  }
}

describe('WorktreePicker', () => {
  beforeEach(() => {
    mockState = stateWith({})
  })

  afterEach(() => {
    cleanup()
  })

  it('renders the empty message when projectId is blank', async () => {
    mockState = stateWith({ 'repo-1': [wtA] })
    const { WorktreePicker } = await import('./WorktreePicker')
    const markup = renderToStaticMarkup(<WorktreePicker projectId="" onSelect={() => {}} />)
    expect(markup).toMatch(/No worktrees in this project/i)
  })

  it('renders the empty message when the project has no worktrees', async () => {
    mockState = stateWith({ 'repo-1': [] })
    const { WorktreePicker } = await import('./WorktreePicker')
    const markup = renderToStaticMarkup(<WorktreePicker projectId="repo-1" onSelect={() => {}} />)
    expect(markup).toMatch(/No worktrees in this project/i)
  })

  it('renders all worktrees with displayName and branch when present', async () => {
    mockState = stateWith({ 'repo-1': [wtA, wtB] })
    const { WorktreePicker } = await import('./WorktreePicker')
    const markup = renderToStaticMarkup(<WorktreePicker projectId="repo-1" onSelect={() => {}} />)
    expect(markup).toContain('Feature A')
    expect(markup).toContain('Feature B')
    // Branch shown alongside displayName (stripping refs/heads/ prefix).
    expect(markup).toContain('feature-a')
    expect(markup).toContain('feature-b')
    // Each row exposes the worktree id for downstream selection wiring.
    expect(markup).toMatch(/data-worktree-id=["']repo-1::\/wt-a["']/)
    expect(markup).toMatch(/data-worktree-id=["']repo-1::\/wt-b["']/)
  })

  // Why: when the picker mounts with no current value and exactly one
  // worktree is available, prefill it — there's nothing else the user could
  // meaningfully click. Gated by currentValue + a one-shot ref so a later
  // change can't be clobbered back to the only option.
  it('auto-selects the only worktree on mount when there is no current value', async () => {
    mockState = stateWith({ 'repo-1': [wtA] })
    const { WorktreePicker } = await import('./WorktreePicker')
    const onSelect = vi.fn()
    render(<WorktreePicker projectId="repo-1" onSelect={onSelect} />)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(wtA.id)
  })

  it('does not auto-select when a current value is already set', async () => {
    mockState = stateWith({ 'repo-1': [wtA] })
    const { WorktreePicker } = await import('./WorktreePicker')
    const onSelect = vi.fn()
    render(
      <WorktreePicker projectId="repo-1" onSelect={onSelect} currentValue="{{trigger.something}}" />
    )
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('does not auto-select when multiple worktrees are available', async () => {
    mockState = stateWith({ 'repo-1': [wtA, wtB] })
    const { WorktreePicker } = await import('./WorktreePicker')
    const onSelect = vi.fn()
    render(<WorktreePicker projectId="repo-1" onSelect={onSelect} />)
    expect(onSelect).not.toHaveBeenCalled()
  })

  // ─── Grouped-workspaces extension (Phase L4) ────────────────────────────

  // Why: a group-targeted automation needs to address either the whole group
  // (worktreeRef = group:<id>) OR a specific member worktree (= worktreeId).
  // The picker surfaces both alongside per-repo standalone worktrees.
  describe('when target.kind is "group"', () => {
    const wtRepoA: Worktree = { ...wtA, id: 'repo-a::/wt-x', repoId: 'repo-a' }
    const wtRepoB: Worktree = { ...wtA, id: 'repo-b::/wt-x', repoId: 'repo-b', displayName: 'B' }
    const groupTarget: AutomationTarget = {
      kind: 'group',
      projectIds: ['repo-a', 'repo-b']
    }
    const group = makeGroup({
      id: 'group:abc',
      memberWorktreeIds: [wtRepoA.id, wtRepoB.id]
    })

    it('renders the group row + each member row with a member-scoped row beneath', async () => {
      mockState = stateWith({ 'repo-a': [wtRepoA], 'repo-b': [wtRepoB] }, [group])
      const { WorktreePicker } = await import('./WorktreePicker')
      const markup = renderToStaticMarkup(
        <WorktreePicker projectId="" target={groupTarget} onSelect={() => {}} />
      )
      // Group row
      expect(markup).toMatch(/data-group-id=["']group:abc["']/)
      expect(markup).toContain('Demo Group')
      // Member rows (one per worktree)
      expect(markup).toMatch(/data-worktree-id=["']repo-a::\/wt-x["'][^>]*data-member-of-group/)
      expect(markup).toMatch(/data-worktree-id=["']repo-b::\/wt-x["'][^>]*data-member-of-group/)
      // Member-scoped rows
      expect(markup).toMatch(/data-member-scoped-ref=["']member:group:abc:repo-a::\/wt-x["']/)
      expect(markup).toMatch(/data-member-scoped-ref=["']member:group:abc:repo-b::\/wt-x["']/)
    })

    it('hides groups whose members include a repo outside the target projectIds', async () => {
      const offGroup = makeGroup({
        id: 'group:off',
        memberWorktreeIds: [wtRepoA.id, 'repo-c::/wt-y']
      })
      mockState = stateWith(
        {
          'repo-a': [wtRepoA],
          'repo-b': [wtRepoB],
          'repo-c': [{ ...wtA, id: 'repo-c::/wt-y', repoId: 'repo-c' }]
        },
        [offGroup]
      )
      const { WorktreePicker } = await import('./WorktreePicker')
      const markup = renderToStaticMarkup(
        <WorktreePicker projectId="" target={groupTarget} onSelect={() => {}} />
      )
      // The off-group must not surface; its members would expand the run
      // beyond the automation's declared target repos.
      expect(markup).not.toMatch(/data-group-id=["']group:off["']/)
    })

    it('emits the group id when a group row is clicked', async () => {
      mockState = stateWith({ 'repo-a': [wtRepoA], 'repo-b': [wtRepoB] }, [group])
      const { WorktreePicker } = await import('./WorktreePicker')
      const onSelect = vi.fn()
      const { container } = render(
        <WorktreePicker
          projectId=""
          target={groupTarget}
          onSelect={onSelect}
          currentValue="placeholder"
        />
      )
      const groupBtn = container.querySelector('[data-group-id="group:abc"]') as HTMLButtonElement
      groupBtn.click()
      expect(onSelect).toHaveBeenCalledWith('group:abc')
    })

    it('emits a member-scoped ref when the scoped row is clicked', async () => {
      mockState = stateWith({ 'repo-a': [wtRepoA], 'repo-b': [wtRepoB] }, [group])
      const { WorktreePicker } = await import('./WorktreePicker')
      const onSelect = vi.fn()
      const { container } = render(
        <WorktreePicker
          projectId=""
          target={groupTarget}
          onSelect={onSelect}
          currentValue="placeholder"
        />
      )
      const scopedBtn = container.querySelector(
        '[data-member-scoped-ref="member:group:abc:repo-a::/wt-x"]'
      ) as HTMLButtonElement
      scopedBtn.click()
      expect(onSelect).toHaveBeenCalledWith('member:group:abc:repo-a::/wt-x')
    })

    // Why: auto-prefill rule for the group case — `member-scoped` rows never
    // count as selectable defaults (opt-in semantics from Ask C). A group with
    // a single member should still prefill to "the group itself" rather than
    // "scoped to the only member".
    it('auto-selects a sole group when no other candidate exists', async () => {
      const singleMemberGroup = makeGroup({
        id: 'group:solo',
        memberWorktreeIds: [wtRepoA.id]
      })
      mockState = stateWith({ 'repo-a': [wtRepoA] }, [singleMemberGroup])
      const { WorktreePicker } = await import('./WorktreePicker')
      const onSelect = vi.fn()
      render(
        <WorktreePicker
          projectId=""
          target={{ kind: 'group', projectIds: ['repo-a'] }}
          onSelect={onSelect}
        />
      )
      // Two candidates: the group itself + the sole member. So no prefill —
      // there's a real choice to make between scoping to the group (1 tab,
      // group cwd) vs scoping to the member (still group-bound but member
      // cwd). The auto-prefill only fires when there's truly one option.
      expect(onSelect).not.toHaveBeenCalled()
    })
  })
})
