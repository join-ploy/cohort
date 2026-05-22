// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { WorkspaceGroup, Worktree } from '../../../shared/types'
import type * as SelectorsModule from '@/store/selectors'

// Why: cmdk + Radix Dialog reach for ResizeObserver / hasPointerCapture /
// scrollIntoView in jsdom. Provide no-op shims so the palette dialog renders
// without crashing. Same pattern as GroupedComposerForm.test.tsx.
type ROCallback = () => void
class TestResizeObserver {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_cb: ROCallback) {
    /* no-op */
  }
  observe(): void {
    /* no-op */
  }
  unobserve(): void {
    /* no-op */
  }
  disconnect(): void {
    /* no-op */
  }
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

// Why: WorktreeJumpPalette consumes a wide surface of the app store. We stub
// the store with the minimal slice the palette reads, plus pass-throughs for
// the selectors the component calls directly. The single behavior under test
// here is "groups appear in the result list when the flag is on" (M3 of the
// grouped-workspaces plan), so we leave the worktree/browser/SSH branches
// empty to keep the seed small.

type StoreState = {
  activeModal: string | null
  closeModal: ReturnType<typeof vi.fn>
  openModal: ReturnType<typeof vi.fn>
  worktreesByRepo: Record<string, Worktree[]>
  repos: unknown[]
  tabsByWorktree: Record<string, unknown[]>
  runtimePaneTitlesByTabId: Record<string, unknown>
  ptyIdsByTabId: Record<string, unknown>
  prCache: Record<string, unknown>
  issueCache: Record<string, unknown>
  activeWorktreeId: string | null
  activeTabType: 'terminal' | 'editor' | 'browser'
  activeBrowserTabId: string | null
  browserTabsByWorktree: Record<string, unknown[]>
  browserPagesByWorkspace: Record<string, unknown[]>
  sshConnectionStates: Map<string, unknown>
  hideDefaultBranchWorkspace: boolean
  lastVisitedAtByWorktreeId: Record<string, number>
  workspaceGroups: WorkspaceGroup[]
  settings: { experimentalGroupedWorkspaces?: boolean } | null
}

const mocks = vi.hoisted(() => ({
  state: {
    activeModal: 'worktree-palette',
    closeModal: vi.fn(),
    openModal: vi.fn(),
    worktreesByRepo: {},
    repos: [],
    tabsByWorktree: {},
    runtimePaneTitlesByTabId: {},
    ptyIdsByTabId: {},
    prCache: {},
    issueCache: {},
    activeWorktreeId: null,
    activeTabType: 'terminal' as const,
    activeBrowserTabId: null,
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    sshConnectionStates: new Map<string, unknown>(),
    hideDefaultBranchWorkspace: false,
    lastVisitedAtByWorktreeId: {},
    workspaceGroups: [] as WorkspaceGroup[],
    settings: { experimentalGroupedWorkspaces: true } as StoreState['settings']
  } as StoreState
}))

vi.mock('@/store', () => {
  // Why: hoisted inside the factory so the call-and-getState shapes the
  // palette uses (both `useAppStore(selector)` and `useAppStore.getState()`)
  // are reachable without a top-level reference loop.
  function useAppStore<T>(selector: (state: StoreState) => T): T {
    return selector(mocks.state)
  }
  useAppStore.getState = (): StoreState => mocks.state
  return { useAppStore }
})

vi.mock('@/store/selectors', async () => {
  const actual = await vi.importActual<typeof SelectorsModule>('@/store/selectors')
  return {
    ...actual,
    useAllWorktrees: () => Object.values(mocks.state.worktreesByRepo).flat(),
    useWorkspaceGroups: () => mocks.state.workspaceGroups,
    getRepoMapFromState: () => new Map()
  }
})

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn() }
}))

// Why: focus management touches the DOM in ways jsdom does not implement
// fully (xterm/monaco textareas, dispatchEvent on window). Stub the helpers
// the palette calls on dismiss so renders don't throw.
vi.mock('@/components/browser-pane/browser-focus', () => ({
  ORCA_BROWSER_FOCUS_REQUEST_EVENT: 'orca-browser-focus',
  queueBrowserFocusRequest: vi.fn()
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

import WorktreeJumpPalette from './WorktreeJumpPalette'

function makeGroup(overrides: Partial<WorkspaceGroup> & { id: string }): WorkspaceGroup {
  return {
    workspaceName: overrides.id,
    displayName: overrides.id,
    parentPath: `/tmp/${overrides.id}`,
    memberWorktreeIds: ['repoA::/wt'],
    branchName: overrides.id,
    isArchived: false,
    archivedAt: null,
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

describe('<WorktreeJumpPalette /> groups (M3)', () => {
  beforeEach(() => {
    cleanup()
    mocks.state.workspaceGroups = []
    mocks.state.settings = { experimentalGroupedWorkspaces: true }
    mocks.state.activeModal = 'worktree-palette'
  })

  it('renders non-archived groups in the result list with a Group pill', () => {
    mocks.state.workspaceGroups = [
      makeGroup({ id: 'group:alpha', displayName: 'alpha_workspace' }),
      makeGroup({ id: 'group:beta', displayName: 'beta_workspace' })
    ]

    render(<WorktreeJumpPalette />)

    expect(screen.getByText('alpha_workspace')).toBeTruthy()
    expect(screen.getByText('beta_workspace')).toBeTruthy()
    // The "1 repo" pill is rendered per group row and distinguishes the row
    // from a worktree row. Each test group has 1 member so we expect one
    // pill per group.
    expect(screen.getAllByText('1 repo')).toHaveLength(2)
  })

  it('hides groups when the experimental flag is off', () => {
    mocks.state.settings = { experimentalGroupedWorkspaces: false }
    mocks.state.workspaceGroups = [makeGroup({ id: 'group:alpha', displayName: 'alpha_workspace' })]

    render(<WorktreeJumpPalette />)

    expect(screen.queryByText('alpha_workspace')).toBeNull()
  })

  it('hides archived groups', () => {
    mocks.state.workspaceGroups = [
      makeGroup({ id: 'group:alpha', displayName: 'alpha_workspace' }),
      makeGroup({
        id: 'group:archived',
        displayName: 'archived_workspace',
        isArchived: true,
        archivedAt: 1
      })
    ]

    render(<WorktreeJumpPalette />)

    expect(screen.getByText('alpha_workspace')).toBeTruthy()
    expect(screen.queryByText('archived_workspace')).toBeNull()
  })
})
