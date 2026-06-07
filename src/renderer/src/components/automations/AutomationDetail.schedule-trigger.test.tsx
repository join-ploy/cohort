import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect, vi } from 'vitest'
import type { Automation, Step } from '../../../../shared/automations-types'
import type { Worktree } from '../../../../shared/types'

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
vi.mock('@/components/icons/LinearIcon', () => ({ LinearIcon: () => null }))

const noop = (): void => {}
const worktreeMap = new Map<string, Worktree>()

// Chain-shape automation (trigger + steps) so the auto-trigger summary renders;
// its lone auto-trigger is a schedule source with the by-design empty rules.
const scheduleAutomation: Automation = {
  id: 'a1',
  name: 'Nightly sweep',
  prompt: '',
  agentId: 'claude',
  projectId: 'p1',
  executionTargetType: 'local',
  executionTargetId: 'host-1',
  schedulerOwner: 'local_host_service',
  workspaceMode: 'new_per_run',
  workspaceId: 'wt-1',
  baseBranch: null,
  timezone: 'UTC',
  rrule: '',
  dtstart: 0,
  enabled: true,
  nextRunAt: 0,
  missedRunPolicy: 'run_once_within_grace',
  missedRunGraceMinutes: 0,
  createdAt: 0,
  updatedAt: 0,
  trigger: { kind: 'manual', acceptsLinearTicket: false, acceptsProjectSelection: false },
  steps: [
    {
      id: 'wt',
      kind: 'create-worktree',
      config: { branchName: 'feature/x', baseBranch: 'main', workspaceMode: 'new_per_run' }
    } as unknown as Step
  ],
  autoTriggers: [
    {
      id: 'at-sched',
      source: 'schedule',
      enabled: true,
      enabledAt: 0,
      rules: [],
      schedule: { cron: '0 9 * * *', timezone: 'UTC' }
    }
  ]
} as Automation

// Shared, untyped props bag spread onto the component (avoids an inline
// `import()` type annotation while still typechecking at the call site).
const commonProps = {
  runs: [],
  projectName: 'repo',
  workspaceName: 'feature-x',
  projectDefaultBaseRef: null,
  worktreeMap,
  now: 0,
  onRunNow: noop,
  onOpenRunWorkspace: noop,
  onEdit: noop,
  onToggle: noop,
  onDelete: noop,
  onCancelRun: noop,
  onRetryRunFromStep: noop,
  onRetryParallelStep: noop
}

describe('AutomationDetail — schedule trigger summary', () => {
  it('describes the cron recurrence instead of the "never fires" line', async () => {
    const { AutomationDetail } = await import('./AutomationDetail')
    const markup = renderToStaticMarkup(
      <AutomationDetail automation={scheduleAutomation} {...commonProps} />
    )
    // describeCron('0 9 * * *') → human recurrence; the empty-rules trigger
    // must NOT claim it never fires.
    expect(markup).toContain('Daily at 09:00')
    expect(markup).not.toContain('never fires')
  })

  it('falls back gracefully when the schedule config is missing', async () => {
    const { AutomationDetail } = await import('./AutomationDetail')
    const withoutSchedule: Automation = {
      ...scheduleAutomation,
      autoTriggers: [
        {
          id: 'at-sched',
          source: 'schedule',
          enabled: true,
          enabledAt: 0,
          rules: []
        }
      ]
    } as Automation
    const markup = renderToStaticMarkup(
      <AutomationDetail automation={withoutSchedule} {...commonProps} />
    )
    expect(markup).toContain('Schedule not configured')
    expect(markup).not.toContain('never fires')
  })
})

describe('ScheduleNextRun', () => {
  it('renders the next run wall-clock time, not a poll countdown', async () => {
    const { ScheduleNextRun } = await import('./AutomationDetail')
    const future = Date.UTC(2030, 0, 15, 9, 30)
    const expectedLabel = new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(future))
    const markup = renderToStaticMarkup(<ScheduleNextRun lastPollAt={future} />)
    expect(markup).toContain('Next run')
    expect(markup).toContain(expectedLabel)
    expect(markup).not.toContain('Next poll in')
    // Never leak the Unix epoch as a "next run".
    expect(markup).not.toContain('1970')
  })

  it('renders nothing when the trigger is not yet anchored (lastPollAt 0)', async () => {
    const { ScheduleNextRun } = await import('./AutomationDetail')
    expect(renderToStaticMarkup(<ScheduleNextRun lastPollAt={0} />)).toBe('')
  })
})
