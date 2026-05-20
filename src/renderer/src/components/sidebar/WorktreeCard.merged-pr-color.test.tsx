import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree, Repo, WorktreeCardProperty, PRInfo } from '../../../../shared/types'

// Why: WorktreeCard pulls in zustand + sub-components; mock the boundaries so
// the test focuses on whether the displayName color flips to GitHub
// merged-purple when the linked PR is merged. Mirrors the
// WorktreeCard.workspace-name test setup.

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
  workspaceName: '',
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
}

const baseRepo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
} as Repo

function basePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 7,
    title: 'Some PR',
    state: 'open',
    url: 'https://github.com/x/y/pull/7',
    checksStatus: 'success',
    updatedAt: '2026-05-13T00:00:00Z',
    mergeable: 'MERGEABLE',
    ...overrides
  }
}

function baseState(prEntry?: PRInfo | null): StoreState {
  const cacheKey = '/repo::feature-x'
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
    prCache: prEntry === undefined ? {} : { [cacheKey]: { data: prEntry, fetchedAt: Date.now() } },
    issueCache: {},
    acknowledgedAgentsByPaneKey: {},
    retainedAgentStatuses: {},
    liveAgentStatuses: {},
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    agentStatusEpoch: 0,
    scriptsByWorktree: {}
  }
}

describe('WorktreeCard merged-PR displayName color', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('paints the displayName GitHub merged-purple when the PR is merged', async () => {
    mockState = baseState(basePR({ state: 'merged' }))
    const { default: WorktreeCard } = await import('./WorktreeCard')
    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={baseWorktree} repo={baseRepo} isActive={false} />
    )
    expect(markup).toContain('text-[#8957e5]')
  })

  it('omits the purple class when the PR is open', async () => {
    mockState = baseState(basePR({ state: 'open' }))
    const { default: WorktreeCard } = await import('./WorktreeCard')
    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={baseWorktree} repo={baseRepo} isActive={false} />
    )
    expect(markup).not.toContain('text-[#8957e5]')
  })

  it('omits the purple class when the PR is closed (unmerged)', async () => {
    mockState = baseState(basePR({ state: 'closed' }))
    const { default: WorktreeCard } = await import('./WorktreeCard')
    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={baseWorktree} repo={baseRepo} isActive={false} />
    )
    expect(markup).not.toContain('text-[#8957e5]')
  })

  it('omits the purple class when there is no PR cached', async () => {
    mockState = baseState()
    const { default: WorktreeCard } = await import('./WorktreeCard')
    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={baseWorktree} repo={baseRepo} isActive={false} />
    )
    expect(markup).not.toContain('text-[#8957e5]')
  })
})
