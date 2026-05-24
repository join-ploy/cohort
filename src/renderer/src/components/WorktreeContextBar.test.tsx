import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo, Worktree } from '../../../shared/types'

// Why: WorktreeContextBar reaches into the store and into the existing
// WorktreeContextMenu (which is its own large surface). Mock both so the test
// stays focused on the bar's own structure + visibility logic — mirrors the
// other render-to-static-markup card tests in this codebase.

type StoreState = Record<string, unknown>

let mockState: StoreState = {}

vi.mock('@/store', () => ({
  useAppStore: (selector?: (state: StoreState) => unknown) =>
    selector ? selector(mockState) : mockState
}))

// Why: useWorktreeById / useRepoById internally call useAppStore with a
// memoized cached-map selector — stub the selector module directly so the
// fake store doesn't need to satisfy the cache machinery.
vi.mock('../store/selectors', () => ({
  useWorktreeById: (id: string | null) =>
    id ? ((mockState.worktreesById as Map<string, Worktree>).get(id) ?? null) : null,
  useRepoById: (id: string | null) =>
    id ? ((mockState.reposById as Map<string, Repo>).get(id) ?? null) : null,
  // Why: WorktreeContextBar now derives the breadcrumb's left segment from
  // the active worktree's owning group when one exists. Tests don't seed any
  // groups, so this stub always returns null and the bar falls back to the
  // standard "<repo> > <worktree>" shape.
  getGroupByWorktreeId: () => null
}))

vi.mock('./sidebar/WorktreeContextMenu', () => ({
  default: ({ children }: { children: unknown }) => children as never
}))

const baseRepo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'ploy-server',
  badgeColor: '#abcdef',
  addedAt: 0
} as Repo

const baseWorktree: Worktree = {
  id: 'repo-1::/wt/feature',
  repoId: 'repo-1',
  path: '/wt/feature',
  head: 'abc',
  branch: 'refs/heads/feature',
  isBare: false,
  isMainWorktree: false,
  displayName: 'plo-3884-feature',
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
} as Worktree

function baseState(overrides: Partial<StoreState> = {}): StoreState {
  return {
    activeView: 'terminal',
    activeWorktreeId: baseWorktree.id,
    worktreesById: new Map<string, Worktree>([[baseWorktree.id, baseWorktree]]),
    reposById: new Map<string, Repo>([[baseRepo.id, baseRepo]]),
    ...overrides
  }
}

describe('WorktreeContextBar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockState = baseState()
  })

  it('renders the repo + worktree names when both are present', async () => {
    const { default: WorktreeContextBar } = await import('./WorktreeContextBar')
    const markup = renderToStaticMarkup(<WorktreeContextBar />)
    expect(markup).toContain('ploy-server')
    expect(markup).toContain('plo-3884-feature')
    expect(markup).toContain('/wt/feature')
  })

  it('renders the repo color dot using the repo badgeColor', async () => {
    const { default: WorktreeContextBar } = await import('./WorktreeContextBar')
    const markup = renderToStaticMarkup(<WorktreeContextBar />)
    // Why: badgeColor is the fallback identity when no GitHub avatar can be
    // derived. Asserting the literal value keeps the fallback contract honest.
    expect(markup).toContain('background-color:#abcdef')
  })

  it('hides the bar when no active worktree is selected', async () => {
    mockState = baseState({ activeWorktreeId: null })
    const { default: WorktreeContextBar } = await import('./WorktreeContextBar')
    const markup = renderToStaticMarkup(<WorktreeContextBar />)
    expect(markup).toBe('')
  })

  it('hides the bar outside the terminal view', async () => {
    mockState = baseState({ activeView: 'settings' })
    const { default: WorktreeContextBar } = await import('./WorktreeContextBar')
    const markup = renderToStaticMarkup(<WorktreeContextBar />)
    expect(markup).toBe('')
  })

  it('exposes an Ellipsis "Worktree actions" trigger button', async () => {
    const { default: WorktreeContextBar } = await import('./WorktreeContextBar')
    const markup = renderToStaticMarkup(<WorktreeContextBar />)
    // Why: the ellipsis button is the discoverable entry point to the same
    // menu that's reachable via right-click. Asserting its aria-label ensures
    // it survives future redesigns of the bar.
    expect(markup).toContain('aria-label="Worktree actions"')
  })

  it('exposes an "open in external editor" action button', async () => {
    const { default: WorktreeContextBar } = await import('./WorktreeContextBar')
    const markup = renderToStaticMarkup(<WorktreeContextBar />)
    expect(markup).toContain('aria-label="Open in external editor"')
  })

  it('marks the bar surface as a drag region and its controls as no-drag', async () => {
    const { default: WorktreeContextBar } = await import('./WorktreeContextBar')
    const markup = renderToStaticMarkup(<WorktreeContextBar />)
    // Why: matches the titlebar contract — only the bar background is draggable
    // for the window; interactive controls must opt out to remain clickable.
    expect(markup).toContain('-webkit-app-region:drag')
    expect(markup).toContain('-webkit-app-region:no-drag')
  })
})
