// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { GlobalSettings, Repo, WorkspaceGroup, Worktree } from '../../../shared/types'

// Why: Radix DropdownMenu (the repo switcher) reaches for ResizeObserver /
// hasPointerCapture / scrollIntoView in jsdom; shim them so opening the menu
// doesn't crash. Same pattern as WorktreeJumpPalette.groups.test.tsx.
class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: typeof TestResizeObserver }).ResizeObserver =
  TestResizeObserver
if (
  typeof Element !== 'undefined' &&
  typeof (Element.prototype as unknown as { hasPointerCapture?: unknown }).hasPointerCapture !==
    'function'
) {
  ;(Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture = () =>
    false
}
if (
  typeof Element !== 'undefined' &&
  typeof (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView !==
    'function'
) {
  ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
}

// Why: WorktreeContextBar reaches into the store and into WorktreeContextMenu
// (its own large surface). Mock both so the test stays focused on the bar's own
// structure, visibility logic, and button routing.

type StoreState = Record<string, unknown>
let mockState: StoreState = {}

// Why: the repo switcher focuses a member via the store's setActiveWorktree
// action (a lightweight switch, no agent spawn). Capture it module-side so the
// switch test can assert which member was focused.
const setActiveWorktreeMock = vi.fn()

vi.mock('@/store', () => ({
  useAppStore: (selector?: (state: StoreState) => unknown) =>
    selector ? selector(mockState) : mockState
}))

// Why: thin mocks that read the group/member/repo shape off mockState so each
// test can opt into a grouped workspace without a real store.
vi.mock('../store/selectors', () => ({
  useWorktreeById: (id: string | null) =>
    id ? ((mockState.worktreesById as Map<string, Worktree>).get(id) ?? null) : null,
  useRepoById: (id: string | null) =>
    id ? ((mockState.reposById as Map<string, Repo>).get(id) ?? null) : null,
  getGroupByWorktreeId: () => (mockState.group as WorkspaceGroup | null) ?? null,
  getMemberWorktreesForGroup: () => (mockState.groupMembers as Worktree[]) ?? [],
  getRepoMapFromState: () => (mockState.reposById as Map<string, Repo>) ?? new Map()
}))

vi.mock('./sidebar/WorktreeContextMenu', () => ({
  default: ({ children }: { children: unknown }) => children as never
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

type ApiMock = {
  app: { getHomeDir: ReturnType<typeof vi.fn> }
  hooks: { check: ReturnType<typeof vi.fn> }
  shell: {
    openPath: ReturnType<typeof vi.fn>
    openVscode: ReturnType<typeof vi.fn>
    openDatabase: ReturnType<typeof vi.fn>
  }
  externalTool: { run: ReturnType<typeof vi.fn> }
}

let api: ApiMock

function makeApi(databaseUrl = '', homeDir = '/Users/hoyon'): ApiMock {
  return {
    app: { getHomeDir: vi.fn().mockResolvedValue(homeDir) },
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
    setActiveWorktree: setActiveWorktreeMock,
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

  it('collapses the home prefix of the path readout to ~', async () => {
    const homeWorktree = {
      ...baseWorktree,
      id: 'repo-1::/Users/hoyon/orca/ws/abc',
      path: '/Users/hoyon/orca/ws/abc'
    } as Worktree
    mockState = baseState({
      activeWorktreeId: homeWorktree.id,
      worktreesById: new Map<string, Worktree>([[homeWorktree.id, homeWorktree]])
    })
    const Bar = await importBar()
    render(<Bar />)
    // findByText waits for the async getHomeDir effect to resolve + re-render.
    expect(await screen.findByText('~/orca/ws/abc')).toBeTruthy()
  })

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
      workspaceName: 'wise_panther',
      displayName: 'plo-3884-feature'
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

describe('WorktreeContextBar — group repo switcher', () => {
  const repoWeb = {
    ...baseRepo,
    id: 'repo-2',
    displayName: 'ploy-web',
    badgeColor: '#22cc88'
  } as Repo
  const memberWeb = {
    ...baseWorktree,
    id: 'repo-2::/wt/web',
    path: '/wt/web',
    repoId: 'repo-2',
    displayName: 'web-feature'
  } as Worktree
  const group = {
    id: 'group:1',
    displayName: 'team_build',
    memberWorktreeIds: [baseWorktree.id, memberWeb.id]
  } as WorkspaceGroup

  function groupState(): StoreState {
    return baseState({
      group,
      groupMembers: [baseWorktree, memberWeb],
      reposById: new Map<string, Repo>([
        [baseRepo.id, baseRepo],
        [repoWeb.id, repoWeb]
      ]),
      worktreesById: new Map<string, Worktree>([
        [baseWorktree.id, baseWorktree],
        [memberWeb.id, memberWeb]
      ])
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    api = makeApi()
    ;(window as unknown as { api: ApiMock }).api = api
    mockState = groupState()
  })

  afterEach(() => cleanup())

  it('renders a repo switcher in place of the plain path readout', async () => {
    const Bar = await importBar()
    render(<Bar />)
    expect(screen.getByRole('button', { name: 'Switch repo' })).toBeTruthy()
  })

  it('selecting a member focuses that repo via setActiveWorktree (no agent spawn)', async () => {
    const Bar = await importBar()
    render(<Bar />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Switch repo' }))
    await user.click(screen.getByRole('menuitem', { name: /ploy-web/ }))
    expect(setActiveWorktreeMock).toHaveBeenCalledWith('repo-2::/wt/web')
  })

  it('stays a plain readout (no switcher) for a single-member group', async () => {
    mockState = baseState({ group, groupMembers: [baseWorktree] })
    const Bar = await importBar()
    render(<Bar />)
    expect(screen.queryByRole('button', { name: 'Switch repo' })).toBeNull()
  })
})
