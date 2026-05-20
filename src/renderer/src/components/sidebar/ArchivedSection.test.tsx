// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Worktree } from '../../../../shared/types'
import { ARCHIVE_TTL_MS } from '../../../../shared/archive-constants'

type StoreState = {
  worktreesByRepo: Record<string, Worktree[]>
  restoreWorktree: ReturnType<typeof vi.fn>
  openModal: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => {
  return {
    state: {
      worktreesByRepo: {},
      restoreWorktree: vi.fn().mockResolvedValue(undefined),
      openModal: vi.fn()
    } as StoreState
  }
})

vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: StoreState) => T): T => selector(mocks.state)
}))

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
})
