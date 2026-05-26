import * as React from 'react'
import { Braces, ListIcon } from 'lucide-react'
import type {
  Step,
  StepConfig,
  UpdateLinearIssueConfig
} from '../../../../../shared/automations-types'
import type { LinearTeam } from '../../../../../shared/types'
import type { AvailableVariables } from '../../../lib/template-dry-run'
import { useTeamMembers, useTeamStates } from '@/hooks/useIssueMetadata'
import { cn } from '@/lib/utils'
import { TemplateInput } from './TemplateInput'
import { StepCardChrome } from './StepCardChrome'

export type UpdateLinearIssueStepCardProps = {
  step: Step
  stepIndex: number
  available: AvailableVariables
  disableDrag?: boolean
  onIdChange: (newId: string) => void
  onConfigChange: (config: UpdateLinearIssueConfig) => void
  onOnFailureChange: (val: 'halt' | 'continue') => void
  onTimeoutChange: (val: number | null) => void
  onDelete: () => void
}

/**
 * Body for an `update-linear-issue` step.
 *
 * Layout:
 *  - Linear issue ID — TemplateInput (always; usually `{{trigger.linear.issue.id}}`).
 *  - Linear team — native <select> sourced from `window.api.linear.listTeams()`;
 *    scopes the assignee/state pickers below.
 *  - Assignee / State — dual-mode inputs. Default to a picker (Select over
 *    members / states) when a team is chosen; the user can flip to template
 *    mode via the `{ }` toggle to write a `{{trigger.linear.issue.assigneeId}}`-
 *    style expression instead.
 *
 * Auto-detection of mode on first render: a saved value containing `{{` or
 * `}}` is rendered in template mode. Otherwise picker mode is used; literals
 * that don't match a known option render with an "Unknown" sentinel that the
 * user can swap to template mode to fix.
 */
export function UpdateLinearIssueStepCard(
  props: UpdateLinearIssueStepCardProps
): React.JSX.Element {
  const config = props.step.config as UpdateLinearIssueConfig
  const update = (patch: Partial<UpdateLinearIssueConfig>): void => {
    props.onConfigChange({ ...config, ...patch })
  }

  const teams = useLinearTeams()
  const teamId = (config.teamId ?? '').trim() || null

  const members = useTeamMembers(teamId)
  const states = useTeamStates(teamId)

  return (
    <StepCardChrome
      step={props.step}
      stepIndex={props.stepIndex}
      available={props.available}
      disableDrag={props.disableDrag}
      onIdChange={props.onIdChange}
      onConfigChange={props.onConfigChange as (config: StepConfig) => void}
      onOnFailureChange={props.onOnFailureChange}
      onTimeoutChange={props.onTimeoutChange}
      onDelete={props.onDelete}
    >
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Linear issue ID</span>
        <TemplateInput
          value={config.issueRef}
          onChange={(v) => update({ issueRef: v })}
          placeholder="{{trigger.linear.issue.id}}"
          available={props.available}
          ariaLabel="Issue ref"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Linear team</span>
        <select
          aria-label="Linear team"
          value={config.teamId ?? ''}
          onChange={(e) => update({ teamId: e.target.value })}
          className="rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50"
        >
          <option value="">— Pick a team —</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.key})
            </option>
          ))}
        </select>
      </label>

      <DualModeField
        label="Assignee (optional)"
        emptyLabel="(no change)"
        templateAriaLabel="Assignee ref"
        pickerAriaLabel="Assignee"
        toggleAriaLabel="Assignee template mode"
        templatePlaceholder="{{trigger.linear.issue.assigneeId}}"
        value={config.assigneeRef ?? ''}
        onChange={(v) => update({ assigneeRef: v })}
        teamId={teamId}
        options={members.data.map((m) => ({ value: m.id, label: m.displayName }))}
        loading={members.loading}
        error={members.error}
        available={props.available}
      />

      <DualModeField
        label="State (optional)"
        emptyLabel="(no change)"
        templateAriaLabel="State ref"
        pickerAriaLabel="State"
        toggleAriaLabel="State template mode"
        templatePlaceholder="{{steps.<id>.stateId}}"
        value={config.stateRef ?? ''}
        onChange={(v) => update({ stateRef: v })}
        teamId={teamId}
        options={states.data.map((s) => ({ value: s.id, label: s.name }))}
        loading={states.loading}
        error={states.error}
        available={props.available}
      />

      <p className="text-[11px] text-muted-foreground">
        At least one of assignee or state is required.
      </p>
    </StepCardChrome>
  )
}

// ─── Team list (modal-scoped cache) ──────────────────────────

// Why: every UpdateLinearIssue step card needs the same teams list. We cache
// the in-flight promise (and its result) module-locally so a chain with N of
// these cards triggers only one IPC round-trip per app session.
let cachedTeams: LinearTeam[] | null = null
let inflightTeams: Promise<LinearTeam[]> | null = null

function useLinearTeams(): LinearTeam[] {
  const [teams, setTeams] = React.useState<LinearTeam[]>(() => cachedTeams ?? [])
  React.useEffect(() => {
    if (cachedTeams) {
      return
    }
    let cancelled = false
    if (!inflightTeams) {
      inflightTeams = window.api.linear
        .listTeams()
        .then((raw) => {
          const list = raw as LinearTeam[]
          cachedTeams = list
          return list
        })
        .catch((err) => {
          // Drop the in-flight handle so the next mount can retry; surface
          // an empty list to the renderer rather than crashing the card.
          inflightTeams = null
          console.warn('[UpdateLinearIssueStepCard] listTeams failed', err)
          return [] as LinearTeam[]
        })
    }
    inflightTeams.then((list) => {
      if (!cancelled) {
        setTeams(list)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])
  return teams
}

// ─── Dual-mode field (picker ⇄ template) ─────────────────────

type DualModeOption = { value: string; label: string }

type DualModeFieldProps = {
  label: string
  emptyLabel: string
  templateAriaLabel: string
  pickerAriaLabel: string
  toggleAriaLabel: string
  templatePlaceholder: string
  value: string
  onChange: (v: string) => void
  teamId: string | null
  options: DualModeOption[]
  loading: boolean
  error: string | null
  available: AvailableVariables
}

/**
 * Detects template mode by checking for template tokens in the saved value.
 * `{{` is the picker cue in TemplateInput, so any value containing it is
 * intended as a template; we also accept `}}` to catch partial drafts.
 */
function looksLikeTemplate(value: string): boolean {
  return value.includes('{{') || value.includes('}}')
}

function DualModeField(props: DualModeFieldProps): React.JSX.Element {
  // Mode is sticky once the user toggles it. The initial value is derived
  // from the saved string: template-looking strings start in template mode,
  // everything else starts in picker mode (including literal-but-unknown
  // ids, which surface an "Unknown" sentinel so the user can fix them).
  const initialMode = looksLikeTemplate(props.value) ? 'template' : 'picker'
  const [mode, setMode] = React.useState<'picker' | 'template'>(initialMode)

  // Force template mode when no team is selected — the picker has nothing
  // to scope against and would be empty. The user can still flip back once
  // they pick a team.
  const effectiveMode: 'picker' | 'template' = props.teamId ? mode : 'template'

  const toggle = (): void => {
    setMode((prev) => (prev === 'picker' ? 'template' : 'picker'))
  }

  const knownValue = props.options.some((o) => o.value === props.value)
  const showStaleSentinel =
    effectiveMode === 'picker' && props.value !== '' && !knownValue && !props.loading

  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{props.label}</span>
      <div className="flex items-center gap-1.5">
        <div className="flex-1">
          {effectiveMode === 'picker' ? (
            <select
              aria-label={props.pickerAriaLabel}
              value={props.value}
              onChange={(e) => props.onChange(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50"
            >
              <option value="">{props.emptyLabel}</option>
              {showStaleSentinel ? (
                <option value={props.value}>Unknown ({props.value})</option>
              ) : null}
              {props.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <TemplateInput
              value={props.value}
              onChange={props.onChange}
              placeholder={props.templatePlaceholder}
              available={props.available}
              ariaLabel={props.templateAriaLabel}
            />
          )}
        </div>
        <button
          type="button"
          aria-label={props.toggleAriaLabel}
          aria-pressed={effectiveMode === 'template'}
          onClick={toggle}
          disabled={!props.teamId}
          title={
            props.teamId
              ? effectiveMode === 'template'
                ? 'Switch to picker'
                : 'Use template'
              : 'Pick a team to enable the picker'
          }
          className={cn(
            'inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-input text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50 disabled:opacity-50',
            effectiveMode === 'template' && 'bg-accent text-foreground'
          )}
        >
          {effectiveMode === 'template' ? (
            <ListIcon aria-hidden className="size-3.5" />
          ) : (
            <Braces aria-hidden className="size-3.5" />
          )}
        </button>
      </div>
      {props.loading ? <span className="text-[11px] text-muted-foreground">Loading…</span> : null}
      {props.error ? <span className="text-[11px] text-rose-500">{props.error}</span> : null}
    </label>
  )
}

// Exposed for tests / future call sites to reset the modal-scoped teams cache
// (e.g. after re-authenticating with Linear).
export function __resetUpdateLinearIssueTeamsCacheForTest(): void {
  cachedTeams = null
  inflightTeams = null
}
