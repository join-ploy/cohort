import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree, Repo, WorktreeCardProperty } from '../../../../shared/types'

// Why: WorktreeCard pulls in zustand, sub-components, and runtime-pane
// selectors. Mock the boundaries so the test focuses on whether the
// workspaceName sub-line renders under displayName, not on the rest of
// the card chrome. Mirrors the WorktreeCardAgents test setup pattern.

type StoreState = Record<string, unknown>

const cardProperties: readonly WorktreeCardProperty[] = []

const mockState: StoreState = {
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
  tabsByWorktree: {},
  browserTabsByWorktree: {},
  prCache: {},
  issueCache: {},
  acknowledgedAgentsByPaneKey: {},
  retainedAgentStatuses: {},
  liveAgentStatuses: {},
  agentStatusByPaneKey: {},
  retainedAgentsByPaneKey: {},
  agentStatusEpoch: 0
}

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

describe('WorktreeCard workspaceName sub-line', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the workspaceName under displayName when present', async () => {
    const { default: WorktreeCard } = await import('./WorktreeCard')
    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={baseWorktree} repo={baseRepo} isActive={false} />
    )
    expect(markup).toContain('wise_panther')
    expect(markup).toContain('feature-x')
  })

  it('omits the workspaceName span when the field is missing', async () => {
    const { default: WorktreeCard } = await import('./WorktreeCard')
    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={{ ...baseWorktree, workspaceName: '' }}
        repo={baseRepo}
        isActive={false}
      />
    )
    expect(markup).not.toContain('font-mono')
  })
})
