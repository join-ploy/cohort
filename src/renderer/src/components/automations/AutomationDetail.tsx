import React from 'react'
import { Pencil, Pause, Play, RotateCcw, Square, Trash2, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AGENT_CATALOG, AgentIcon } from '@/lib/agent-catalog'
import { LinearIcon } from '@/components/icons/LinearIcon'
import type {
  AutoTrigger,
  Automation,
  AutomationRun,
  AutomationRunStatus,
  Condition,
  ConditionOp,
  CreateWorkspaceGroupConfig,
  CreateWorktreeConfig,
  LinearIssuePayload,
  Rule,
  RunCommandConfig,
  RunPromptConfig,
  Step,
  StepOrGroup,
  StepRunState,
  StepRunStatus,
  TriggerConfig,
  TriggerSourceId,
  UpdateLinearIssueConfig,
  WaitForSetupConfig
} from '../../../../shared/automations-types'
import type { Repo, Worktree } from '../../../../shared/types'
import { parseAutomationRrule } from '../../../../shared/automation-schedules'
import {
  isMemberScopedRef,
  parseMemberScopedRef
} from '../../../../shared/automation-member-scoped-ref'
import { splitWorktreeId } from '../../../../shared/worktree-id'
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
  /** Optional restart handler; if omitted, the Restart button is hidden.
   *  Kept optional so the existing test fixtures (which omit run-action
   *  callbacks) don't widen into more tc:web errors. */
  onRestartRun?: (run: AutomationRun) => void
  /** All repos in the workspace; used to label auto-trigger rule projects in
   *  the run header. Optional so legacy call sites keep compiling. */
  repos?: Repo[]
}

// Why: restart is meaningful only for terminal failure-ish states. `completed`
// and in-flight statuses (running/pending/dispatching/dispatched) are excluded.
const RESTARTABLE_STATUSES = new Set<AutomationRunStatus>([
  'failed',
  'dispatch_failed',
  'cancelled',
  'skipped_missed',
  'skipped_unavailable',
  'skipped_needs_interactive_auth'
])

export function isRestartable(status: AutomationRunStatus): boolean {
  return RESTARTABLE_STATUSES.has(status)
}

// Why: run IDs are UUIDs; the first 8 hex chars are enough to disambiguate
// in the lineage links without bloating the header.
function shortId(id: string): string {
  return id.slice(0, 8)
}

function findRestartChildren(currentRunId: string, allRuns: AutomationRun[]): AutomationRun[] {
  return allRuns.filter((r) => r.restartedFromRunId === currentRunId)
}

function describeRunTrigger(run: AutomationRun, automation: Automation, repos: Repo[]): string {
  if (run.trigger === 'manual') {
    return 'Manual'
  }
  if (run.trigger === 'scheduled') {
    return 'Scheduled'
  }
  if (run.trigger === 'auto') {
    const sourceLabel =
      run.triggerSource === 'linear-issue' ? 'Linear issue' : (run.triggerSource ?? 'auto')
    if (run.triggerAutoTriggerId && run.triggerRuleId) {
      const at = automation.autoTriggers?.find((t) => t.id === run.triggerAutoTriggerId)
      const idx = at?.rules.findIndex((r) => r.id === run.triggerRuleId) ?? -1
      if (idx >= 0 && at) {
        const rule = at.rules[idx]
        const projectName = repos.find((repo) => repo.id === rule.projectId)?.displayName ?? ''
        return `Auto: ${sourceLabel} • Rule ${idx + 1}${projectName ? ` (${projectName})` : ''}`
      }
      return `Auto: ${sourceLabel} • Rule deleted`
    }
    return `Auto: ${sourceLabel}`
  }
  return 'Manual'
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
  waiting: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
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

/** Count the total flat steps, expanding parallel groups. */
function countSteps(steps: StepOrGroup[]): number {
  let count = 0
  for (const item of steps) {
    count += Array.isArray(item) ? item.length : 1
  }
  return count
}

/** Group consecutive step-run states that belong to the same parallel group so
 *  we can render them side-by-side in the run history view. */
function groupRunStates(
  stepStates: StepRunState[],
  automationSteps: StepOrGroup[]
): (StepRunState | StepRunState[])[] {
  // Map each step id to its top-level index when that index is a parallel group
  const groupMembership = new Map<string, number>()
  automationSteps.forEach((item, topIdx) => {
    if (Array.isArray(item)) {
      for (const s of item) {
        groupMembership.set(s.id, topIdx)
      }
    }
  })

  const result: (StepRunState | StepRunState[])[] = []
  let i = 0
  while (i < stepStates.length) {
    const state = stepStates[i]
    const groupIdx = groupMembership.get(state.stepId)
    if (groupIdx !== undefined) {
      // Collect all consecutive states belonging to this parallel group
      const group: StepRunState[] = [state]
      let j = i + 1
      while (j < stepStates.length && groupMembership.get(stepStates[j].stepId) === groupIdx) {
        group.push(stepStates[j])
        j++
      }
      result.push(group)
      i = j
    } else {
      result.push(state)
      i++
    }
  }
  return result
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

// Why: priority is a 0..4 enum in Linear; surface the human label instead of
// the raw int so the rule preview reads naturally.
const PRIORITY_LABELS: Record<number, string> = {
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low'
}

const FIELD_LABELS: Record<string, string> = {
  'linear.assignee': 'assignee',
  'linear.tag': 'tag',
  'linear.state': 'state',
  'linear.priority': 'priority'
}

const OP_WORDS: Record<ConditionOp, string> = {
  is: 'is',
  'is-not': 'is not',
  'is-any-of': 'is any of',
  'is-none-of': 'is none of',
  'contains-any': 'has any of',
  'contains-all': 'has all of',
  'contains-none': 'has none of',
  gte: '≥',
  lte: '≤',
  eq: 'is'
}

function sourceLabel(s: TriggerSourceId): string {
  if (s === 'linear-issue') {
    return 'Linear issue'
  }
  return s
}

function formatValue(c: Condition): React.ReactNode {
  if (c.field === 'linear.priority') {
    if (typeof c.value === 'number') {
      return <span className="font-mono text-[11px]">{PRIORITY_LABELS[c.value] ?? c.value}</span>
    }
    if (Array.isArray(c.value)) {
      return c.value
        .map((v) => PRIORITY_LABELS[Number(v)] ?? String(v))
        .map((label, i, arr) => (
          <React.Fragment key={i}>
            <span className="font-mono text-[11px]">{label}</span>
            {i < arr.length - 1 ? ', ' : null}
          </React.Fragment>
        ))
    }
  }
  if (Array.isArray(c.value)) {
    return c.value.map((v, i, arr) => (
      <React.Fragment key={i}>
        <span className="font-mono text-[11px]">{String(v)}</span>
        {i < arr.length - 1 ? ', ' : null}
      </React.Fragment>
    ))
  }
  return <span className="font-mono text-[11px]">{String(c.value)}</span>
}

function formatCondition(c: Condition): React.ReactNode {
  const fieldLabel = FIELD_LABELS[c.field] ?? c.field
  const opWord = OP_WORDS[c.op] ?? c.op
  return (
    <>
      {fieldLabel} {opWord} {formatValue(c)}
    </>
  )
}

function describeRule(rule: Rule, repos: Repo[]): React.ReactNode {
  const repo = repos.find((r) => r.id === rule.projectId)
  // Why: rule.projectId is intentionally optional when the chain itself
  // supplies project context (e.g. a create-workspace-group step). Don't
  // alarm the operator with "project deleted" for a rule they purposely
  // left blank.
  const projectLabel = repo ? (
    <span className="font-medium text-foreground">{repo.displayName}</span>
  ) : rule.projectId ? (
    <span className="text-destructive">project deleted</span>
  ) : (
    <span className="text-muted-foreground">inferred from chain</span>
  )
  if (rule.conditions.length === 0) {
    return <>Matches every event → {projectLabel}</>
  }
  return (
    <>
      When{' '}
      {rule.conditions.map((c, i) => (
        <React.Fragment key={i}>
          {i > 0 ? ' and ' : null}
          {formatCondition(c)}
        </React.Fragment>
      ))}
      {' → '}
      {projectLabel}
    </>
  )
}

function AutoTriggersSummary({
  autoTriggers,
  repos
}: {
  autoTriggers: AutoTrigger[]
  repos: Repo[]
}): React.JSX.Element {
  return (
    <div className="space-y-3 rounded-md border border-border/50 bg-muted/20 px-4 py-3 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-medium uppercase text-muted-foreground">
          Automatic triggers
        </div>
        <span className="text-xs text-muted-foreground">{autoTriggers.length} configured</span>
      </div>
      <ul className="space-y-2">
        {autoTriggers.map((trig) => (
          <li
            key={trig.id}
            className="rounded-md border border-border/40 bg-card px-3 py-2 text-sm"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Zap className="size-4 text-muted-foreground" />
                <span className="font-medium">{sourceLabel(trig.source)}</span>
                <span className="text-xs text-muted-foreground">
                  {trig.rules.length} {trig.rules.length === 1 ? 'rule' : 'rules'}
                </span>
              </div>
              <Badge variant={trig.enabled ? 'outline' : 'secondary'}>
                {trig.enabled ? 'Active' : 'Disabled'}
              </Badge>
            </div>
            {trig.rules.length === 0 ? (
              <div className="mt-1 text-xs text-muted-foreground">No rules — never fires.</div>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {trig.rules.map((rule, idx) => (
                  <li key={rule.id} className="text-xs text-muted-foreground">
                    <span className="text-foreground/80">Rule {idx + 1}:</span>{' '}
                    {describeRule(rule, repos)}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

const STEP_KIND_LABELS: Record<Step['kind'], string> = {
  'create-worktree': 'Create worktree',
  'create-workspace-group': 'Create workspace group',
  'wait-for-setup': 'Wait for setup',
  'run-prompt': 'Run prompt',
  'run-command': 'Run command',
  'update-linear-issue': 'Update Linear issue'
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
    case 'create-workspace-group': {
      const config = step.config as CreateWorkspaceGroupConfig
      const branch = config.branchName.trim() || '(auto)'
      const count = config.members.length
      return `${branch} across ${count} ${count === 1 ? 'repo' : 'repos'}`
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
      if (config.source === 'review') {
        return 'Review'
      }
      if (config.source === 'create-pr') {
        return 'Create PR'
      }
      const custom = (config as RunCommandConfig & { customCommand?: string }).customCommand
      return firstNonEmptyLine(custom ?? '') || 'Custom command'
    }
    case 'update-linear-issue': {
      const config = step.config as UpdateLinearIssueConfig
      const parts: string[] = []
      if (config.assigneeRef && config.assigneeRef.trim().length > 0) {
        parts.push('assignee')
      }
      if (config.stateRef && config.stateRef.trim().length > 0) {
        parts.push('state')
      }
      if (parts.length === 0) {
        return 'No updates configured'
      }
      return `Set ${parts.join(' + ')}`
    }
  }
}

/** Pull a short repo-folder label out of a step's `worktreeRef` when it
 *  resolves to a member-scoped sentinel — used to render the "scoped to <repo>"
 *  badge on chain step rows (Ask C, UI marker). Returns null for any other
 *  shape, including templated values that don't statically contain the
 *  sentinel (e.g. `{{group.members.<x>.scoped}}` — without runtime context
 *  we can't tell which repo it'll resolve to). */
function getMemberScopedRepoLabel(step: Step): string | null {
  // Only run-prompt steps carry the worktreeRef the runner inspects for the
  // member-scoped branch today; keeping the check tight avoids false
  // positives on other step kinds whose `worktreeRef` slot may grow later.
  if (step.kind !== 'run-prompt' && step.kind !== 'run-command' && step.kind !== 'wait-for-setup') {
    return null
  }
  const config = step.config as { worktreeRef?: string }
  const raw = config.worktreeRef?.trim() ?? ''
  if (!isMemberScopedRef(raw)) {
    return null
  }
  const parsed = parseMemberScopedRef(raw)
  if (!parsed) {
    return null
  }
  const split = splitWorktreeId(parsed.worktreeId)
  if (!split) {
    return null
  }
  // Repo folder name == basename of the member's worktree path. Avoid pulling
  // in Node's `path` module by slicing on the last `/` or `\`.
  const path = split.worktreePath
  const lastSep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return lastSep === -1 ? path : path.slice(lastSep + 1)
}

function ChainStepRow({ step, index }: { step: Step; index: number }): React.JSX.Element {
  const memberScopedRepo = getMemberScopedRepoLabel(step)
  return (
    <div className="flex items-start gap-3 px-3 py-2 text-sm">
      <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
        {index + 1}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-medium text-foreground">{STEP_KIND_LABELS[step.kind]}</span>
          <span className="truncate font-mono text-xs text-muted-foreground">{step.id}</span>
          {memberScopedRepo ? (
            // Why (Ask C UI marker): make member-scoped runs visually
            // distinct from group-scoped ones so the operator can tell at a
            // glance the agent will land at the member's CWD rather than the
            // group parent. Minimal chip — full detail lives in the picker.
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  className="px-1.5 py-0 text-[10px] uppercase tracking-wide"
                >
                  scoped to {memberScopedRepo}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                Agent runs at this member&apos;s working directory; the terminal tab still belongs
                to the group.
              </TooltipContent>
            </Tooltip>
          ) : null}
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
    onRetry !== undefined &&
    step.status !== 'running' &&
    step.status !== 'pending' &&
    step.status !== 'waiting'
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
  onRetryRunFromStep,
  onRestartRun,
  repos
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
          <div className="space-y-3">
            <div className="rounded-md border border-border/50 bg-muted/20 px-4 py-3 shadow-sm">
              <div className="text-[11px] font-medium uppercase text-muted-foreground">
                Manual trigger
              </div>
              <div className="mt-1 text-sm font-medium">{describeTrigger(automation.trigger!)}</div>
            </div>
            {automation.autoTriggers && automation.autoTriggers.length > 0 ? (
              <AutoTriggersSummary autoTriggers={automation.autoTriggers} repos={repos ?? []} />
            ) : null}
          </div>
          <div className="rounded-md border border-border/50 bg-muted/20 shadow-sm">
            <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
              <div className="text-sm font-medium">Steps</div>
              <div className="text-xs text-muted-foreground">
                {countSteps(automation.steps!)}{' '}
                {countSteps(automation.steps!) === 1 ? 'step' : 'steps'}
              </div>
            </div>
            <div className="divide-y divide-border/50">
              {automation.steps!.map((item, topIndex) => {
                if (Array.isArray(item)) {
                  return (
                    <div key={item.map((s) => s.id).join('+')} className="px-3 py-2">
                      <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">
                        Parallel
                      </div>
                      <div className="flex gap-2">
                        {item.map((step) => (
                          <div
                            key={step.id}
                            className="min-w-0 flex-1 rounded-md border border-border/40 bg-background px-2 py-1.5"
                          >
                            <div className="flex flex-wrap items-baseline gap-2">
                              <span className="text-sm font-medium text-foreground">
                                {STEP_KIND_LABELS[step.kind]}
                              </span>
                              <span className="truncate font-mono text-xs text-muted-foreground">
                                {step.id}
                              </span>
                            </div>
                            <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">
                              {describeStepConfig(step)}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                }
                return <ChainStepRow key={item.id} step={item} index={topIndex} />
              })}
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
                <div className="text-[11px] font-medium uppercase text-muted-foreground">
                  Prompt
                </div>
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
        <div className="grid grid-cols-[minmax(10rem,1fr)_minmax(6rem,auto)_auto] gap-3 border-b border-border/50 px-3 py-1.5 text-[11px] font-medium uppercase text-muted-foreground">
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
              run.status === 'waiting' ||
              run.status === 'pending' ||
              run.status === 'dispatching'
            const triggerBadge = describeRunTrigger(run, automation, repos ?? [])
            const restartChildren = findRestartChildren(run.id, runs)
            const showRestart = isRestartable(run.status) && onRestartRun !== undefined
            const rowClassName =
              'grid grid-cols-[minmax(10rem,1fr)_minmax(6rem,auto)_auto] items-center gap-3 px-3 py-2 text-left text-sm outline-none transition-colors'
            const rowContent = (
              <>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span>{formatAutomationDateTime(run.scheduledFor)}</span>
                    {linearIssue ? <LinearIssuePill issue={linearIssue} /> : null}
                    <span className="text-xs text-muted-foreground">{triggerBadge}</span>
                  </div>
                  {run.restartedFromRunId ? (
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      Restarted from #{shortId(run.restartedFromRunId)}
                    </div>
                  ) : null}
                  {restartChildren.length > 0 ? (
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      Restarted as {restartChildren.map((c) => `#${shortId(c.id)}`).join(', ')}
                    </div>
                  ) : null}
                  {run.error ? (
                    <div className="mt-1 truncate text-xs text-muted-foreground">{run.error}</div>
                  ) : null}
                </div>
                <div className="flex justify-start">
                  <Badge variant={getAutomationRunStatusVariant(run.status)}>
                    {getAutomationRunStatusLabel(run.status)}
                  </Badge>
                </div>
                <div className="flex items-center justify-end gap-1">
                  {showRestart ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Restart run"
                          onClick={(e) => {
                            e.stopPropagation()
                            onRestartRun?.(run)
                          }}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <RotateCcw className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="left" sideOffset={6}>
                        Restart run
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
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
            // single-row rendering untouched. Parallel groups are rendered
            // side-by-side so the operator can see concurrent progress at a glance.
            const groupedStates = hasStepStates
              ? groupRunStates(run.stepStates!, automation.steps ?? [])
              : []
            const stepList = hasStepStates ? (
              <div className="flex flex-col gap-0 border-t border-border/50 bg-background/60 py-1">
                {groupedStates.map((item) => {
                  if (Array.isArray(item)) {
                    return (
                      <div key={item.map((s) => s.stepId).join('+')} className="px-3 py-2">
                        <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">
                          Parallel
                        </div>
                        <div className="flex gap-2">
                          {item.map((state) => {
                            const flatIdx = run.stepStates!.indexOf(state)
                            return (
                              <div key={state.stepId} className="min-w-0 flex-1">
                                <StepRunRow
                                  step={state}
                                  onRetry={() => onRetryRunFromStep(run, flatIdx)}
                                />
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  }
                  const flatIdx = run.stepStates!.indexOf(item)
                  return (
                    <StepRunRow
                      key={item.stepId}
                      step={item}
                      onRetry={() => onRetryRunFromStep(run, flatIdx)}
                    />
                  )
                })}
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
