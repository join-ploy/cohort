// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { WorkspaceGroup, Worktree } from '../../../../shared/types'
import { ARCHIVE_TTL_MS } from '../../../../shared/archive-constants'
import type * as SelectorsModule from '@/store/selectors'

type StoreState = {
  worktreesByRepo: Record<string, Worktree[]>
  workspaceGroups: WorkspaceGroup[]
  settings: { experimentalGroupedWorkspaces?: boolean } | null
  restoreWorktree: ReturnType<typeof vi.fn>
  openModal: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => {
  return {
    state: {
      worktreesByRepo: {},
      workspaceGroups: [],
      settings: null,
      restoreWorktree: vi.fn().mockResolvedValue(undefined),
      openModal: vi.fn()
    } as StoreState
  }
})

vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: StoreState) => T): T => selector(mocks.state)
}))

// Why: ArchivedSection consumes `useWorkspaceGroups` from the selectors module
// directly, so the bare `@/store` mock above does not intercept it. Stub the
// hook to read from the same shared state the rest of the tests seed.
vi.mock('@/store/selectors', async () => {
  const actual = await vi.importActual<typeof SelectorsModule>('@/store/selectors')
  return {
    ...actual,
    useWorkspaceGroups: () => mocks.state.workspaceGroups
  }
})

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

import { ArchivedSection } from './ArchivedSection'

function makeWorktree(overrides: Partial<Worktree> & { id: string }): Worktree {
  const { id, ...rest } = overrides
  return {
    id,
    repoId: 'repo1',
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
    isArchived: true,
    archivedAt: Date.now(),
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...rest
  }
}

function setArchived(worktrees: Worktree[]): void {
  mocks.state.worktreesByRepo = worktrees.length === 0 ? {} : { repo1: worktrees }
}

function makeGroup(overrides: Partial<WorkspaceGroup> & { id: string }): WorkspaceGroup {
  return {
    workspaceName: overrides.id,
    displayName: overrides.id,
    parentPath: `/tmp/workspaces/${overrides.id}`,
    memberWorktreeIds: [],
    branchName: overrides.id,
    isArchived: true,
    archivedAt: Date.now(),
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

// Why: Tooltip requires a provider, and rendering one inline keeps each test
// hermetic without bleeding into a global setup file.
function renderSection(): ReturnType<typeof render> {
  return render(
    <TooltipProvider delayDuration={0}>
      <ArchivedSection />
    </TooltipProvider>
  )
}

describe('<ArchivedSection />', () => {
  beforeEach(() => {
    // Why: vitest config doesn't include @testing-library/jest-dom (no auto
    // cleanup); without an explicit unmount, each test inherits the previous
    // test's DOM and getByRole('button', { name: /archived/i }) finds two.
    cleanup()
    setArchived([])
    mocks.state.workspaceGroups = []
    mocks.state.settings = null
    mocks.state.restoreWorktree.mockClear().mockResolvedValue(undefined)
    mocks.state.openModal.mockClear()
  })

  it('renders nothing when there are no archived worktrees', () => {
    const { container } = renderSection()
    expect(container.childElementCount).toBe(0)
  })

  it('lists archived worktrees with days remaining', async () => {
    const archivedAt = Date.now() - 3 * 24 * 60 * 60 * 1000
    setArchived([makeWorktree({ id: 'wt-a', displayName: 'My WT', archivedAt })])

    renderSection()

    // Why: the disclosure is collapsed by default; expand it to assert on row
    // contents.
    await userEvent.click(screen.getByRole('button', { name: /archived/i }))

    expect(screen.getByText('My WT')).toBeTruthy()
    expect(screen.getByText(/27 days left/i)).toBeTruthy()
  })

  it('Restore button calls restoreWorktree with the worktree id', async () => {
    setArchived([makeWorktree({ id: 'wt-a', displayName: 'My WT' })])
    renderSection()

    await userEvent.click(screen.getByRole('button', { name: /archived/i }))
    await userEvent.click(screen.getByRole('button', { name: /restore/i }))

    expect(mocks.state.restoreWorktree).toHaveBeenCalledWith('wt-a')
  })

  it('Delete now opens the delete-worktree modal for that worktree', async () => {
    setArchived([makeWorktree({ id: 'wt-a', displayName: 'My WT' })])
    renderSection()

    await userEvent.click(screen.getByRole('button', { name: /archived/i }))
    await userEvent.click(screen.getByRole('button', { name: /delete now/i }))

    expect(mocks.state.openModal).toHaveBeenCalledWith('delete-worktree', {
      worktreeId: 'wt-a'
    })
  })

  it('shows a "Cleanup blocked" badge when archiveCleanupError is set', async () => {
    setArchived([
      makeWorktree({
        id: 'wt-a',
        displayName: 'My WT',
        archivedAt: Date.now() - ARCHIVE_TTL_MS - 1000,
        archiveCleanupError: 'uncommitted changes'
      })
    ])
    renderSection()

    await userEvent.click(screen.getByRole('button', { name: /archived/i }))

    expect(screen.getByText(/cleanup blocked/i)).toBeTruthy()
    // Days-left text is suppressed when the badge is visible.
    expect(screen.queryByText(/days left/i)).toBeNull()
  })

  it('sorts archived worktrees with most recently archived first', async () => {
    const now = Date.now()
    setArchived([
      makeWorktree({ id: 'older', displayName: 'Older WT', archivedAt: now - 5000 }),
      makeWorktree({ id: 'newer', displayName: 'Newer WT', archivedAt: now - 1000 })
    ])
    renderSection()

    await userEvent.click(screen.getByRole('button', { name: /archived/i }))

    const names = screen.getAllByTestId('archived-worktree-name').map((el) => el.textContent)
    expect(names).toEqual(['Newer WT', 'Older WT'])
  })

  it('renders archived groups when experimentalGroupedWorkspaces is enabled', async () => {
    // Why: with no archived worktrees, the only way the section appears is if
    // archived groups are surfaced — proves the gate flips on.
    mocks.state.settings = { experimentalGroupedWorkspaces: true }
    mocks.state.workspaceGroups = [
      makeGroup({ id: 'group:1', displayName: 'My Group', archivedAt: Date.now() })
    ]

    renderSection()

    await userEvent.click(screen.getByRole('button', { name: /archived/i }))

    expect(screen.getByTestId('archived-group-row')).toBeTruthy()
    expect(screen.getByText('My Group')).toBeTruthy()
  })

  it('does not render archived groups when the flag is off', () => {
    mocks.state.settings = { experimentalGroupedWorkspaces: false }
    mocks.state.workspaceGroups = [
      makeGroup({ id: 'group:1', displayName: 'My Group', archivedAt: Date.now() })
    ]

    const { container } = renderSection()

    // Section is gone entirely because there are no archived worktrees and
    // the only archived group is gated out.
    expect(container.childElementCount).toBe(0)
    expect(screen.queryByTestId('archived-group-row')).toBeNull()
  })
})
