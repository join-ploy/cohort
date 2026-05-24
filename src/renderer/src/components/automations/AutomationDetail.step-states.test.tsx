import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect, vi } from 'vitest'
import type {
  Automation,
  AutomationRun,
  AutomationRunStatus,
  Step,
  StepRunState
} from '../../../../shared/automations-types'
import type { Repo, Worktree } from '../../../../shared/types'

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

vi.mock('@/components/icons/LinearIcon', () => ({
  LinearIcon: () => null
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
  archivedAt: null,
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
        onCancelRun={noop}
        onRetryRunFromStep={noop}
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
        onCancelRun={noop}
        onRetryRunFromStep={noop}
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

  it('renders a Linear pill when run.context.trigger.linear.issue is present', async () => {
    const { AutomationDetail } = await import('./AutomationDetail')
    const runWithLinear: AutomationRun = {
      ...chainRun,
      id: 'r-linear',
      context: {
        trigger: {
          linear: {
            issue: {
              id: 'lin-1',
              identifier: 'ORC-42',
              title: 'Fix the thing',
              description: '',
              url: 'https://linear.app/foo',
              assigneeEmail: '',
              stateName: '',
              priority: 0
            }
          }
        }
      }
    }
    const markup = renderToStaticMarkup(
      <AutomationDetail
        automation={baseAutomation}
        runs={[runWithLinear]}
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
        onCancelRun={noop}
        onRetryRunFromStep={noop}
      />
    )
    expect(markup).toContain('ORC-42')
    expect(markup).toContain('Fix the thing')
    expect(markup).toContain('https://linear.app/foo')
  })

  it('does not render the Linear pill when no Linear context is attached', async () => {
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
        onCancelRun={noop}
        onRetryRunFromStep={noop}
      />
    )
    expect(markup).not.toContain('ORC-')
    expect(markup).not.toContain('linear.app')
  })
})

const seededRepo: Repo = {
  id: 'repo-1',
  path: '/repo/orca-repo',
  displayName: 'orca-repo',
  badgeColor: '#000',
  addedAt: 0
}

const automationWithAutoTrigger: Automation = {
  ...baseAutomation,
  autoTriggers: [
    {
      id: 'at-1',
      source: 'linear-issue',
      enabled: true,
      enabledAt: 0,
      rules: [
        {
          id: 'rule-1',
          conditions: [],
          projectId: 'repo-1'
        }
      ]
    }
  ]
}

describe('AutomationDetail trigger badge', () => {
  it('shows "Auto: Linear issue • Rule 1 (orca-repo)" for an auto-triggered run', async () => {
    const { AutomationDetail } = await import('./AutomationDetail')
    const autoRun: AutomationRun = {
      ...chainRun,
      id: 'r-auto',
      trigger: 'auto',
      triggerSource: 'linear-issue',
      triggerAutoTriggerId: 'at-1',
      triggerRuleId: 'rule-1'
    }
    const markup = renderToStaticMarkup(
      <AutomationDetail
        automation={automationWithAutoTrigger}
        runs={[autoRun]}
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
        onCancelRun={noop}
        onRetryRunFromStep={noop}
        repos={[seededRepo]}
      />
    )
    expect(markup).toContain('Auto: Linear issue • Rule 1 (orca-repo)')
  })

  it('shows "Manual" for a manually-triggered run', async () => {
    const { AutomationDetail } = await import('./AutomationDetail')
    const markup = renderToStaticMarkup(
      <AutomationDetail
        automation={baseAutomation}
        runs={[{ ...chainRun, trigger: 'manual' }]}
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
        onCancelRun={noop}
        onRetryRunFromStep={noop}
      />
    )
    expect(markup).toContain('Manual')
  })

  it('shows "Scheduled" for a scheduled run', async () => {
    const { AutomationDetail } = await import('./AutomationDetail')
    const markup = renderToStaticMarkup(
      <AutomationDetail
        automation={baseAutomation}
        runs={[{ ...chainRun, trigger: 'scheduled' }]}
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
        onCancelRun={noop}
        onRetryRunFromStep={noop}
      />
    )
    expect(markup).toContain('Scheduled')
  })

  it('shows "Auto: Linear issue • Rule deleted" when triggerRuleId no longer matches', async () => {
    const { AutomationDetail } = await import('./AutomationDetail')
    const autoRun: AutomationRun = {
      ...chainRun,
      trigger: 'auto',
      triggerSource: 'linear-issue',
      triggerAutoTriggerId: 'at-1',
      triggerRuleId: 'rule-vanished'
    }
    const markup = renderToStaticMarkup(
      <AutomationDetail
        automation={automationWithAutoTrigger}
        runs={[autoRun]}
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
        onCancelRun={noop}
        onRetryRunFromStep={noop}
        repos={[seededRepo]}
      />
    )
    expect(markup).toContain('Auto: Linear issue • Rule deleted')
  })
})

function makeRunWithStatus(
  status: AutomationRunStatus,
  overrides: Partial<AutomationRun> = {}
): AutomationRun {
  return { ...chainRun, ...overrides, status }
}

describe('AutomationDetail restart button', () => {
  const restartableStatuses: AutomationRunStatus[] = [
    'failed',
    'dispatch_failed',
    'cancelled',
    'skipped_missed',
    'skipped_unavailable',
    'skipped_needs_interactive_auth'
  ]

  for (const status of restartableStatuses) {
    it(`renders Restart run for status "${status}"`, async () => {
      const { AutomationDetail } = await import('./AutomationDetail')
      const markup = renderToStaticMarkup(
        <AutomationDetail
          automation={baseAutomation}
          runs={[makeRunWithStatus(status)]}
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
          onCancelRun={noop}
          onRetryRunFromStep={noop}
          onRestartRun={noop}
        />
      )
      expect(markup).toContain('Restart run')
    })
  }

  const nonRestartableStatuses: AutomationRunStatus[] = [
    'completed',
    'running',
    'pending',
    'dispatching',
    'dispatched'
  ]

  for (const status of nonRestartableStatuses) {
    it(`does NOT render Restart run for status "${status}"`, async () => {
      const { AutomationDetail } = await import('./AutomationDetail')
      const markup = renderToStaticMarkup(
        <AutomationDetail
          automation={baseAutomation}
          runs={[makeRunWithStatus(status)]}
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
          onCancelRun={noop}
          onRetryRunFromStep={noop}
          onRestartRun={noop}
        />
      )
      expect(markup).not.toContain('Restart run')
    })
  }

  it('hides Restart when onRestartRun is omitted', async () => {
    const { AutomationDetail } = await import('./AutomationDetail')
    const markup = renderToStaticMarkup(
      <AutomationDetail
        automation={baseAutomation}
        runs={[makeRunWithStatus('failed')]}
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
        onCancelRun={noop}
        onRetryRunFromStep={noop}
      />
    )
    expect(markup).not.toContain('Restart run')
  })
})

describe('AutomationDetail restart lineage', () => {
  it('renders "Restarted from #..." when restartedFromRunId is set', async () => {
    const { AutomationDetail } = await import('./AutomationDetail')
    const child: AutomationRun = {
      ...chainRun,
      id: 'r-child-aaaaaaaa',
      restartedFromRunId: 'r-parent-bbbbbbbb'
    }
    const markup = renderToStaticMarkup(
      <AutomationDetail
        automation={baseAutomation}
        runs={[child]}
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
        onCancelRun={noop}
        onRetryRunFromStep={noop}
      />
    )
    expect(markup).toContain('Restarted from #r-parent')
  })

  it('renders "Restarted as #..." when a sibling has restartedFromRunId pointing at this run', async () => {
    const { AutomationDetail } = await import('./AutomationDetail')
    const parent: AutomationRun = { ...chainRun, id: 'r-parent-cccccccc' }
    const child: AutomationRun = {
      ...chainRun,
      id: 'r-child-dddddddd',
      restartedFromRunId: 'r-parent-cccccccc'
    }
    const markup = renderToStaticMarkup(
      <AutomationDetail
        automation={baseAutomation}
        runs={[parent, child]}
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
        onCancelRun={noop}
        onRetryRunFromStep={noop}
      />
    )
    expect(markup).toContain('Restarted as #r-child-')
  })
})

describe('AutomationDetail auto-trigger overview', () => {
  // Why: the new auto-trigger summary only renders in the `isChain` branch
  // (trigger + steps present), so this fixture is a chain-shape automation
  // distinct from the rrule-only `baseAutomation`.
  const chainAutomationWithAutoTrigger: Automation = {
    ...baseAutomation,
    trigger: { kind: 'manual' },
    steps: [
      {
        id: 'wt',
        kind: 'create-worktree',
        config: {
          branchName: 'feature/x',
          baseBranch: 'main',
          workspaceMode: 'new_per_run'
        }
      } as unknown as Step
    ],
    autoTriggers: [
      {
        id: 'at-active',
        source: 'linear-issue',
        enabled: true,
        enabledAt: 0,
        rules: [
          {
            id: 'rule-empty',
            conditions: [],
            projectId: 'repo-1'
          },
          {
            id: 'rule-detailed',
            conditions: [
              {
                field: 'linear.assignee',
                op: 'is',
                value: 'me@example.com'
              },
              {
                field: 'linear.priority',
                op: 'gte',
                value: 2
              }
            ],
            projectId: 'repo-missing'
          }
        ]
      },
      {
        id: 'at-disabled',
        source: 'linear-issue',
        enabled: false,
        enabledAt: 0,
        rules: []
      }
    ]
  }

  it('surfaces auto triggers with source, badge state, rule count, and rule preview', async () => {
    const { AutomationDetail } = await import('./AutomationDetail')
    const markup = renderToStaticMarkup(
      <AutomationDetail
        automation={chainAutomationWithAutoTrigger}
        runs={[]}
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
        onCancelRun={noop}
        onRetryRunFromStep={noop}
        repos={[seededRepo]}
      />
    )
    // Section title and chrome
    expect(markup).toContain('Manual trigger')
    expect(markup).toContain('Automatic triggers')
    expect(markup).toContain('2 configured')
    // Source label + state badges
    expect(markup).toContain('Linear issue')
    expect(markup).toContain('Active')
    expect(markup).toContain('Disabled')
    // Rule preview (empty conditions → project name)
    expect(markup).toContain('Matches every event')
    expect(markup).toContain('orca-repo')
    // Conditions formatted with field + op + values
    expect(markup).toContain('assignee')
    expect(markup).toContain('me@example.com')
    expect(markup).toContain('priority')
    expect(markup).toContain('≥')
    expect(markup).toContain('High')
    // Deleted project chip when projectId is missing from repos
    expect(markup).toContain('project deleted')
    // Empty-rules trigger renders the explanatory line
    expect(markup).toContain('No rules')
  })

  it('omits the auto-triggers card when none are configured', async () => {
    const { AutomationDetail } = await import('./AutomationDetail')
    const chainOnly: Automation = {
      ...chainAutomationWithAutoTrigger,
      autoTriggers: undefined
    }
    const markup = renderToStaticMarkup(
      <AutomationDetail
        automation={chainOnly}
        runs={[]}
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
        onCancelRun={noop}
        onRetryRunFromStep={noop}
      />
    )
    expect(markup).toContain('Manual trigger')
    expect(markup).not.toContain('Automatic triggers')
  })
})

describe('isRestartable', () => {
  it('returns true for all 6 restartable statuses', async () => {
    const { isRestartable } = await import('./AutomationDetail')
    const restartable: AutomationRunStatus[] = [
      'failed',
      'dispatch_failed',
      'cancelled',
      'skipped_missed',
      'skipped_unavailable',
      'skipped_needs_interactive_auth'
    ]
    for (const status of restartable) {
      expect(isRestartable(status)).toBe(true)
    }
  })

  it('returns false for completed/running/pending/dispatching/dispatched', async () => {
    const { isRestartable } = await import('./AutomationDetail')
    const nonRestartable: AutomationRunStatus[] = [
      'completed',
      'running',
      'pending',
      'dispatching',
      'dispatched'
    ]
    for (const status of nonRestartable) {
      expect(isRestartable(status)).toBe(false)
    }
  })
})
