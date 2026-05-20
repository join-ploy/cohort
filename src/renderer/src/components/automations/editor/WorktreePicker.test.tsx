import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../../shared/types'

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

function stateWith(worktreesByRepo: Record<string, Worktree[]>): StoreState {
  return { worktreesByRepo }
}

describe('WorktreePicker', () => {
  beforeEach(() => {
    mockState = stateWith({})
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
})
