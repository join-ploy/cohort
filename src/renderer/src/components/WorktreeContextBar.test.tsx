// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { GlobalSettings, Repo, Worktree } from '../../../shared/types'

// Why: WorktreeContextBar reaches into the store and into WorktreeContextMenu
// (its own large surface). Mock both so the test stays focused on the bar's own
// structure, visibility logic, and button routing.

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

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

type ApiMock = {
  hooks: { check: ReturnType<typeof vi.fn> }
  shell: {
    openPath: ReturnType<typeof vi.fn>
    openVscode: ReturnType<typeof vi.fn>
    openDatabase: ReturnType<typeof vi.fn>
  }
  externalTool: { run: ReturnType<typeof vi.fn> }
}

let api: ApiMock

function makeApi(databaseUrl = ''): ApiMock {
  return {
    hooks: {
      check: vi.fn().mockResolvedValue({
        hasHooks: Boolean(databaseUrl),
        hooks: databaseUrl ? { databaseUrl } : null,
        mayNeedUpdate: false
      })
    },
    shell: { openPath: vi.fn(), openVscode: vi.fn(), openDatabase: vi.fn() },
    externalTool: { run: vi.fn().mockResolvedValue({ ok: true }) }
  }
}

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

function settingsWith(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    externalEditorKind: 'vscode',
    externalEditorCommand: '',
    externalDiffCommand: '',
    externalDatabaseKind: 'url',
    externalDatabaseCommand: '',
    ...overrides
  } as Partial<GlobalSettings> as GlobalSettings
}

function baseState(overrides: Partial<StoreState> = {}): StoreState {
  return {
    activeView: 'terminal',
    activeWorktreeId: baseWorktree.id,
    rightSidebarOpen: false,
    toggleRightSidebar: vi.fn(),
    settings: settingsWith(),
    worktreesById: new Map<string, Worktree>([[baseWorktree.id, baseWorktree]]),
    reposById: new Map<string, Repo>([[baseRepo.id, baseRepo]]),
    ...overrides
  }
}

async function importBar() {
  const mod = await import('./WorktreeContextBar')
  return mod.default
}

describe('WorktreeContextBar — structure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api = makeApi()
    ;(window as unknown as { api: ApiMock }).api = api
    mockState = baseState()
  })

  it('renders the repo + worktree names and the path readout', async () => {
    const Bar = await importBar()
    const markup = renderToStaticMarkup(<Bar />)
    expect(markup).toContain('ploy-server')
    expect(markup).toContain('plo-3884-feature')
    expect(markup).toContain('/wt/feature')
  })

  it('renders all four external-tool buttons', async () => {
    const Bar = await importBar()
    const markup = renderToStaticMarkup(<Bar />)
    expect(markup).toContain('aria-label="Reveal in Finder"')
    expect(markup).toContain('aria-label="Open in database"')
    expect(markup).toContain('aria-label="Open in external editor"')
    expect(markup).toContain('aria-label="Open diff in external tool"')
  })

  it('hides the bar when no active worktree is selected', async () => {
    mockState = baseState({ activeWorktreeId: null })
    const Bar = await importBar()
    expect(renderToStaticMarkup(<Bar />)).toBe('')
  })

  it('hides the bar outside the terminal view', async () => {
    mockState = baseState({ activeView: 'settings' })
    const Bar = await importBar()
    expect(renderToStaticMarkup(<Bar />)).toBe('')
  })

  it('exposes the Ellipsis "Worktree actions" trigger', async () => {
    const Bar = await importBar()
    expect(renderToStaticMarkup(<Bar />)).toContain('aria-label="Worktree actions"')
  })

  it('marks the bar surface as a drag region and its controls as no-drag', async () => {
    const Bar = await importBar()
    const markup = renderToStaticMarkup(<Bar />)
    expect(markup).toContain('-webkit-app-region:drag')
    expect(markup).toContain('-webkit-app-region:no-drag')
  })
})

describe('WorktreeContextBar — button routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api = makeApi()
    ;(window as unknown as { api: ApiMock }).api = api
    mockState = baseState()
  })

  afterEach(() => cleanup())

  it('Finder reveals the worktree path', async () => {
    const Bar = await importBar()
    render(<Bar />)
    fireEvent.click(screen.getByLabelText('Reveal in Finder'))
    expect(api.shell.openPath).toHaveBeenCalledWith('/wt/feature')
  })

  it('Editor (VS Code preset) opens VS Code, not a custom command', async () => {
    const Bar = await importBar()
    render(<Bar />)
    fireEvent.click(screen.getByLabelText('Open in external editor'))
    expect(api.shell.openVscode).toHaveBeenCalledWith('/wt/feature')
    expect(api.externalTool.run).not.toHaveBeenCalled()
  })

  it('Editor (custom kind) runs the editor tool via IPC', async () => {
    mockState = baseState({
      settings: settingsWith({ externalEditorKind: 'custom', externalEditorCommand: 'emacsclient' })
    })
    const Bar = await importBar()
    render(<Bar />)
    fireEvent.click(screen.getByLabelText('Open in external editor'))
    expect(api.shell.openVscode).not.toHaveBeenCalled()
    expect(api.externalTool.run).toHaveBeenCalledWith({
      tool: 'editor',
      worktreeId: 'repo-1::/wt/feature',
      worktreePath: '/wt/feature',
      repoId: 'repo-1',
      workspaceName: 'wise_panther'
    })
  })

  it('Diff is faded and no-ops when no diff command is configured', async () => {
    const Bar = await importBar()
    render(<Bar />)
    const diff = screen.getByLabelText('Open diff in external tool')
    expect(diff.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(diff)
    expect(api.externalTool.run).not.toHaveBeenCalled()
  })

  it('Diff runs the diff tool when configured', async () => {
    mockState = baseState({ settings: settingsWith({ externalDiffCommand: 'emacsclient diff' }) })
    const Bar = await importBar()
    render(<Bar />)
    fireEvent.click(screen.getByLabelText('Open diff in external tool'))
    expect(api.externalTool.run).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'diff', worktreeId: 'repo-1::/wt/feature' })
    )
  })

  it('Database (custom kind) runs the database tool via IPC', async () => {
    mockState = baseState({
      settings: settingsWith({ externalDatabaseKind: 'custom', externalDatabaseCommand: 'dbeaver' })
    })
    const Bar = await importBar()
    render(<Bar />)
    fireEvent.click(screen.getByLabelText('Open in database'))
    expect(api.externalTool.run).toHaveBeenCalledWith(expect.objectContaining({ tool: 'database' }))
    expect(api.shell.openDatabase).not.toHaveBeenCalled()
  })

  it('Database (url preset) opens the resolved URL with ${WORKSPACE_NAME} substituted', async () => {
    api = makeApi('postgresql://localhost/${WORKSPACE_NAME}_dev')
    ;(window as unknown as { api: ApiMock }).api = api
    const Bar = await importBar()
    render(<Bar />)
    const dbButton = screen.getByLabelText('Open in database')
    // Why: the databaseUrl arrives from an async hooks.check effect, so wait for
    // the button to enable before clicking.
    await waitFor(() => expect(dbButton.getAttribute('aria-disabled')).toBe('false'))
    fireEvent.click(dbButton)
    expect(api.shell.openDatabase).toHaveBeenCalledWith('postgresql://localhost/wise_panther_dev')
    expect(api.externalTool.run).not.toHaveBeenCalled()
  })
})
