import * as React from 'react'
import type {
  TriggerConfig,
  AutoTrigger,
  TriggerSourceId
} from '../../../../../shared/automations-types'

export type TriggerPillProps = {
  trigger: TriggerConfig
  autoTriggers?: AutoTrigger[]
  onOpenTriggers: () => void
}

// Why: per-source short label keeps adding future sources to a single line.
const SOURCE_LABEL: Record<TriggerSourceId, string> = {
  'linear-issue': 'Linear auto',
  'github-pr': 'GitHub PR auto',
  'http-endpoint': 'HTTP auto',
  schedule: 'Schedule auto'
}

function sourceLabelFor(source: TriggerSourceId): string {
  return SOURCE_LABEL[source] ?? 'auto'
}

export function triggerLabel(trigger: TriggerConfig, autoTriggers?: AutoTrigger[]): string {
  const l = trigger.acceptsLinearTicket === true
  const p = trigger.acceptsProjectSelection === true
  let label: string
  if (l && p) {
    label = 'Manual (2 prompts)'
  } else if (l) {
    label = 'Manual + Linear'
  } else if (p) {
    label = 'Manual + Project'
  } else {
    label = 'Manual'
  }

  // Why: only enabled auto-triggers count toward the summary so the pill
  // matches what the runner will actually fire.
  const enabled = (autoTriggers ?? []).filter((t) => t.enabled)
  if (enabled.length === 0) {
    return label
  }
  if (enabled.length === 1) {
    return `${label} + ${sourceLabelFor(enabled[0].source)}`
  }
  return `${label} + ${enabled.length} auto triggers`
}

// Why: Phase 11.2 — the pill is a pure button that opens the sibling
// TriggersModal. Previous inline-popover state lives in TriggersModal now.
export function TriggerPill(props: TriggerPillProps): React.JSX.Element {
  const label = triggerLabel(props.trigger, props.autoTriggers)
  return (
    <button
      type="button"
      aria-label="Trigger"
      onClick={props.onOpenTriggers}
      className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      Trigger: {label}
    </button>
  )
}
