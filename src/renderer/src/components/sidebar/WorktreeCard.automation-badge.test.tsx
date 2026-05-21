import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree, Repo, WorktreeCardProperty } from '../../../../shared/types'
import type { AutomationRun, AutomationRunStatus } from '../../../../shared/automations-types'

// Why: WorktreeCard pulls in zustand, sub-components, and runtime-pane
// selectors. Mock the boundaries so the test focuses on the automation
// badge, mirroring the WorktreeCard.run-dot test setup.

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

// Why: Tooltip requires a TooltipProvider ancestor. The real WorktreeCard runs
// under App.tsx's provider, but renderToStaticMarkup-based unit tests don't
// stand one up. Stub the Tooltip primitives with passthrough renderers so the
// trigger span (carrying our data-automation-* markers) still emits.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children
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

function makeRun(id: string, status: AutomationRunStatus): AutomationRun {
  return {
    id,
    automationId: 'auto-1',
    title: 't',
    scheduledFor: 0,
    status,
    trigger: 'manual',
    workspaceId: 'repo-1::/wt',
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    error: null,
    startedAt: null,
    dispatchedAt: null,
    createdAt: 0
  }
}

function baseState(automationRunsById: Record<string, AutomationRun> = {}): StoreState {
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
    scriptsByWorktree: {},
    automationRunsById
  }
}

describe('WorktreeCard automation badge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockState = baseState()
  })

  it('renders no badge when the worktree was not created by automation', async () => {
    mockState = baseState()
    const { default: WorktreeCard } = await import('./WorktreeCard')
    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={baseWorktree} repo={baseRepo} isActive={false} />
    )
    expect(markup).not.toMatch(/data-automation-run-id/)
  })

  it('renders an animated badge when the matching run is still active', async () => {
    mockState = baseState({ 'run-1': makeRun('run-1', 'running') })
    const { default: WorktreeCard } = await import('./WorktreeCard')
    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={{ ...baseWorktree, createdByAutomationRunId: 'run-1' }}
        repo={baseRepo}
        isActive={false}
      />
    )
    expect(markup).toMatch(/data-automation-run-id=["']run-1["']/)
    expect(markup).toMatch(/data-automation-active=["']true["']/)
    expect(markup).toMatch(/animate-pulse/)
  })

  it('renders a static badge when the matching run has terminated', async () => {
    mockState = baseState({ 'run-1': makeRun('run-1', 'completed') })
    const { default: WorktreeCard } = await import('./WorktreeCard')
    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={{ ...baseWorktree, createdByAutomationRunId: 'run-1' }}
        repo={baseRepo}
        isActive={false}
      />
    )
    expect(markup).toMatch(/data-automation-run-id=["']run-1["']/)
    expect(markup).toMatch(/data-automation-active=["']false["']/)
    expect(markup).not.toMatch(/animate-pulse/)
  })

  it('renders a static badge when the run is absent from the cache (pruned/old)', async () => {
    mockState = baseState({})
    const { default: WorktreeCard } = await import('./WorktreeCard')
    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={{ ...baseWorktree, createdByAutomationRunId: 'run-gone' }}
        repo={baseRepo}
        isActive={false}
      />
    )
    expect(markup).toMatch(/data-automation-run-id=["']run-gone["']/)
    expect(markup).toMatch(/data-automation-active=["']false["']/)
    expect(markup).not.toMatch(/animate-pulse/)
  })
})
