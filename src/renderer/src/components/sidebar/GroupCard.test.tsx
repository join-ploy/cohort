// @vitest-environment jsdom
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  type RenderResult
} from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  GitStatusEntry,
  PRInfo,
  Repo,
  WorkspaceGroup,
  Worktree
} from '../../../../shared/types'
import type { CacheEntry } from '@/store/slices/github'
import type { WorktreeScriptsEntry } from '@/store/slices/scripts'

// Why: GroupCard reads members/repos/prCache/scriptsByWorktree/gitStatus off
// the store. Provide a minimal in-memory slice surface so each test seeds the
// data it needs without booting the real zustand store.
type AutomationRun = { status: string }
type LinearIssueShape = {
  id: string
  identifier: string
  title: string
  url: string
  state: { name: string; color: string; type: string }
}
type StoreState = {
  worktreesByRepo: Record<string, Worktree[]>
  repos: Repo[]
  workspaceGroups: WorkspaceGroup[]
  prCache: Record<string, CacheEntry<PRInfo>>
  scriptsByWorktree: Record<string, WorktreeScriptsEntry>
  gitStatusByWorktree: Record<string, GitStatusEntry[]>
  archivingGroupIds: ReadonlySet<string>
  // Why: GroupCard now reads worktreeCardProperties for the inline-agents /
  // pr / ci gates, and automationRunsById for the per-member Bot badge.
  // Provide stable defaults so existing tests that don't seed these still
  // exercise the render path.
  worktreeCardProperties: string[]
  automationRunsById: Record<string, AutomationRun>
  retainedAgentsByPaneKey: Record<string, never>
  agentStatusByPaneKey: Record<string, never>
  acknowledgedAgentsByPaneKey: Record<string, never>
  agentStatusEpoch: number
  tabsByWorktree: Record<string, never[]>
  // Why: GroupCard's linked-Linear row reads from linearIssueCache and calls
  // fetchLinearIssue on mount. Default to empty/no-op so unrelated tests
  // don't have to seed Linear state.
  linearIssueCache: Record<string, { data: LinearIssueShape | null; fetchedAt: number }>
  setActiveWorktree: ReturnType<typeof vi.fn>
  openModal: ReturnType<typeof vi.fn>
  updateWorkspaceGroup: ReturnType<typeof vi.fn>
  updateWorktreeMeta: ReturnType<typeof vi.fn>
  fetchPRForBranch: ReturnType<typeof vi.fn>
  fetchLinearIssue: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => {
  return {
    state: {
      worktreesByRepo: {},
      repos: [],
      workspaceGroups: [],
      prCache: {},
      scriptsByWorktree: {},
      gitStatusByWorktree: {},
      archivingGroupIds: new Set<string>(),
      worktreeCardProperties: ['status', 'pr', 'ci', 'inline-agents'],
      automationRunsById: {},
      retainedAgentsByPaneKey: {},
      agentStatusByPaneKey: {},
      acknowledgedAgentsByPaneKey: {},
      agentStatusEpoch: 0,
      tabsByWorktree: {},
      linearIssueCache: {},
      setActiveWorktree: vi.fn(),
      openModal: vi.fn(),
      updateWorkspaceGroup: vi.fn().mockResolvedValue(undefined),
      updateWorktreeMeta: vi.fn().mockResolvedValue(undefined),
      fetchPRForBranch: vi.fn().mockResolvedValue(null),
      fetchLinearIssue: vi.fn().mockResolvedValue(null)
    } as StoreState,
    shellOpenPath: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: StoreState) => T): T => selector(mocks.state)
}))

const runGroupArchiveMock = vi.fn()
vi.mock('./archive-group-flow', () => ({
  runGroupArchive: (id: string, name: string) => runGroupArchiveMock(id, name)
}))

// Why: jsdom does not stub window.api. Mount only the surfaces GroupCard
// touches (shell.openPath for the Open Folder action).
;(window as unknown as { api: { shell: { openPath: (path: string) => void } } }).api = {
  shell: { openPath: (path: string) => mocks.shellOpenPath(path) }
}

import GroupCard from './GroupCard'

// Why: GroupCard's member rows use shadcn Tooltips for the change-count and
// CI badges, which require a TooltipProvider ancestor. Real renders are wrapped
// in <TooltipProvider> at the sidebar root (see components/sidebar/index.tsx),
// so add one here so the test environment mirrors that contract.
function render(ui: React.ReactElement): RenderResult {
  return rtlRender(<TooltipProvider>{ui}</TooltipProvider>)
}

const IDLE_SCRIPT = {
  ptyId: null,
  status: 'idle' as const,
  exitCode: null,
  startedAt: null
}

function makeWorktree(overrides: Partial<Worktree> & { id: string; repoId: string }): Worktree {
  const { id, repoId, ...rest } = overrides
  return {
    id,
    repoId,
    path: `/tmp/${id}`,
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    workspaceName: '',
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
    ...rest
  }
}

function makeRepo(overrides: Partial<Repo> & { id: string; displayName: string }): Repo {
  return {
    path: `/tmp/${overrides.id}`,
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  } as Repo
}

function makeGroup(overrides: Partial<WorkspaceGroup> & { id: string }): WorkspaceGroup {
  return {
    workspaceName: 'daring_tiger',
    displayName: 'daring_tiger',
    parentPath: '/tmp/workspaces/daring_tiger',
    memberWorktreeIds: [],
    branchName: 'daring_tiger',
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

function seed({
  worktrees,
  repos,
  groups,
  prCache,
  scriptsByWorktree,
  gitStatusByWorktree
}: {
  worktrees: Worktree[]
  repos: Repo[]
  groups: WorkspaceGroup[]
  prCache?: Record<string, CacheEntry<PRInfo>>
  scriptsByWorktree?: Record<string, WorktreeScriptsEntry>
  gitStatusByWorktree?: Record<string, GitStatusEntry[]>
}): void {
  const worktreesByRepo: Record<string, Worktree[]> = {}
  for (const wt of worktrees) {
    worktreesByRepo[wt.repoId] = [...(worktreesByRepo[wt.repoId] ?? []), wt]
  }
  mocks.state.worktreesByRepo = worktreesByRepo
  mocks.state.repos = repos
  mocks.state.workspaceGroups = groups
  mocks.state.prCache = prCache ?? {}
  mocks.state.scriptsByWorktree = scriptsByWorktree ?? {}
  mocks.state.gitStatusByWorktree = gitStatusByWorktree ?? {}
}

describe('<GroupCard />', () => {
  beforeEach(() => {
    cleanup()
    mocks.state.setActiveWorktree.mockClear()
    mocks.state.openModal.mockClear()
    mocks.state.updateWorkspaceGroup.mockClear()
    mocks.state.updateWorktreeMeta.mockClear()
    mocks.shellOpenPath.mockClear()
    runGroupArchiveMock.mockClear()
    seed({ worktrees: [], repos: [], groups: [] })
  })

  it('renders the group displayName in the header', () => {
    const wt = makeWorktree({ id: 'wt-orca', repoId: 'repo-orca' })
    const repo = makeRepo({ id: 'repo-orca', displayName: 'orca' })
    const group = makeGroup({
      id: 'group:1',
      displayName: 'daring_tiger',
      memberWorktreeIds: [wt.id]
    })
    seed({ worktrees: [wt], repos: [repo], groups: [group] })

    render(<GroupCard group={group} />)

    expect(screen.getByText('daring_tiger')).toBeTruthy()
  })

  it('renders one row per member repo using each repo display name', () => {
    const wtOrca = makeWorktree({ id: 'wt-orca', repoId: 'repo-orca' })
    const wtPloy = makeWorktree({ id: 'wt-ploy', repoId: 'repo-ploy' })
    const repos = [
      makeRepo({ id: 'repo-orca', displayName: 'orca' }),
      makeRepo({ id: 'repo-ploy', displayName: 'ploy-client' })
    ]
    const group = makeGroup({
      id: 'group:1',
      memberWorktreeIds: [wtOrca.id, wtPloy.id]
    })
    seed({ worktrees: [wtOrca, wtPloy], repos, groups: [group] })

    render(<GroupCard group={group} />)

    const rows = screen.getAllByTestId('group-member-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('orca')
    expect(rows[1].textContent).toContain('ploy-client')
  })

  it('renders a PR row underneath the member when a linkedPR + prCache entry resolve', () => {
    const wt = makeWorktree({
      id: 'wt-orca',
      repoId: 'repo-orca',
      branch: 'refs/heads/daring_tiger',
      linkedPR: 123
    })
    const repo = makeRepo({ id: 'repo-orca', displayName: 'orca' })
    const group = makeGroup({ id: 'group:1', memberWorktreeIds: [wt.id] })
    // Why: prCache is keyed `${repo.path}::${branch}` — same convention used
    // by WorktreeCard. Mirror that here so GroupCard's lookup hits.
    const prCacheKey = `${repo.path}::daring_tiger`
    const prCache: Record<string, CacheEntry<PRInfo>> = {
      [prCacheKey]: {
        data: {
          number: 123,
          title: 'feat: thing',
          state: 'open',
          url: 'https://example.test/pr/123',
          checksStatus: 'neutral',
          updatedAt: '2026-05-22T00:00:00Z',
          mergeable: 'MERGEABLE'
        },
        fetchedAt: 0
      }
    }
    seed({ worktrees: [wt], repos: [repo], groups: [group], prCache })

    render(<GroupCard group={group} />)

    const row = screen.getByTestId('group-member-row')
    // PrSection renders "PR #N <title>" — state is conveyed by the icon
    // color, mirroring how WorktreeCard surfaces PR state.
    expect(row.textContent).toContain('PR #123')
    expect(row.textContent).toContain('feat: thing')
  })

  it('renders the changed-file count when the member has uncommitted changes', () => {
    const wt = makeWorktree({ id: 'wt-orca', repoId: 'repo-orca' })
    const repo = makeRepo({ id: 'repo-orca', displayName: 'orca' })
    const group = makeGroup({ id: 'group:1', memberWorktreeIds: [wt.id] })
    // GitStatusEntry shape is intentionally opaque here — only .length matters.
    const gitStatusByWorktree: Record<string, GitStatusEntry[]> = {
      [wt.id]: [
        { path: 'a.ts', status: 'M' } as unknown as GitStatusEntry,
        { path: 'b.ts', status: 'M' } as unknown as GitStatusEntry,
        { path: 'c.ts', status: 'A' } as unknown as GitStatusEntry
      ]
    }
    seed({ worktrees: [wt], repos: [repo], groups: [group], gitStatusByWorktree })

    render(<GroupCard group={group} />)

    expect(screen.getByTestId('group-member-change-count').textContent).toBe('3')
  })

  it('renders a CI icon when the prCache entry has a non-neutral checksStatus', () => {
    const wt = makeWorktree({
      id: 'wt-orca',
      repoId: 'repo-orca',
      branch: 'refs/heads/daring_tiger',
      linkedPR: 7
    })
    const repo = makeRepo({ id: 'repo-orca', displayName: 'orca' })
    const group = makeGroup({ id: 'group:1', memberWorktreeIds: [wt.id] })
    const prCache: Record<string, CacheEntry<PRInfo>> = {
      [`${repo.path}::daring_tiger`]: {
        data: {
          number: 7,
          title: 't',
          state: 'open',
          url: 'https://example.test/pr/7',
          checksStatus: 'success',
          updatedAt: '2026-05-22T00:00:00Z',
          mergeable: 'MERGEABLE'
        },
        fetchedAt: 0
      }
    }
    seed({ worktrees: [wt], repos: [repo], groups: [group], prCache })

    render(<GroupCard group={group} />)

    expect(screen.getByTestId('group-member-ci')).toBeTruthy()
  })

  it('renders the live run equalizer on a member row when its run script is running', () => {
    const wt = makeWorktree({ id: 'wt-orca', repoId: 'repo-orca' })
    const repo = makeRepo({ id: 'repo-orca', displayName: 'orca' })
    const group = makeGroup({ id: 'group:1', memberWorktreeIds: [wt.id] })
    const scriptsByWorktree: Record<string, WorktreeScriptsEntry> = {
      [wt.id]: {
        run: { ptyId: 'p-1', status: 'running', exitCode: null, startedAt: 0 },
        setup: IDLE_SCRIPT
      }
    }
    seed({ worktrees: [wt], repos: [repo], groups: [group], scriptsByWorktree })

    render(<GroupCard group={group} />)

    expect(screen.getByTestId('group-member-run-eq')).toBeTruthy()
  })

  it('clicking a member row bubbles to the group root and activates the first member', () => {
    // Why: member rows are intentionally not independently clickable — they
    // are visual content inside the GroupCard. A click anywhere on the card
    // (including a member row) is a group activation, which v1 implements
    // by activating the first member.
    const wtA = makeWorktree({ id: 'wt-a', repoId: 'repo-a' })
    const wtB = makeWorktree({ id: 'wt-b', repoId: 'repo-b' })
    const repos = [
      makeRepo({ id: 'repo-a', displayName: 'a' }),
      makeRepo({ id: 'repo-b', displayName: 'b' })
    ]
    const group = makeGroup({ id: 'group:1', memberWorktreeIds: [wtA.id, wtB.id] })
    seed({ worktrees: [wtA, wtB], repos, groups: [group] })

    render(<GroupCard group={group} />)

    const rows = screen.getAllByTestId('group-member-row')
    fireEvent.click(rows[1])

    expect(mocks.state.setActiveWorktree).toHaveBeenLastCalledWith('wt-a')
  })

  it('right-click → Archive Group fires runGroupArchive with the group id', () => {
    const wt = makeWorktree({ id: 'wt-orca', repoId: 'repo-orca' })
    const repo = makeRepo({ id: 'repo-orca', displayName: 'orca' })
    const group = makeGroup({
      id: 'group:1',
      displayName: 'daring_tiger',
      memberWorktreeIds: [wt.id]
    })
    seed({ worktrees: [wt], repos: [repo], groups: [group] })

    render(<GroupCard group={group} />)

    const card = screen.getByTestId('group-card')
    fireEvent.contextMenu(card)

    const archiveItem = screen.getByTestId('group-card-archive-action')
    fireEvent.click(archiveItem)

    expect(runGroupArchiveMock).toHaveBeenCalledWith('group:1', 'daring_tiger')
  })

  it('renders the archive-cleanup error inline when one is stamped on the group', () => {
    const wt = makeWorktree({ id: 'wt-orca', repoId: 'repo-orca' })
    const repo = makeRepo({ id: 'repo-orca', displayName: 'orca' })
    const group = makeGroup({
      id: 'group:1',
      memberWorktreeIds: [wt.id],
      archiveCleanupError: 'repo-b refused: dirty tree'
    })
    seed({ worktrees: [wt], repos: [repo], groups: [group] })

    render(<GroupCard group={group} />)

    const errorRow = screen.getByTestId('group-archive-cleanup-error')
    expect(errorRow.textContent).toContain('repo-b refused')
  })

  it('right-click → Rename opens the edit-group-meta modal focused on displayName', () => {
    const wt = makeWorktree({ id: 'wt-orca', repoId: 'repo-orca' })
    const repo = makeRepo({ id: 'repo-orca', displayName: 'orca' })
    const group = makeGroup({
      id: 'group:1',
      displayName: 'daring_tiger',
      comment: 'shared notes',
      memberWorktreeIds: [wt.id]
    })
    seed({ worktrees: [wt], repos: [repo], groups: [group] })

    render(<GroupCard group={group} />)

    fireEvent.contextMenu(screen.getByTestId('group-card'))
    fireEvent.click(screen.getByTestId('group-card-rename-action'))

    expect(mocks.state.openModal).toHaveBeenCalledWith('edit-group-meta', {
      groupId: 'group:1',
      currentDisplayName: 'daring_tiger',
      currentComment: 'shared notes',
      focus: 'displayName'
    })
  })

  it('right-click → Edit Comment opens the edit-group-meta modal focused on comment', () => {
    const wt = makeWorktree({ id: 'wt-orca', repoId: 'repo-orca' })
    const repo = makeRepo({ id: 'repo-orca', displayName: 'orca' })
    const group = makeGroup({
      id: 'group:1',
      displayName: 'daring_tiger',
      comment: 'existing',
      memberWorktreeIds: [wt.id]
    })
    seed({ worktrees: [wt], repos: [repo], groups: [group] })

    render(<GroupCard group={group} />)

    fireEvent.contextMenu(screen.getByTestId('group-card'))
    const commentItem = screen.getByTestId('group-card-comment-action')
    expect(commentItem.textContent).toContain('Edit Comment')
    fireEvent.click(commentItem)

    expect(mocks.state.openModal).toHaveBeenCalledWith('edit-group-meta', {
      groupId: 'group:1',
      currentDisplayName: 'daring_tiger',
      currentComment: 'existing',
      focus: 'comment'
    })
  })

  it('Add Comment label is shown when the group has no comment yet', () => {
    const wt = makeWorktree({ id: 'wt-orca', repoId: 'repo-orca' })
    const repo = makeRepo({ id: 'repo-orca', displayName: 'orca' })
    const group = makeGroup({
      id: 'group:1',
      comment: '',
      memberWorktreeIds: [wt.id]
    })
    seed({ worktrees: [wt], repos: [repo], groups: [group] })

    render(<GroupCard group={group} />)
    fireEvent.contextMenu(screen.getByTestId('group-card'))

    expect(screen.getByTestId('group-card-comment-action').textContent).toContain('Add Comment')
  })

  it('right-click → Pin toggles isPinned via updateWorkspaceGroup', () => {
    const wt = makeWorktree({ id: 'wt-orca', repoId: 'repo-orca' })
    const repo = makeRepo({ id: 'repo-orca', displayName: 'orca' })
    const group = makeGroup({
      id: 'group:1',
      isPinned: false,
      memberWorktreeIds: [wt.id]
    })
    seed({ worktrees: [wt], repos: [repo], groups: [group] })

    render(<GroupCard group={group} />)

    fireEvent.contextMenu(screen.getByTestId('group-card'))
    const pinItem = screen.getByTestId('group-card-pin-action')
    expect(pinItem.textContent).toContain('Pin')
    fireEvent.click(pinItem)

    expect(mocks.state.updateWorkspaceGroup).toHaveBeenCalledWith('group:1', { isPinned: true })
  })

  it('Unpin label is shown when the group is already pinned', () => {
    const wt = makeWorktree({ id: 'wt-orca', repoId: 'repo-orca' })
    const repo = makeRepo({ id: 'repo-orca', displayName: 'orca' })
    const group = makeGroup({
      id: 'group:1',
      isPinned: true,
      memberWorktreeIds: [wt.id]
    })
    seed({ worktrees: [wt], repos: [repo], groups: [group] })

    render(<GroupCard group={group} />)
    fireEvent.contextMenu(screen.getByTestId('group-card'))

    expect(screen.getByTestId('group-card-pin-action').textContent).toContain('Unpin')
  })

  it('right-click → Open in Finder dispatches shell.openPath with parentPath', () => {
    const wt = makeWorktree({ id: 'wt-orca', repoId: 'repo-orca' })
    const repo = makeRepo({ id: 'repo-orca', displayName: 'orca' })
    const group = makeGroup({
      id: 'group:1',
      parentPath: '/some/workspaces/daring_tiger',
      memberWorktreeIds: [wt.id]
    })
    seed({ worktrees: [wt], repos: [repo], groups: [group] })

    render(<GroupCard group={group} />)

    fireEvent.contextMenu(screen.getByTestId('group-card'))
    fireEvent.click(screen.getByTestId('group-card-open-folder'))

    expect(mocks.shellOpenPath).toHaveBeenCalledWith('/some/workspaces/daring_tiger')
  })

  it('double-clicking the card opens the rename modal', () => {
    const wt = makeWorktree({ id: 'wt-orca', repoId: 'repo-orca' })
    const repo = makeRepo({ id: 'repo-orca', displayName: 'orca' })
    const group = makeGroup({
      id: 'group:1',
      displayName: 'daring_tiger',
      memberWorktreeIds: [wt.id]
    })
    seed({ worktrees: [wt], repos: [repo], groups: [group] })

    render(<GroupCard group={group} />)

    fireEvent.doubleClick(screen.getByTestId('group-card'))

    expect(mocks.state.openModal).toHaveBeenCalledWith(
      'edit-group-meta',
      expect.objectContaining({ groupId: 'group:1', focus: 'displayName' })
    )
  })

  it('shows a running indicator when at least one member has a running run script', () => {
    const wtA = makeWorktree({ id: 'wt-a', repoId: 'repo-a' })
    const wtB = makeWorktree({ id: 'wt-b', repoId: 'repo-b' })
    const repos = [
      makeRepo({ id: 'repo-a', displayName: 'a' }),
      makeRepo({ id: 'repo-b', displayName: 'b' })
    ]
    const group = makeGroup({
      id: 'group:1',
      memberWorktreeIds: [wtA.id, wtB.id]
    })
    const scriptsByWorktree: Record<string, WorktreeScriptsEntry> = {
      [wtB.id]: {
        run: { ptyId: 'p-1', status: 'running', exitCode: null, startedAt: 0 },
        setup: IDLE_SCRIPT
      }
    }
    seed({
      worktrees: [wtA, wtB],
      repos,
      groups: [group],
      scriptsByWorktree
    })

    render(<GroupCard group={group} />)

    expect(screen.getByTestId('group-running-dot')).toBeTruthy()
  })

  it('renders +/- PR diff stats on a member row when the cached PR has additions/deletions', () => {
    // Why: matches the WorktreeCard `+N −M` chip — group members must show
    // the same diff-size signal so the user can spot large PRs at a glance.
    const wt = makeWorktree({
      id: 'wt-orca',
      repoId: 'repo-orca',
      branch: 'refs/heads/daring_tiger',
      linkedPR: 42
    })
    const repo = makeRepo({ id: 'repo-orca', displayName: 'orca' })
    const group = makeGroup({ id: 'group:1', memberWorktreeIds: [wt.id] })
    const prCache: Record<string, CacheEntry<PRInfo>> = {
      [`${repo.path}::daring_tiger`]: {
        data: {
          number: 42,
          title: 'big change',
          state: 'open',
          url: 'https://example.test/pr/42',
          checksStatus: 'neutral',
          updatedAt: '2026-05-22T00:00:00Z',
          mergeable: 'MERGEABLE',
          additions: 120,
          deletions: 7
        } as unknown as PRInfo,
        fetchedAt: 0
      }
    }
    seed({ worktrees: [wt], repos: [repo], groups: [group], prCache })

    render(<GroupCard group={group} />)

    const stats = screen.getByTestId('group-member-diff-stats')
    expect(stats.textContent).toContain('+120')
    expect(stats.textContent).toContain('−7')
  })

  it('renders an automation Bot badge on a member row when it was created by an automation', () => {
    // Why: the Bot icon flips to animate-pulse while the originating run is
    // still active, matching WorktreeCard's behavior.
    const wt = makeWorktree({
      id: 'wt-orca',
      repoId: 'repo-orca',
      createdByAutomationRunId: 'run-1'
    })
    const repo = makeRepo({ id: 'repo-orca', displayName: 'orca' })
    const group = makeGroup({ id: 'group:1', memberWorktreeIds: [wt.id] })
    mocks.state.automationRunsById = { 'run-1': { status: 'running' } }
    seed({ worktrees: [wt], repos: [repo], groups: [group] })

    render(<GroupCard group={group} />)

    const bot = screen.getByTestId('group-member-automation-bot')
    expect(bot.getAttribute('data-automation-run-id')).toBe('run-1')
    expect(bot.getAttribute('data-automation-active')).toBe('true')
  })

  it('omits the automation Bot badge when the member was not created by an automation', () => {
    const wt = makeWorktree({ id: 'wt-orca', repoId: 'repo-orca' })
    const repo = makeRepo({ id: 'repo-orca', displayName: 'orca' })
    const group = makeGroup({ id: 'group:1', memberWorktreeIds: [wt.id] })
    seed({ worktrees: [wt], repos: [repo], groups: [group] })

    render(<GroupCard group={group} />)

    expect(screen.queryByTestId('group-member-automation-bot')).toBeNull()
  })

  it('renders the combined agents section only when inline-agents card prop is enabled', () => {
    const wt = makeWorktree({ id: 'wt-orca', repoId: 'repo-orca' })
    const repo = makeRepo({ id: 'repo-orca', displayName: 'orca' })
    const group = makeGroup({ id: 'group:1', memberWorktreeIds: [wt.id] })
    seed({ worktrees: [wt], repos: [repo], groups: [group] })

    // Enabled: container renders even though the inner WorktreeCardAgents
    // returns null for a worktree with zero live agents — the empty wrapper
    // is intentional so the section appears reactively once agents arrive.
    mocks.state.worktreeCardProperties = ['status', 'pr', 'ci', 'inline-agents']
    const enabled = render(<GroupCard group={group} />)
    expect(enabled.container.querySelector('[data-testid="group-agents"]')).toBeTruthy()
    enabled.unmount()

    // Disabled: container must NOT render.
    mocks.state.worktreeCardProperties = ['status', 'pr', 'ci']
    const disabled = render(<GroupCard group={group} />)
    expect(disabled.container.querySelector('[data-testid="group-agents"]')).toBeNull()
  })

  it('renders linked Linear tickets as rows above the members (group + each member, deduped)', () => {
    // Why: covers the new contract — group.linkedLinearIssue plus per-member
    // linkedLinearIssue rendered together, with stable order (group first,
    // then declared member order) and dedup when the same identifier is
    // linked on multiple surfaces.
    const wtA = makeWorktree({
      id: 'wt-a',
      repoId: 'repo-a',
      linkedLinearIssue: 'ENG-200'
    })
    const wtB = makeWorktree({
      id: 'wt-b',
      repoId: 'repo-b',
      linkedLinearIssue: 'ENG-100' // duplicates the group-level link — must dedupe
    })
    const repos = [
      makeRepo({ id: 'repo-a', displayName: 'a' }),
      makeRepo({ id: 'repo-b', displayName: 'b' })
    ]
    const group = makeGroup({
      id: 'group:1',
      memberWorktreeIds: [wtA.id, wtB.id],
      linkedLinearIssue: 'ENG-100'
    })
    // Title for one of them is cached — verifies the title backfills, while
    // the other identifier still renders without a title attached.
    mocks.state.linearIssueCache = {
      'ENG-100': {
        data: {
          id: 'uuid-100',
          identifier: 'ENG-100',
          title: 'Add grouped workspaces',
          url: 'https://linear.app/x/ENG-100',
          state: { name: 'In Progress', color: '#5e6ad2', type: 'started' }
        },
        fetchedAt: 0
      }
    }
    seed({ worktrees: [wtA, wtB], repos, groups: [group] })

    render(<GroupCard group={group} />)

    const container = screen.getByTestId('group-linear-issues')
    expect(container.textContent).toContain('ENG-100')
    expect(container.textContent).toContain('Add grouped workspaces')
    expect(container.textContent).toContain('ENG-200')

    // Order: ENG-100 (group-level + dedupe absorbs wtB's copy) before ENG-200 (wtA).
    const firstIdx = container.textContent!.indexOf('ENG-100')
    const secondIdx = container.textContent!.indexOf('ENG-200')
    expect(firstIdx).toBeLessThan(secondIdx)

    // Dedup: ENG-100 appears in the rendered text exactly once — the group's
    // own link and wtB's identical link must not double-render.
    const occurrences = (container.textContent!.match(/ENG-100/g) ?? []).length
    expect(occurrences).toBe(1)

    // Every linked identifier triggers a fetchLinearIssue on mount.
    expect(mocks.state.fetchLinearIssue).toHaveBeenCalledWith('ENG-100')
    expect(mocks.state.fetchLinearIssue).toHaveBeenCalledWith('ENG-200')
  })

  it('omits the Linear-issues row container when neither the group nor any member is linked', () => {
    const wt = makeWorktree({ id: 'wt-orca', repoId: 'repo-orca' })
    const repo = makeRepo({ id: 'repo-orca', displayName: 'orca' })
    const group = makeGroup({ id: 'group:1', memberWorktreeIds: [wt.id] })
    seed({ worktrees: [wt], repos: [repo], groups: [group] })

    render(<GroupCard group={group} />)

    expect(screen.queryByTestId('group-linear-issues')).toBeNull()
  })

  it('mounting a GroupMemberRow triggers fetchPRForBranch for that branch', () => {
    // Why: before this, group sibling rows pulled stale PR data from the
    // cache without ever requesting a refresh on their own — sibling diff
    // stats / PR state only ever updated when the user briefly visited the
    // sibling. The mount fetch is what closes that gap.
    const wt = makeWorktree({
      id: 'wt-orca',
      repoId: 'repo-orca',
      branch: 'refs/heads/daring_tiger',
      linkedPR: 99
    })
    const repo = makeRepo({ id: 'repo-orca', displayName: 'orca' })
    const group = makeGroup({ id: 'group:1', memberWorktreeIds: [wt.id] })
    seed({ worktrees: [wt], repos: [repo], groups: [group] })

    render(<GroupCard group={group} />)

    expect(mocks.state.fetchPRForBranch).toHaveBeenCalledWith(repo.path, 'daring_tiger', {
      linkedPRNumber: 99
    })
  })
})
