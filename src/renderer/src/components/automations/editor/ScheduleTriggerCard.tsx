import * as React from 'react'
import { CalendarClock, ChevronDown, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import type { AutoTrigger, ScheduleConfig } from '../../../../../shared/automations-types'
import {
  cronFromRecurrence,
  isValidCron,
  nextOccurrences,
  recurrenceFromCron,
  type Recurrence
} from '../../../../../shared/schedule-cron'

export type ScheduleTriggerCardProps = {
  trigger: AutoTrigger
  onChange: (next: AutoTrigger) => void
  onRemove: () => void
}

// Mon-first display order over cron day indices (0=Sun…6=Sat); the builder still
// stores the cron-native indices so schedule-cron stays the only place that
// knows the mapping.
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const MINUTES = Array.from({ length: 60 }, (_, i) => i)
// Cap at 28 so a chosen day exists in every month (no silently-skipped months).
const DAYS_OF_MONTH = Array.from({ length: 28 }, (_, i) => i + 1)

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

// Friendliest default for each freq when the user switches Repeat — 09:00 on
// weekdays mirrors the seeded daily default.
function defaultRecurrence(freq: Recurrence['freq']): Recurrence {
  switch (freq) {
    case 'hourly':
      return { freq: 'hourly', minute: 0 }
    case 'daily':
      return { freq: 'daily', hour: 9, minute: 0 }
    case 'weekly':
      return { freq: 'weekly', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 }
    case 'monthly':
      return { freq: 'monthly', dayOfMonth: 1, hour: 9, minute: 0 }
  }
}

// The long IANA list as a native <select> source; fall back to just the current
// zone if the runtime lacks supportedValuesOf, and keep the current zone present
// even if it's not in the catalog so it stays selectable.
function timezoneOptions(current: string): string[] {
  const all =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [current]
  return all.includes(current) ? all : [current, ...all]
}

const SELECT_CLASS = cn(
  'appearance-none rounded-md border border-input bg-background px-2 py-1 pr-7 text-xs transition-colors hover:bg-accent',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50'
)

type SelectShellProps = {
  ariaLabel: string
  value: string
  onChange: (next: string) => void
  className?: string
  children: React.ReactNode
}

// Native <select> styled to the tokens — mirrors HttpEndpointTriggerCard's
// SelectShell so the two sibling trigger editors read as one design.
function SelectShell(props: SelectShellProps): React.JSX.Element {
  return (
    <div className="relative inline-flex">
      <select
        aria-label={props.ariaLabel}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className={cn(SELECT_CLASS, props.className)}
      >
        {props.children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
    </div>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  // Block label so the control below sits on its own line (label-above pattern).
  return <p className="text-[11px] font-medium text-muted-foreground">{children}</p>
}

const FREQ_LABELS: { value: Recurrence['freq']; label: string }[] = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' }
]

export function ScheduleTriggerCard(props: ScheduleTriggerCardProps): React.JSX.Element {
  const { trigger, onChange, onRemove } = props
  const schedule = trigger.schedule
  const cronValue = schedule?.cron

  // Raw-cron draft is local so an invalid expression can be shown without
  // persisting it; resync whenever a valid cron lands from the builder.
  const [cronDraft, setCronDraft] = React.useState(cronValue ?? '')
  const [advancedOpen, setAdvancedOpen] = React.useState(false)
  React.useEffect(() => {
    if (cronValue !== undefined) {
      setCronDraft(cronValue)
    }
  }, [cronValue])

  if (!schedule) {
    // Schedule triggers always carry a config; guard so a malformed trigger
    // degrades instead of crashing.
    return (
      <div className="rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground">
        This trigger is missing its schedule configuration.
      </div>
    )
  }

  const recurrence = recurrenceFromCron(schedule.cron)
  // A cron the builder can't model → Custom: force Advanced open and hide the
  // friendly controls so the raw expression is the only editor.
  const isCustom = recurrence === null
  const cronValid = isValidCron(cronDraft)
  const nextRuns = cronValid ? nextOccurrences(schedule.cron, schedule.timezone, Date.now(), 3) : []
  const previewFmt = new Intl.DateTimeFormat(undefined, {
    timeZone: schedule.timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  })

  const writeSchedule = (next: ScheduleConfig): void => {
    onChange({ ...trigger, schedule: next })
  }
  const emit = (r: Recurrence): void => {
    writeSchedule({ cron: cronFromRecurrence(r), timezone: schedule.timezone })
  }

  const onFreqChange = (freq: string): void => {
    emit(defaultRecurrence(freq as Recurrence['freq']))
  }
  const setMinute = (minute: number): void => {
    if (recurrence) {
      emit({ ...recurrence, minute })
    }
  }
  const setHour = (hour: number): void => {
    if (recurrence && recurrence.freq !== 'hourly') {
      emit({ ...recurrence, hour })
    }
  }
  const setDays = (days: number[]): void => {
    // Never allow an empty set — an empty weekday list would never fire.
    if (recurrence?.freq === 'weekly' && days.length > 0) {
      emit({ ...recurrence, days: days.slice().sort((a, b) => a - b) })
    }
  }
  const setDayOfMonth = (dayOfMonth: number): void => {
    if (recurrence?.freq === 'monthly') {
      emit({ ...recurrence, dayOfMonth })
    }
  }
  const onTimezoneChange = (timezone: string): void => {
    writeSchedule({ cron: schedule.cron, timezone })
  }
  const onCronInput = (value: string): void => {
    setCronDraft(value)
    // Only persist valid expressions; an invalid draft stays local + flagged.
    if (isValidCron(value)) {
      writeSchedule({ cron: value, timezone: schedule.timezone })
    }
  }

  return (
    <div
      aria-label={`auto trigger ${trigger.id}`}
      className="rounded-lg border border-border bg-card text-sm shadow-xs"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <CalendarClock className="size-4 text-muted-foreground" />
          <span className="font-medium">Schedule</span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove trigger ${trigger.id}`}
          title="Remove trigger"
          onClick={onRemove}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      <div className="space-y-4 px-4 py-3">
        {recurrence ? (
          <>
            <div className="space-y-1.5">
              <FieldLabel>Repeat</FieldLabel>
              <SelectShell ariaLabel="Repeat" value={recurrence.freq} onChange={onFreqChange}>
                {FREQ_LABELS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </SelectShell>
            </div>

            {recurrence.freq === 'weekly' ? (
              <div className="space-y-1.5">
                <FieldLabel>On days</FieldLabel>
                <ToggleGroup
                  type="multiple"
                  variant="outline"
                  size="sm"
                  spacing={4}
                  value={recurrence.days.map(String)}
                  onValueChange={(vals) => setDays(vals.map(Number))}
                >
                  {WEEKDAY_ORDER.map((d) => (
                    <ToggleGroupItem key={d} value={String(d)} aria-label={WEEKDAY_FULL[d]}>
                      {WEEKDAY_SHORT[d]}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
            ) : null}

            {recurrence.freq === 'monthly' ? (
              <div className="space-y-1.5">
                <FieldLabel>Day of month</FieldLabel>
                <SelectShell
                  ariaLabel="Day of month"
                  value={String(recurrence.dayOfMonth)}
                  onChange={(v) => setDayOfMonth(Number(v))}
                >
                  {DAYS_OF_MONTH.map((d) => (
                    <option key={d} value={String(d)}>
                      {d}
                    </option>
                  ))}
                </SelectShell>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <FieldLabel>{recurrence.freq === 'hourly' ? 'Minute' : 'Time'}</FieldLabel>
              <div className="flex items-center gap-2">
                {recurrence.freq !== 'hourly' ? (
                  <SelectShell
                    ariaLabel="Hour"
                    value={String(recurrence.hour)}
                    onChange={(v) => setHour(Number(v))}
                  >
                    {HOURS.map((h) => (
                      <option key={h} value={String(h)}>
                        {pad2(h)}
                      </option>
                    ))}
                  </SelectShell>
                ) : null}
                {recurrence.freq !== 'hourly' ? (
                  <span className="text-xs text-muted-foreground">:</span>
                ) : null}
                <SelectShell
                  ariaLabel="Minute"
                  value={String(recurrence.minute)}
                  onChange={(v) => setMinute(Number(v))}
                >
                  {MINUTES.map((m) => (
                    <option key={m} value={String(m)}>
                      {pad2(m)}
                    </option>
                  ))}
                </SelectShell>
              </div>
            </div>
          </>
        ) : null}

        <div className="space-y-1.5">
          <FieldLabel>Timezone</FieldLabel>
          <SelectShell
            ariaLabel="Timezone"
            value={schedule.timezone}
            onChange={onTimezoneChange}
            className="max-w-full"
          >
            {timezoneOptions(schedule.timezone).map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </SelectShell>
        </div>

        <Collapsible open={advancedOpen || isCustom} onOpenChange={setAdvancedOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronDown
                className={cn(
                  'size-3 transition-transform',
                  (advancedOpen || isCustom) && 'rotate-180'
                )}
              />
              Advanced
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-1.5 pt-2">
            <FieldLabel>Cron expression</FieldLabel>
            <Input
              aria-label="Cron expression"
              value={cronDraft}
              aria-invalid={!cronValid}
              onChange={(e) => onCronInput(e.target.value)}
              className="h-8 font-mono text-xs"
            />
            {!cronValid ? (
              <p className="text-[11px] text-destructive">Enter a valid 5-field cron expression.</p>
            ) : null}
          </CollapsibleContent>
        </Collapsible>

        {nextRuns.length > 0 ? (
          <div className="space-y-1.5">
            <FieldLabel>Next runs</FieldLabel>
            <ul className="space-y-1">
              {nextRuns.map((ms) => (
                <li key={ms} className="font-mono text-xs text-muted-foreground">
                  {previewFmt.format(new Date(ms))}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  )
}
