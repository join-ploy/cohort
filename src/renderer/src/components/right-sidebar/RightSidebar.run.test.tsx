import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScriptStatus, WorktreeScriptsEntry } from '@/store/slices/scripts'

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

const IDLE_SCRIPT = {
  ptyId: null,
  status: 'idle' as ScriptStatus,
  exitCode: null,
  startedAt: null
}

function scriptsEntry(overrides: {
  run?: Partial<WorktreeScriptsEntry['run']>
  setup?: Partial<WorktreeScriptsEntry['setup']>
}): WorktreeScriptsEntry {
  return {
    run: { ...IDLE_SCRIPT, ...overrides.run },
    setup: { ...IDLE_SCRIPT, ...overrides.setup }
  }
}

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
    scriptsByWorktree: {} as Record<string, WorktreeScriptsEntry>,
    setRightSidebarTab: () => {},
    setRightSidebarWidth: () => {},
    setActivityBarPosition: () => {},
    toggleRightSidebar: () => {},
    ...overrides
  }
}

function buttonHtmlFor(markup: string, label: RegExp): string {
  // Pull the <button …aria-label="…">…</button> element matching `label` so
  // tests can assert on the dot's classes without depending on document order.
  const re = new RegExp(`<button[^>]*aria-label="[^"]*${label.source}[^"]*"[^>]*>.*?</button>`)
  const match = markup.match(re)
  if (!match) {
    throw new Error(`button matching ${label} not found in markup`)
  }
  return match[0]
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

describe('RightSidebar activity bar — Run/Setup status dots', () => {
  it('Run dot shows amber-pulse while running and vanishes after exit', async () => {
    // Why: the activity-bar dot is a "live now" pulse — once the script exits
    // (success or failure) the dot vanishes. Final exit status is surfaced
    // inside the Run panel itself, not on the activity-bar icon.
    const { default: RightSidebar } = await import('./index')

    // idle: no dot
    mockState = baseState()
    let html = renderToStaticMarkup(<RightSidebar />)
    let runBtn = buttonHtmlFor(html, /Run \(/)
    expect(runBtn).not.toContain('bg-amber-500')
    expect(runBtn).not.toContain('bg-emerald-500')
    expect(runBtn).not.toContain('bg-rose-500')

    // running: amber + pulsing
    mockState = baseState({
      scriptsByWorktree: { 'wt-1': scriptsEntry({ run: { status: 'running', ptyId: 'p-1' } }) }
    })
    html = renderToStaticMarkup(<RightSidebar />)
    runBtn = buttonHtmlFor(html, /Run \(/)
    expect(runBtn).toContain('bg-amber-500')
    expect(runBtn).toContain('animate-pulse')

    // exited-success: no dot
    mockState = baseState({
      scriptsByWorktree: {
        'wt-1': scriptsEntry({ run: { status: 'exited-success', exitCode: 0 } })
      }
    })
    html = renderToStaticMarkup(<RightSidebar />)
    runBtn = buttonHtmlFor(html, /Run \(/)
    expect(runBtn).not.toContain('bg-amber-500')
    expect(runBtn).not.toContain('bg-emerald-500')
    expect(runBtn).not.toContain('bg-rose-500')

    // exited-failure: no dot
    mockState = baseState({
      scriptsByWorktree: {
        'wt-1': scriptsEntry({ run: { status: 'exited-failure', exitCode: 1 } })
      }
    })
    html = renderToStaticMarkup(<RightSidebar />)
    runBtn = buttonHtmlFor(html, /Run \(/)
    expect(runBtn).not.toContain('bg-amber-500')
    expect(runBtn).not.toContain('bg-emerald-500')
    expect(runBtn).not.toContain('bg-rose-500')
  })

  it('Setup dot shows amber-pulse while running and vanishes after exit', async () => {
    // Why: setup is a one-shot bootstrap script — keeping a green/red dot
    // around after it finishes feels like stale UI noise. Only the live
    // 'running' state surfaces a dot in the activity bar.
    const { default: RightSidebar } = await import('./index')

    mockState = baseState()
    let html = renderToStaticMarkup(<RightSidebar />)
    let setupBtn = buttonHtmlFor(html, /Setup/)
    expect(setupBtn).not.toContain('bg-amber-500')
    expect(setupBtn).not.toContain('bg-emerald-500')
    expect(setupBtn).not.toContain('bg-rose-500')

    mockState = baseState({
      scriptsByWorktree: { 'wt-1': scriptsEntry({ setup: { status: 'running', ptyId: 'p-2' } }) }
    })
    html = renderToStaticMarkup(<RightSidebar />)
    setupBtn = buttonHtmlFor(html, /Setup/)
    expect(setupBtn).toContain('bg-amber-500')
    expect(setupBtn).toContain('animate-pulse')

    mockState = baseState({
      scriptsByWorktree: {
        'wt-1': scriptsEntry({ setup: { status: 'exited-success', exitCode: 0 } })
      }
    })
    html = renderToStaticMarkup(<RightSidebar />)
    setupBtn = buttonHtmlFor(html, /Setup/)
    expect(setupBtn).not.toContain('bg-emerald-500')
    expect(setupBtn).not.toContain('bg-amber-500')
    expect(setupBtn).not.toContain('bg-rose-500')

    mockState = baseState({
      scriptsByWorktree: {
        'wt-1': scriptsEntry({ setup: { status: 'exited-failure', exitCode: 1 } })
      }
    })
    html = renderToStaticMarkup(<RightSidebar />)
    setupBtn = buttonHtmlFor(html, /Setup/)
    expect(setupBtn).not.toContain('bg-rose-500')
    expect(setupBtn).not.toContain('bg-emerald-500')
    expect(setupBtn).not.toContain('bg-amber-500')
  })
})
