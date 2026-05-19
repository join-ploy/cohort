import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect, vi } from 'vitest'
import type { Automation, AutomationRun, StepRunState } from '../../../../shared/automations-types'
import type { Worktree } from '../../../../shared/types'

// Why: AutomationDetail pulls in tooltip + agent-catalog icons. Mock the
// boundaries so the test stays focused on the new step-states rendering.

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children
}))

vi.mock('@/lib/agent-catalog', () => ({
  AGENT_CATALOG: [{ id: 'claude', label: 'Claude Code' }],
  AgentIcon: () => null
}))

const baseAutomation: Automation = {
  id: 'a1',
  name: 'Nightly sweep',
  prompt: 'Do the thing',
  agentId: 'claude',
  projectId: 'p1',
  executionTargetType: 'local',
  executionTargetId: 'host-1',
  schedulerOwner: 'local_host_service',
  workspaceMode: 'existing',
  workspaceId: 'wt-1',
  baseBranch: null,
  timezone: 'America/Los_Angeles',
  rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
  dtstart: 0,
  enabled: true,
  nextRunAt: 0,
  missedRunPolicy: 'run_once_within_grace',
  missedRunGraceMinutes: 0,
  createdAt: 0,
  updatedAt: 0
}

const stepStates: StepRunState[] = [
  {
    stepId: 'create-wt',
    status: 'succeeded',
    startedAt: 100,
    finishedAt: 200,
    output: { worktreeId: 'wt-1' },
    error: null
  },
  {
    stepId: 'send-prompt',
    status: 'running',
    startedAt: 200,
    finishedAt: null,
    output: null,
    error: null
  },
  {
    stepId: 'review',
    status: 'failed',
    startedAt: null,
    finishedAt: null,
    output: null,
    error: 'reviewer not configured'
  }
]

const chainRun: AutomationRun = {
  id: 'r1',
  automationId: 'a1',
  title: 't',
  scheduledFor: 0,
  status: 'running',
  trigger: 'manual',
  workspaceId: 'wt-1',
  sessionKind: 'terminal',
  chatSessionId: null,
  terminalSessionId: null,
  error: null,
  startedAt: 100,
  dispatchedAt: null,
  createdAt: 0,
  stepStates,
  context: {}
}

const legacyRun: AutomationRun = {
  ...chainRun,
  id: 'r-legacy',
  stepStates: undefined,
  error: 'something exploded'
}

const baseWorktree: Worktree = {
  id: 'wt-1',
  repoId: 'repo-1',
  path: '/wt/feature',
  head: 'abc',
  branch: 'refs/heads/feature',
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
} as Worktree

const worktreeMap = new Map<string, Worktree>([[baseWorktree.id, baseWorktree]])

const noop = (): void => {}

describe('AutomationDetail step states', () => {
  it('renders a step row for each entry in stepStates with status pill + id', async () => {
    const { AutomationDetail } = await import('./AutomationDetail')
    const markup = renderToStaticMarkup(
      <AutomationDetail
        automation={baseAutomation}
        runs={[chainRun]}
        projectName="repo"
        workspaceName="feature-x"
        projectDefaultBaseRef={null}
        worktreeMap={worktreeMap}
        now={0}
        onRunNow={noop}
        onOpenRunWorkspace={noop}
        onEdit={noop}
        onToggle={noop}
        onDelete={noop}
      />
    )
    expect(markup).toContain('create-wt')
    expect(markup).toContain('send-prompt')
    expect(markup).toContain('review')
    expect(markup).toContain('succeeded')
    expect(markup).toContain('running')
    expect(markup).toContain('failed')
    expect(markup).toContain('reviewer not configured')
  })

  it('falls back to the legacy single-run summary when stepStates is missing', async () => {
    const { AutomationDetail } = await import('./AutomationDetail')
    const markup = renderToStaticMarkup(
      <AutomationDetail
        automation={baseAutomation}
        runs={[legacyRun]}
        projectName="repo"
        workspaceName="feature-x"
        projectDefaultBaseRef={null}
        worktreeMap={worktreeMap}
        now={0}
        onRunNow={noop}
        onOpenRunWorkspace={noop}
        onEdit={noop}
        onToggle={noop}
        onDelete={noop}
      />
    )
    // Step-row identifiers from the chain run must not appear in the legacy
    // rendering (no stepStates).
    expect(markup).not.toContain('create-wt')
    expect(markup).not.toContain('send-prompt')
    // Legacy markup still surfaces the run-level error and the existing
    // workspace label, proving the original single-row summary is intact.
    expect(markup).toContain('something exploded')
    expect(markup).toContain('feature-x')
  })
})
