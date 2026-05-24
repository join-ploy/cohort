// @vitest-environment jsdom
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render as rtlRender, screen, type RenderResult } from '@testing-library/react'
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
import type * as SelectorsModule from '@/store/selectors'

// Why: GroupsSection reads workspaceGroups + the same fields GroupCard does
// (members/repos/prCache/scriptsByWorktree/gitStatus + the archive-in-flight
// set). Provide a minimal in-memory slice surface so each test seeds the data
// it needs without booting zustand.
type StoreState = {
  worktreesByRepo: Record<string, Worktree[]>
  repos: Repo[]
  workspaceGroups: WorkspaceGroup[]
  prCache: Record<string, CacheEntry<PRInfo>>
  scriptsByWorktree: Record<string, WorktreeScriptsEntry>
  gitStatusByWorktree: Record<string, GitStatusEntry[]>
  archivingGroupIds: ReadonlySet<string>
  setActiveWorktree: ReturnType<typeof vi.fn>
  openModal: ReturnType<typeof vi.fn>
  updateWorkspaceGroup: ReturnType<typeof vi.fn>
  updateWorktreeMeta: ReturnType<typeof vi.fn>
  activeWorktreeId: string | null
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
      setActiveWorktree: vi.fn(),
      openModal: vi.fn(),
      updateWorkspaceGroup: vi.fn().mockResolvedValue(undefined),
      updateWorktreeMeta: vi.fn().mockResolvedValue(undefined),
      activeWorktreeId: null
    } as StoreState
  }
})

vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: StoreState) => T): T => selector(mocks.state)
}))

vi.mock('@/store/selectors', async () => {
  const actual = await vi.importActual<typeof SelectorsModule>('@/store/selectors')
  return {
    ...actual,
    useWorkspaceGroups: () => mocks.state.workspaceGroups,
    useActiveGroupId: () => {
      const id = mocks.state.activeWorktreeId
      if (!id) {
        return null
      }
      const group = mocks.state.workspaceGroups.find((g) => g.memberWorktreeIds.includes(id))
      return group?.id ?? null
    }
  }
})

// Why: jsdom does not stub window.api. Mount only the surfaces GroupCard
// touches (shell.openPath for the Open Folder action).
;(window as unknown as { api: { shell: { openPath: (path: string) => void } } }).api = {
  shell: { openPath: vi.fn() as unknown as (path: string) => void }
}

import { GroupsSection } from './GroupsSection'

// Why: GroupCard's member rows use shadcn Tooltips, which require a
// TooltipProvider ancestor (the real sidebar wraps the tree at index.tsx).
function render(ui: React.ReactElement): RenderResult {
  return rtlRender(<TooltipProvider>{ui}</TooltipProvider>)
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
    workspaceName: overrides.id,
    displayName: overrides.id,
    parentPath: `/tmp/workspaces/${overrides.id}`,
    memberWorktreeIds: [],
    branchName: overrides.id,
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
  groups
}: {
  worktrees: Worktree[]
  repos: Repo[]
  groups: WorkspaceGroup[]
}): void {
  const worktreesByRepo: Record<string, Worktree[]> = {}
  for (const wt of worktrees) {
    worktreesByRepo[wt.repoId] = [...(worktreesByRepo[wt.repoId] ?? []), wt]
  }
  mocks.state.worktreesByRepo = worktreesByRepo
  mocks.state.repos = repos
  mocks.state.workspaceGroups = groups
  mocks.state.prCache = {}
  mocks.state.scriptsByWorktree = {}
  mocks.state.gitStatusByWorktree = {}
  mocks.state.archivingGroupIds = new Set<string>()
  mocks.state.activeWorktreeId = null
}

describe('<GroupsSection />', () => {
  beforeEach(() => {
    cleanup()
    mocks.state.setActiveWorktree.mockClear()
    seed({ worktrees: [], repos: [], groups: [] })
  })

  it('returns null when no groups exist', () => {
    seed({ worktrees: [], repos: [], groups: [] })

    const { container } = render(<GroupsSection />)

    expect(container.firstChild).toBeNull()
  })

  it('renders the section header and one card per group', () => {
    const wtA = makeWorktree({ id: 'wt-a', repoId: 'repo-a' })
    const wtB = makeWorktree({ id: 'wt-b', repoId: 'repo-b' })
    const repos = [
      makeRepo({ id: 'repo-a', displayName: 'a' }),
      makeRepo({ id: 'repo-b', displayName: 'b' })
    ]
    const groupOne = makeGroup({
      id: 'group:1',
      displayName: 'alpha',
      memberWorktreeIds: [wtA.id]
    })
    const groupTwo = makeGroup({
      id: 'group:2',
      displayName: 'beta',
      memberWorktreeIds: [wtB.id]
    })
    seed({ worktrees: [wtA, wtB], repos, groups: [groupOne, groupTwo] })

    render(<GroupsSection />)

    expect(screen.getByText('Groups')).toBeTruthy()
    expect(screen.getAllByTestId('group-card')).toHaveLength(2)
  })

  it('hides archived groups', () => {
    const wtA = makeWorktree({ id: 'wt-a', repoId: 'repo-a' })
    const wtB = makeWorktree({ id: 'wt-b', repoId: 'repo-b' })
    const repos = [
      makeRepo({ id: 'repo-a', displayName: 'a' }),
      makeRepo({ id: 'repo-b', displayName: 'b' })
    ]
    const live = makeGroup({
      id: 'group:live',
      displayName: 'live',
      memberWorktreeIds: [wtA.id]
    })
    const archived = makeGroup({
      id: 'group:archived',
      displayName: 'archived',
      memberWorktreeIds: [wtB.id],
      isArchived: true,
      archivedAt: 1
    })
    seed({ worktrees: [wtA, wtB], repos, groups: [live, archived] })

    render(<GroupsSection />)

    const cards = screen.getAllByTestId('group-card')
    expect(cards).toHaveLength(1)
    expect(cards[0].textContent).toContain('live')
  })

  it('sorts by sortOrder ascending, then lastActivityAt descending', () => {
    // Three groups in deliberately mixed input order. The two with the same
    // sortOrder must tie-break by lastActivityAt descending (newest first).
    const wtA = makeWorktree({ id: 'wt-a', repoId: 'repo-a' })
    const wtB = makeWorktree({ id: 'wt-b', repoId: 'repo-b' })
    const wtC = makeWorktree({ id: 'wt-c', repoId: 'repo-c' })
    const repos = [
      makeRepo({ id: 'repo-a', displayName: 'a' }),
      makeRepo({ id: 'repo-b', displayName: 'b' }),
      makeRepo({ id: 'repo-c', displayName: 'c' })
    ]
    // Expected final order: middle (sortOrder 0), newer (sortOrder 1, activity 200),
    // older (sortOrder 1, activity 100).
    const newer = makeGroup({
      id: 'group:newer',
      displayName: 'newer',
      memberWorktreeIds: [wtB.id],
      sortOrder: 1,
      lastActivityAt: 200
    })
    const older = makeGroup({
      id: 'group:older',
      displayName: 'older',
      memberWorktreeIds: [wtC.id],
      sortOrder: 1,
      lastActivityAt: 100
    })
    const middle = makeGroup({
      id: 'group:middle',
      displayName: 'middle',
      memberWorktreeIds: [wtA.id],
      sortOrder: 0,
      lastActivityAt: 0
    })
    seed({ worktrees: [wtA, wtB, wtC], repos, groups: [newer, older, middle] })

    render(<GroupsSection />)

    const cards = screen.getAllByTestId('group-card')
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual([
      'Group middle',
      'Group newer',
      'Group older'
    ])
  })

  it('marks the owning group as active when activeWorktreeId is a member', () => {
    const wtA = makeWorktree({ id: 'wt-a', repoId: 'repo-a' })
    const wtB = makeWorktree({ id: 'wt-b', repoId: 'repo-b' })
    const repos = [
      makeRepo({ id: 'repo-a', displayName: 'a' }),
      makeRepo({ id: 'repo-b', displayName: 'b' })
    ]
    const groupOne = makeGroup({
      id: 'group:1',
      displayName: 'alpha',
      memberWorktreeIds: [wtA.id]
    })
    const groupTwo = makeGroup({
      id: 'group:2',
      displayName: 'beta',
      memberWorktreeIds: [wtB.id]
    })
    seed({ worktrees: [wtA, wtB], repos, groups: [groupOne, groupTwo] })
    mocks.state.activeWorktreeId = wtB.id

    render(<GroupsSection />)

    const cards = screen.getAllByTestId('group-card')
    // Why: aria-pressed mirrors isActive on the card root.
    const pressedByLabel: Record<string, string | null> = {}
    for (const card of cards) {
      pressedByLabel[card.getAttribute('aria-label') ?? ''] = card.getAttribute('aria-pressed')
    }
    expect(pressedByLabel['Group alpha']).toBe('false')
    expect(pressedByLabel['Group beta']).toBe('true')
  })
})
