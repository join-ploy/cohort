import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: TabBar renders SortableTab (terminals), BrowserTab, and EditorFileTab
// per item. The new memberBadge prop is the contract every aggregated sibling
// tab must receive — verify TabBar resolves the owner worktree's repo from the
// store maps and threads the badge down for each kind. Mocking the children
// keeps the assertion focused on the prop wiring instead of the children's
// own visual surface, which is covered by their own tests.

type StoreState = {
  gitStatusByWorktree: Record<string, never[]>
  settings: {
    terminalWindowsShell: 'powershell.exe' | 'cmd.exe' | 'wsl.exe'
    terminalWindowsPowerShellImplementation: 'auto' | 'powershell.exe' | 'pwsh.exe'
  }
  repos: { id: string; displayName: string; badgeColor: string }[]
  worktreesByRepo: Record<string, { id: string; repoId: string }[]>
}

const STATE: StoreState = {
  gitStatusByWorktree: {},
  settings: {
    terminalWindowsShell: 'powershell.exe',
    terminalWindowsPowerShellImplementation: 'auto'
  },
  repos: [
    { id: 'repoA', displayName: 'orca', badgeColor: '#aaaaaa' },
    { id: 'repoB', displayName: 'ploy-client', badgeColor: '#bb00bb' }
  ],
  worktreesByRepo: {
    repoA: [{ id: 'wt-a', repoId: 'repoA' }],
    repoB: [{ id: 'wt-b', repoId: 'repoB' }]
  }
}

const useAppStoreMock = vi.fn((selector: (state: StoreState) => unknown) => selector(STATE))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports
  return {
    ...actual,
    memo: <T>(component: T) => component,
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: <T>(factory: () => T) => factory(),
    useRef: <T>(current: T) => ({ current }),
    useState: <T>(initial: T) => [initial, vi.fn()] as const
  }
})

vi.mock('lucide-react', () => ({
  FilePlus: () => null,
  Globe: () => null,
  Plus: () => null,
  TerminalSquare: () => null
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: function SortableContext(props: { children?: unknown }) {
    return props.children
  }
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: Parameters<typeof useAppStoreMock>[0]) => useAppStoreMock(selector)
}))

vi.mock('../right-sidebar/status-display', () => ({
  buildStatusMap: () => new Map()
}))

vi.mock('../tab-group/tab-insertion', () => ({
  resolveTabIndicatorEdges: () => []
}))

vi.mock('@/components/editor/editor-labels', () => ({
  getEditorDisplayLabel: () => ''
}))

vi.mock('./SortableTab', () => ({
  default: function SortableTab(props: Record<string, unknown>) {
    return { type: 'SortableTab', props }
  }
}))

vi.mock('./EditorFileTab', () => ({
  default: function EditorFileTab(props: Record<string, unknown>) {
    return { type: 'EditorFileTab', props }
  }
}))

vi.mock('./BrowserTab', () => ({
  default: function BrowserTab(props: Record<string, unknown>) {
    return { type: 'BrowserTab', props }
  },
  getBrowserTabLabel: () => ''
}))

vi.mock('./QuickLaunchButton', () => ({
  QuickLaunchAgentMenuItems: function QuickLaunchAgentMenuItems() {
    return null
  }
}))

vi.mock('./shell-icons', () => ({
  ShellIcon: () => null
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: vi.fn()
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: function DropdownMenu(props: { children?: unknown }) {
    return { type: 'DropdownMenu', props }
  },
  DropdownMenuContent: function DropdownMenuContent(props: { children?: unknown }) {
    return { type: 'DropdownMenuContent', props }
  },
  DropdownMenuItem: function DropdownMenuItem(props: { children?: unknown }) {
    return { type: 'DropdownMenuItem', props }
  },
  DropdownMenuSeparator: function DropdownMenuSeparator() {
    return { type: 'DropdownMenuSeparator', props: {} }
  },
  DropdownMenuShortcut: function DropdownMenuShortcut(props: { children?: unknown }) {
    return { type: 'DropdownMenuShortcut', props }
  },
  DropdownMenuTrigger: function DropdownMenuTrigger(props: { children?: unknown }) {
    return { type: 'DropdownMenuTrigger', props }
  }
}))

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function findChildrenByType(node: unknown, typeName: string): ReactElementLike[] {
  const results: ReactElementLike[] = []
  const visit = (current: unknown): void => {
    if (current == null) {
      return
    }
    if (Array.isArray(current)) {
      for (const child of current) {
        visit(child)
      }
      return
    }
    if (typeof current === 'string' || typeof current === 'number') {
      return
    }
    const el = current as ReactElementLike
    const type = el.type as { name?: string } | string | undefined
    const matchedName = typeof type === 'string' ? type : type?.name
    if (matchedName === typeName) {
      results.push(el)
    }
    if (el.props && 'children' in el.props) {
      visit(el.props.children)
    }
  }
  visit(node)
  return results
}

async function renderTabBar(props: Record<string, unknown>): Promise<unknown> {
  const tabBarModule = await import('./TabBar')
  const candidate = tabBarModule.default as unknown as
    | ((props: Record<string, unknown>) => unknown)
    | { type: (props: Record<string, unknown>) => unknown }
  const TabBar = typeof candidate === 'function' ? candidate : candidate.type
  return TabBar({
    activeTabId: null,
    worktreeId: 'wt-a',
    expandedPaneByTabId: {},
    onActivate: () => {},
    onClose: () => {},
    onCloseOthers: () => {},
    onCloseToRight: () => {},
    onNewTerminalTab: () => {},
    onNewBrowserTab: () => {},
    onSetCustomTitle: () => {},
    onSetTabColor: () => {},
    onTogglePaneExpand: () => {},
    wslAvailable: false,
    ...props
  })
}

const TERMINAL_LOCAL = {
  id: 'term-local',
  unifiedTabId: 'u-local',
  ptyId: null,
  worktreeId: 'wt-a',
  title: 'Local',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
}

const TERMINAL_SIBLING = {
  id: 'term-sib',
  unifiedTabId: 'u-sib',
  ptyId: null,
  worktreeId: 'wt-b',
  title: 'Sibling',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
}

const EDITOR_SIBLING = {
  id: 'fileB',
  tabId: 'u-edit-sib',
  worktreeId: 'wt-b',
  relativePath: 'sib.ts',
  isDirty: false
}

const BROWSER_SIBLING = {
  id: 'brow-sib',
  worktreeId: 'wt-b',
  url: 'about:blank',
  title: 'Browser'
}

describe('TabBar member-badge wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    vi.stubGlobal('navigator', { userAgent: 'Mac' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('passes memberBadge=null to the local-worktree terminal tab', async () => {
    const element = await renderTabBar({
      tabs: [TERMINAL_LOCAL],
      tabBarOrder: ['term-local'],
      ownerByVisibleId: new Map([['term-sib', 'wt-b']])
    })
    const sortable = findChildrenByType(element, 'SortableTab')
    expect(sortable).toHaveLength(1)
    expect(sortable[0].props.memberBadge).toBeNull()
  })

  it('resolves the owner repo to a memberBadge for sibling-member terminal tabs', async () => {
    const element = await renderTabBar({
      tabs: [TERMINAL_LOCAL, TERMINAL_SIBLING],
      tabBarOrder: ['term-local', 'term-sib'],
      ownerByVisibleId: new Map([['term-sib', 'wt-b']])
    })
    const sortable = findChildrenByType(element, 'SortableTab')
    expect(sortable).toHaveLength(2)
    expect(sortable[0].props.memberBadge).toBeNull()
    expect(sortable[1].props.memberBadge).toEqual({ color: '#bb00bb', name: 'ploy-client' })
  })

  it('threads memberBadge through to sibling editor and browser tabs', async () => {
    const element = await renderTabBar({
      tabs: [TERMINAL_LOCAL],
      editorFiles: [EDITOR_SIBLING],
      browserTabs: [BROWSER_SIBLING],
      tabBarOrder: ['term-local', 'u-edit-sib', 'brow-sib'],
      ownerByVisibleId: new Map([
        ['u-edit-sib', 'wt-b'],
        ['brow-sib', 'wt-b']
      ])
    })
    const editorTabs = findChildrenByType(element, 'EditorFileTab')
    const browserTabs = findChildrenByType(element, 'BrowserTab')
    expect(editorTabs).toHaveLength(1)
    expect(browserTabs).toHaveLength(1)
    expect(editorTabs[0].props.memberBadge).toEqual({ color: '#bb00bb', name: 'ploy-client' })
    expect(browserTabs[0].props.memberBadge).toEqual({ color: '#bb00bb', name: 'ploy-client' })
  })
})
