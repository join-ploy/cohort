import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings, Repo, Worktree } from '../../../shared/types'

// Why: WorktreeContextBar reaches into the store and into WorktreeContextMenu
// (its own large surface). Mock both so the test stays focused on the bar's own
// structure + visibility logic — mirrors the other render-to-static-markup card
// tests in this codebase.

type StoreState = Record<string, unknown>
let mockState: StoreState = {}

vi.mock('@/store', () => ({
  useAppStore: (selector?: (state: StoreState) => unknown) =>
    selector ? selector(mockState) : mockState
}))

vi.mock('../store/selectors', () => ({
  useWorktreeById: (id: string | null) =>
    id ? ((mockState.worktreesById as Map<string, Worktree>).get(id) ?? null) : null,
  useRepoById: (id: string | null) =>
    id ? ((mockState.reposById as Map<string, Repo>).get(id) ?? null) : null,
  getGroupByWorktreeId: () => null
}))

vi.mock('./sidebar/WorktreeContextMenu', () => ({
  default: ({ children }: { children: unknown }) => children as never
}))

// Why: the bar's hooks.check effect does not fire under renderToStaticMarkup
// (no useEffect in SSR), but stub window.api so any click handler wiring that is
// constructed during render has a target if invoked.
vi.stubGlobal('window', {
  ...globalThis.window,
  api: {
    hooks: { check: () => Promise.resolve({ hasHooks: false, hooks: null, mayNeedUpdate: false }) },
    shell: { openPath: vi.fn(), openVscode: vi.fn(), openDatabase: vi.fn() },
    externalTool: { run: vi.fn() }
  }
})

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

const baseSettings = {
  externalEditorKind: 'vscode',
  externalEditorCommand: '',
  externalDiffCommand: '',
  externalDatabaseKind: 'url',
  externalDatabaseCommand: ''
} as Partial<GlobalSettings> as GlobalSettings

function baseState(overrides: Partial<StoreState> = {}): StoreState {
  return {
    activeView: 'terminal',
    activeWorktreeId: baseWorktree.id,
    rightSidebarOpen: false,
    settings: baseSettings,
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

  it('renders the repo + worktree names and the path readout', async () => {
    const { default: WorktreeContextBar } = await import('./WorktreeContextBar')
    const markup = renderToStaticMarkup(<WorktreeContextBar />)
    expect(markup).toContain('ploy-server')
    expect(markup).toContain('plo-3884-feature')
    expect(markup).toContain('/wt/feature')
  })

  it('renders all four external-tool buttons', async () => {
    const { default: WorktreeContextBar } = await import('./WorktreeContextBar')
    const markup = renderToStaticMarkup(<WorktreeContextBar />)
    expect(markup).toContain('aria-label="Reveal in Finder"')
    expect(markup).toContain('aria-label="Open in database"')
    expect(markup).toContain('aria-label="Open in external editor"')
    expect(markup).toContain('aria-label="Open diff in external tool"')
  })

  it('hides the bar when no active worktree is selected', async () => {
    mockState = baseState({ activeWorktreeId: null })
    const { default: WorktreeContextBar } = await import('./WorktreeContextBar')
    expect(renderToStaticMarkup(<WorktreeContextBar />)).toBe('')
  })

  it('hides the bar outside the terminal view', async () => {
    mockState = baseState({ activeView: 'settings' })
    const { default: WorktreeContextBar } = await import('./WorktreeContextBar')
    expect(renderToStaticMarkup(<WorktreeContextBar />)).toBe('')
  })

  it('exposes the Ellipsis "Worktree actions" trigger', async () => {
    const { default: WorktreeContextBar } = await import('./WorktreeContextBar')
    const markup = renderToStaticMarkup(<WorktreeContextBar />)
    expect(markup).toContain('aria-label="Worktree actions"')
  })

  it('marks the bar surface as a drag region and its controls as no-drag', async () => {
    const { default: WorktreeContextBar } = await import('./WorktreeContextBar')
    const markup = renderToStaticMarkup(<WorktreeContextBar />)
    expect(markup).toContain('-webkit-app-region:drag')
    expect(markup).toContain('-webkit-app-region:no-drag')
  })
})
