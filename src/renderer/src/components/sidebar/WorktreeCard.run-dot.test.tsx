import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree, Repo, WorktreeCardProperty } from '../../../../shared/types'
import type { ScriptStatus, WorktreeScriptsEntry } from '@/store/slices/scripts'

// Why: WorktreeCard pulls in zustand, sub-components, and runtime-pane
// selectors. Mock the boundaries so the test focuses on the run-dot
// indicator, mirroring the WorktreeCard.workspace-name test setup.

type StoreState = Record<string, unknown>

const cardProperties: readonly WorktreeCardProperty[] = []

let mockState: StoreState = {}

vi.mock('@/store', () => ({
  useAppStore: (selector?: (state: StoreState) => unknown) =>
    selector ? selector(mockState) : mockState
}))

vi.mock('zustand/react/shallow', () => ({
  useShallow: <T,>(fn: T) => fn
}))

vi.mock('./worktree-card-status-inputs', () => ({
  selectLivePtyIdsForWorktree: () => ({}),
  selectRuntimePaneTitlesForWorktree: () => ({})
}))

vi.mock('@/lib/worktree-status', () => ({
  getWorktreeStatusLabel: () => '',
  resolveWorktreeStatus: () => 'idle',
  WorktreeStatus: undefined
}))

vi.mock('@/lib/agent-status', () => ({
  isExplicitAgentStatusFresh: () => false,
  detectAgentStatusFromTitle: () => null
}))

vi.mock('./StatusIndicator', () => ({ default: () => null }))
vi.mock('./CacheTimer', () => ({ default: () => null }))
vi.mock('./WorktreeContextMenu', () => ({
  default: ({ children }: { children: unknown }) => children as never
}))
vi.mock('./SshDisconnectedDialog', () => ({ SshDisconnectedDialog: () => null }))
vi.mock('./WorktreeCardAgents', () => ({ default: () => null }))
vi.mock('./WorktreeCardMeta', () => ({
  IssueSection: () => null,
  PrSection: () => null,
  CommentSection: () => null
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

const baseWorktree: Worktree = {
  id: 'repo-1::/wt',
  repoId: 'repo-1',
  path: '/wt',
  head: 'abc',
  branch: 'refs/heads/feature-x',
  isBare: false,
  isMainWorktree: false,
  displayName: 'feature-x',
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

const baseRepo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
} as Repo

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

function baseState(scriptsByWorktree: Record<string, WorktreeScriptsEntry> = {}): StoreState {
  return {
    openModal: vi.fn(),
    updateWorktreeMeta: vi.fn(),
    fetchPRForBranch: vi.fn(),
    fetchIssue: vi.fn(),
    worktreeCardProperties: cardProperties,
    deleteStateByWorktreeId: {},
    gitConflictOperationByWorktree: {},
    remoteBranchConflictByWorktreeId: {},
    sshConnectionStates: new Map(),
    sshConnectionTargetsById: new Map(),
    sshTargetLabels: new Map(),
    tabsByWorktree: {},
    browserTabsByWorktree: {},
    prCache: {},
    issueCache: {},
    acknowledgedAgentsByPaneKey: {},
    retainedAgentStatuses: {},
    liveAgentStatuses: {},
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    agentStatusEpoch: 0,
    scriptsByWorktree
  }
}

describe('WorktreeCard run-script dot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockState = baseState()
  })

  it('shows an animated amber dot when the run script is running', async () => {
    mockState = baseState({
      [baseWorktree.id]: scriptsEntry({ run: { status: 'running', ptyId: 'p-1' } })
    })
    const { default: WorktreeCard } = await import('./WorktreeCard')
    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={baseWorktree} repo={baseRepo} isActive={false} />
    )
    expect(markup).toContain('Run script is running')
    expect(markup).toContain('bg-amber-500')
    expect(markup).toContain('animate-pulse')
  })

  it('renders no run dot when the run script is idle', async () => {
    mockState = baseState({
      [baseWorktree.id]: scriptsEntry({ run: { status: 'idle' } })
    })
    const { default: WorktreeCard } = await import('./WorktreeCard')
    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={baseWorktree} repo={baseRepo} isActive={false} />
    )
    expect(markup).not.toContain('Run script is running')
  })

  it('renders no run dot after the run script exits successfully', async () => {
    mockState = baseState({
      [baseWorktree.id]: scriptsEntry({ run: { status: 'exited-success', exitCode: 0 } })
    })
    const { default: WorktreeCard } = await import('./WorktreeCard')
    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={baseWorktree} repo={baseRepo} isActive={false} />
    )
    expect(markup).not.toContain('Run script is running')
  })

  it('renders no run dot after the run script exits with failure', async () => {
    mockState = baseState({
      [baseWorktree.id]: scriptsEntry({ run: { status: 'exited-failure', exitCode: 1 } })
    })
    const { default: WorktreeCard } = await import('./WorktreeCard')
    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={baseWorktree} repo={baseRepo} isActive={false} />
    )
    expect(markup).not.toContain('Run script is running')
  })
})
