import React from 'react'
import { Pencil, Pause, Play, RotateCcw, Square, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AGENT_CATALOG, AgentIcon } from '@/lib/agent-catalog'
import { LinearIcon } from '@/components/icons/LinearIcon'
import type {
  Automation,
  AutomationRun,
  CreateWorktreeConfig,
  LinearIssuePayload,
  RunCommandConfig,
  RunPromptConfig,
  Step,
  StepRunState,
  StepRunStatus,
  TriggerConfig,
  WaitForSetupConfig
} from '../../../../shared/automations-types'
import type { Worktree } from '../../../../shared/types'
import { parseAutomationRrule } from '../../../../shared/automation-schedules'
import {
  formatAutomationDateTime,
  formatAutomationDateTimeWithRelative,
  getAutomationRunStatusLabel,
  getAutomationRunStatusVariant
} from './automation-page-parts'

type AutomationDetailProps = {
  automation: Automation | null
  runs: AutomationRun[]
  projectName: string
  workspaceName: string
  projectDefaultBaseRef: string | null
  worktreeMap: Map<string, Worktree>
  now: number
  onRunNow: (automation: Automation) => void
  onOpenRunWorkspace: (run: AutomationRun) => void
  onEdit: (automation: Automation) => void
  onToggle: (automation: Automation) => void
  onDelete: (automation: Automation) => void
  onCancelRun: (run: AutomationRun) => void
  onRetryRunFromStep: (run: AutomationRun, stepIndex: number) => void
}

function DetailMetric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-medium">{value}</div>
    </div>
  )
}

function formatTime(hour: number, minute: number): string {
  const date = new Date()
  date.setHours(hour, minute, 0, 0)
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  }).format(date)
}

function formatGrace(minutes: number): string {
  if (minutes <= 0) {
    return 'No grace'
  }
  if (minutes < 60) {
    return `${minutes} minutes`
  }
  const hours = minutes / 60
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
}

function formatSchedule(rrule: string): string {
  // Why: chain-shape automations are manual-only and persist an empty rrule.
  // parseAutomationRrule throws on that, so short-circuit here.
  if (!rrule) {
    return 'Manual'
  }
  const schedule = parseAutomationRrule(rrule)
  if (schedule.preset === 'hourly') {
    return `Hourly at :${String(schedule.minute).padStart(2, '0')}`
  }
  const time = formatTime(schedule.hour, schedule.minute)
  if (schedule.preset === 'daily') {
    return `Daily at ${time}`
  }
  if (schedule.preset === 'weekdays') {
    return `Weekdays at ${time}`
  }
  const day = new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(
    new Date(2026, 0, 4 + schedule.dayOfWeek)
  )
  return `${day}s at ${time}`
}

// Why: keep status → color mapping in one spot so chain step pills stay
// visually distinct from the top-level run pill (which uses semantic
// shadcn variants). These map directly to Tailwind tokens documented in
// docs/STYLEGUIDE.md — no new color values invented.
const STEP_STATUS_BADGE_CLASS: Record<StepRunStatus, string> = {
  pending: 'bg-muted text-muted-foreground',
  running: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  succeeded: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  failed: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  skipped: 'bg-muted text-muted-foreground italic',
  'timed-out': 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
}

// Why: run.context.trigger.linear.issue is materialized from RunNowPayload
// when an operator fires a Linear-attached run. The shape is untyped at the
// AutomationRun boundary (Record<string, unknown>), so we narrow it here
// instead of leaking `unknown` casts into the JSX below.
function extractLinearIssue(
  context: AutomationRun['context']
): Pick<LinearIssuePayload, 'identifier' | 'title' | 'url'> | null {
  if (!context || typeof context !== 'object') {
    return null
  }
  const trigger = (context as Record<string, unknown>).trigger
  if (!trigger || typeof trigger !== 'object') {
    return null
  }
  const linear = (trigger as Record<string, unknown>).linear
  if (!linear || typeof linear !== 'object') {
    return null
  }
  const issue = (linear as Record<string, unknown>).issue
  if (!issue || typeof issue !== 'object') {
    return null
  }
  const { identifier, title, url } = issue as Record<string, unknown>
  if (typeof identifier !== 'string' || typeof title !== 'string') {
    return null
  }
  return {
    identifier,
    title,
    url: typeof url === 'string' ? url : ''
  }
}

function LinearIssuePill({
  issue
}: {
  issue: Pick<LinearIssuePayload, 'identifier' | 'title' | 'url'>
}): React.JSX.Element {
  const label = (
    <>
      <LinearIcon className="size-3 shrink-0" />
      <span className="max-w-48 truncate">
        {issue.identifier} — {issue.title}
      </span>
    </>
  )
  // Why: empty url means the trigger source skipped the URL (older Linear
  // payloads), so render a non-interactive span rather than a dead anchor.
  const pillClass =
    'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-blue-500/10 text-blue-700 dark:text-blue-300'
  if (!issue.url) {
    return <span className={pillClass}>{label}</span>
  }
  return (
    <a
      href={issue.url}
      onClick={(e) => {
        e.preventDefault()
        // Why: stop the parent run row's onClick (open-workspace button) from
        // firing when the operator just wants to jump to the Linear issue.
        e.stopPropagation()
        window.api.shell.openPath(issue.url)
      }}
      className={`${pillClass} hover:bg-blue-500/20`}
    >
      {label}
    </a>
  )
}

function isChainAutomation(automation: Automation): boolean {
  return Boolean(automation.trigger && automation.steps && automation.steps.length > 0)
}

function describeTrigger(trigger: TriggerConfig): string {
  const inputs: string[] = []
  if (trigger.acceptsLinearTicket) {
    inputs.push('Linear ticket')
  }
  if (trigger.acceptsProjectSelection) {
    inputs.push('Project')
  }
  if (inputs.length === 0) {
    return 'Manual'
  }
  return `Manual — prompts for ${inputs.join(' + ')} on Run`
}

const STEP_KIND_LABELS: Record<Step['kind'], string> = {
  'create-worktree': 'Create worktree',
  'wait-for-setup': 'Wait for setup',
  'run-prompt': 'Run prompt',
  'run-command': 'Run command'
}

function firstNonEmptyLine(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return ''
  }
  const line = trimmed.split('\n')[0].trim()
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}

function describeStepConfig(step: Step): string {
  switch (step.kind) {
    case 'create-worktree': {
      const config = step.config as CreateWorktreeConfig
      const branch = config.branchName.trim() || '(auto)'
      const base = config.baseBranch.trim() || 'main'
      return `${branch} from ${base}`
    }
    case 'wait-for-setup': {
      const config = step.config as WaitForSetupConfig
      return config.requireSuccess ? 'Require success' : 'Allow failure'
    }
    case 'run-prompt': {
      const config = step.config as RunPromptConfig
      const agentLabel =
        AGENT_CATALOG.find((agent) => agent.id === config.agentId)?.label ?? config.agentId
      const promptPreview = firstNonEmptyLine(config.prompt)
      return promptPreview ? `${agentLabel}: ${promptPreview}` : agentLabel
    }
    case 'run-command': {
      const config = step.config as RunCommandConfig
      if (config.source === 'review') return 'Review'
      if (config.source === 'create-pr') return 'Create PR'
      const custom = (config as RunCommandConfig & { customCommand?: string }).customCommand
      return firstNonEmptyLine(custom ?? '') || 'Custom command'
    }
  }
}

function ChainStepRow({
  step,
  index
}: {
  step: Step
  index: number
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3 px-3 py-2 text-sm">
      <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
        {index + 1}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-medium text-foreground">{STEP_KIND_LABELS[step.kind]}</span>
          <span className="truncate font-mono text-xs text-muted-foreground">{step.id}</span>
        </div>
        <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">
          {describeStepConfig(step)}
        </p>
      </div>
    </div>
  )
}

function StepRunRow({
  step,
  onRetry
}: {
  step: StepRunState
  onRetry?: () => void
}): React.JSX.Element {
  // Why: retry is only meaningful for terminal states. A `running` or
  // `pending` step is the active edge of the chain; retrying it would race
  // the in-flight tick. `succeeded`/`skipped` are valid retry targets too —
  // operators sometimes want to re-run a successful step against fresh state.
  const canRetry =
    onRetry !== undefined && step.status !== 'running' && step.status !== 'pending'
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-sm">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={STEP_STATUS_BADGE_CLASS[step.status]}>
            {step.status}
          </Badge>
          <span className="truncate font-mono text-xs text-muted-foreground">{step.stepId}</span>
        </div>
        {step.error ? (
          <div className="ml-1 truncate text-xs text-rose-600 dark:text-rose-400">{step.error}</div>
        ) : null}
      </div>
      {canRetry ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Retry from this step"
              onClick={(e) => {
                e.stopPropagation()
                onRetry?.()
              }}
            >
              <RotateCcw className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={6}>
            Retry from this step
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  )
}

function ToolbarIconButton({
  label,
  children,
  onClick,
  className
}: {
  label: string
  children: React.ReactNode
  onClick: () => void
  className?: string
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          onClick={onClick}
          className={className}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export function AutomationDetail({
  automation,
  runs,
  projectName,
  workspaceName,
  projectDefaultBaseRef,
  worktreeMap,
  now,
  onRunNow,
  onOpenRunWorkspace,
  onEdit,
  onToggle,
  onDelete,
  onCancelRun,
  onRetryRunFromStep
}: AutomationDetailProps): React.JSX.Element {
  if (!automation) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Create an automation to start scheduling agent work.
      </div>
    )
  }

  const isChain = isChainAutomation(automation)
  const picksProjectAtRunTime = automation.trigger?.acceptsProjectSelection === true
  // Why: for chain-shape automations, the project/workspace fields don't make
  // sense as a static header — projects may be picked at run time and each
  // run creates its own workspace. Show a focused subtitle instead.
  const subtitle = isChain
    ? picksProjectAtRunTime
      ? 'Project picked at Run'
      : projectName
    : `${projectName} / ${workspaceName}`

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex items-start justify-between gap-4 border-b border-border/50 pb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{automation.name}</h2>
            <Badge variant={automation.enabled ? 'secondary' : 'outline'}>
              {automation.enabled ? 'Enabled' : 'Paused'}
            </Badge>
          </div>
          <p className="mt-1 truncate text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="secondary" size="sm" onClick={() => onRunNow(automation)}>
            <Play className="size-4" />
            Run Now
          </Button>
          <ToolbarIconButton label="Edit automation" onClick={() => onEdit(automation)}>
            <Pencil className="size-4" />
          </ToolbarIconButton>
          <ToolbarIconButton
            label={automation.enabled ? 'Pause automation' : 'Resume automation'}
            onClick={() => onToggle(automation)}
          >
            {automation.enabled ? <Pause className="size-4" /> : <Play className="size-4" />}
          </ToolbarIconButton>
          <ToolbarIconButton
            label="Delete automation"
            onClick={() => onDelete(automation)}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="size-4" />
          </ToolbarIconButton>
        </div>
      </div>

      {automation.executionTargetType === 'ssh' ? (
        <div className="rounded-md border border-border/50 bg-muted/50 p-3 text-sm text-muted-foreground shadow-sm">
          This SSH automation runs only while Orca can reach the SSH host. If reconnect needs
          interactive credentials or the host is unavailable, the run is recorded as skipped.
        </div>
      ) : null}

      {isChain ? (
        <>
          <div className="rounded-md border border-border/50 bg-muted/20 px-4 py-3 shadow-sm">
            <div className="text-[11px] font-medium uppercase text-muted-foreground">Trigger</div>
            <div className="mt-1 text-sm font-medium">{describeTrigger(automation.trigger!)}</div>
          </div>
          <div className="rounded-md border border-border/50 bg-muted/20 shadow-sm">
            <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
              <div className="text-sm font-medium">Steps</div>
              <div className="text-xs text-muted-foreground">
                {automation.steps!.length} {automation.steps!.length === 1 ? 'step' : 'steps'}
              </div>
            </div>
            <div className="divide-y divide-border/50">
              {automation.steps!.map((step, index) => (
                <ChainStepRow key={step.id} step={step} index={index} />
              ))}
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-6 rounded-md border border-border/50 bg-muted/30 px-4 py-3 shadow-sm">
            <DetailMetric label="Run location" value={`${projectName} / ${workspaceName}`} />
            <DetailMetric
              label="Next run"
              value={
                automation.enabled
                  ? formatAutomationDateTimeWithRelative(automation.nextRunAt, now)
                  : 'Paused'
              }
            />
            <DetailMetric
              label="Last run"
              value={formatAutomationDateTimeWithRelative(automation.lastRunAt, now)}
            />
            <DetailMetric label="Grace" value={formatGrace(automation.missedRunGraceMinutes)} />
          </div>

          <div className="rounded-md border border-border/50 bg-muted/20 shadow-sm">
            <div className="border-b border-border/50 px-3 py-2 text-sm font-medium">
              Configuration
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-6 gap-y-4 px-3 py-3">
              <div className="min-w-0">
                <div className="text-[11px] font-medium uppercase text-muted-foreground">Agent</div>
                <div className="mt-1 flex min-w-0 items-center gap-2 text-sm font-medium">
                  <AgentIcon agent={automation.agentId} size={16} />
                  <span className="truncate">
                    {AGENT_CATALOG.find((agent) => agent.id === automation.agentId)?.label ??
                      automation.agentId}
                  </span>
                </div>
              </div>
              <DetailMetric label="Schedule" value={formatSchedule(automation.rrule)} />
              <DetailMetric
                label={automation.workspaceMode === 'new_per_run' ? 'Create from' : 'Workspace'}
                value={
                  automation.workspaceMode === 'new_per_run'
                    ? (automation.baseBranch ?? projectDefaultBaseRef ?? 'Project default')
                    : workspaceName
                }
              />
              <div className="min-w-0">
                <div className="text-[11px] font-medium uppercase text-muted-foreground">Prompt</div>
                <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-sm text-foreground">
                  {automation.prompt}
                </p>
              </div>
            </div>
          </div>
        </>
      )}

      <div className="rounded-md border border-border/50 bg-muted/20 shadow-sm">
        <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
          <div className="text-sm font-medium">Run history</div>
          <div className="text-xs text-muted-foreground">{runs.length} runs</div>
        </div>
        <div className="grid grid-cols-[minmax(10rem,1fr)_minmax(6rem,auto)_2rem] gap-3 border-b border-border/50 px-3 py-1.5 text-[11px] font-medium uppercase text-muted-foreground">
          <div>Run</div>
          <div>Status</div>
          <div />
        </div>
        <div className="divide-y divide-border/50">
          {runs.map((run) => {
            const runWorktree = run.workspaceId ? (worktreeMap.get(run.workspaceId) ?? null) : null
            const linearIssue = extractLinearIssue(run.context)
            // Why: in-flight statuses are the only ones a Stop button can act
            // on. Terminal rows show an empty action slot so the grid stays
            // aligned without an enabled-but-pointless button.
            const isInFlight =
              run.status === 'running' ||
              run.status === 'pending' ||
              run.status === 'dispatching'
            const rowClassName =
              'grid grid-cols-[minmax(10rem,1fr)_minmax(6rem,auto)_2rem] items-center gap-3 px-3 py-2 text-left text-sm outline-none transition-colors'
            const rowContent = (
              <>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span>{formatAutomationDateTime(run.scheduledFor)}</span>
                    {linearIssue ? <LinearIssuePill issue={linearIssue} /> : null}
                  </div>
                  {run.error ? (
                    <div className="mt-1 truncate text-xs text-muted-foreground">{run.error}</div>
                  ) : null}
                </div>
                <div className="flex justify-start">
                  <Badge variant={getAutomationRunStatusVariant(run.status)}>
                    {getAutomationRunStatusLabel(run.status)}
                  </Badge>
                </div>
                <div className="flex justify-end">
                  {isInFlight ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Stop run"
                          onClick={(e) => {
                            e.stopPropagation()
                            onCancelRun(run)
                          }}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <Square className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="left" sideOffset={6}>
                        Stop run
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                </div>
              </>
            )
            const hasStepStates = Boolean(run.stepStates && run.stepStates.length > 0)
            // Why: chain runs (`stepStates` present) get a per-step breakdown
            // appended below the existing summary row; legacy runs keep their
            // single-row rendering untouched.
            const stepList = hasStepStates ? (
              <div className="flex flex-col gap-0 border-t border-border/50 bg-background/60 py-1">
                {run.stepStates!.map((step, index) => (
                  <StepRunRow
                    key={step.stepId}
                    step={step}
                    onRetry={() => onRetryRunFromStep(run, index)}
                  />
                ))}
              </div>
            ) : null
            return (
              <div key={run.id}>
                {runWorktree ? (
                  <button
                    type="button"
                    className={`${rowClassName} w-full cursor-pointer hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50`}
                    onClick={() => onOpenRunWorkspace(run)}
                  >
                    {rowContent}
                  </button>
                ) : (
                  <div className={rowClassName}>{rowContent}</div>
                )}
                {stepList}
              </div>
            )
          })}
          {runs.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">No runs yet.</div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
