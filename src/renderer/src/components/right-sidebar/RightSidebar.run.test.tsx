import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Why: the right-sidebar pulls in heavy panel modules (file explorer,
// search, source control, checks, ports) and the global zustand store;
// each test seeds a small synthetic state via mocks instead, mirroring
// the WorktreeCardAgents test setup.

type StoreState = Record<string, unknown>

let mockState: StoreState = {}
let mockActiveWorktree: unknown = null
let mockActiveRepo: unknown = null

vi.mock('@/store', () => ({
  useAppStore: (selector?: (state: StoreState) => unknown) =>
    selector ? selector(mockState) : mockState
}))

vi.mock('@/store/selectors', () => ({
  useActiveWorktree: () => mockActiveWorktree,
  useRepoById: () => mockActiveRepo,
  getRepoMapFromState: () => new Map()
}))

vi.mock('@/hooks/useSidebarResize', () => ({
  useSidebarResize: () => ({ containerRef: { current: null }, onResizeStart: () => {} })
}))

vi.mock('./FileExplorer', () => ({ default: () => null }))
vi.mock('./SourceControl', () => ({ default: () => null }))
vi.mock('./Search', () => ({ default: () => null }))
vi.mock('./ChecksPanel', () => ({ default: () => null }))
vi.mock('./PortsPanel', () => ({ default: () => null }))

const ACTIVE_WORKTREE = { id: 'wt-1', repoId: 'repo-1', branch: 'main' }
const GIT_REPO = { id: 'repo-1', kind: 'git', path: '/tmp/repo' }
const FOLDER_REPO = { id: 'repo-1', kind: 'folder', path: '/tmp/folder' }

function baseState(overrides: Partial<StoreState> = {}): StoreState {
  return {
    rightSidebarOpen: true,
    rightSidebarWidth: 280,
    rightSidebarTab: 'explorer',
    activeWorktreeId: 'wt-1',
    worktreesByRepo: { 'repo-1': [ACTIVE_WORKTREE] },
    repos: [],
    prCache: {},
    sshConnectionStates: new Map(),
    activityBarPosition: 'top',
    setRightSidebarTab: () => {},
    setRightSidebarWidth: () => {},
    setActivityBarPosition: () => {},
    toggleRightSidebar: () => {},
    ...overrides
  }
}

beforeEach(() => {
  mockState = baseState()
  mockActiveWorktree = ACTIVE_WORKTREE
  mockActiveRepo = GIT_REPO
})

describe('RightSidebar activity bar — Run/Setup gating', () => {
  it('shows Run and Setup tabs for a git repo', async () => {
    const { default: RightSidebar } = await import('./index')
    const markup = renderToStaticMarkup(<RightSidebar />)

    expect(markup).toMatch(/aria-label="Run \(/)
    expect(markup).toMatch(/aria-label="Setup"/)
  })

  it('hides Run and Setup tabs for a folder repo', async () => {
    mockActiveRepo = FOLDER_REPO
    const { default: RightSidebar } = await import('./index')
    const markup = renderToStaticMarkup(<RightSidebar />)

    expect(markup).not.toMatch(/aria-label="Run \(/)
    expect(markup).not.toMatch(/aria-label="Setup"/)
  })
})
