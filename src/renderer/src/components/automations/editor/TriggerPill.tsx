import * as React from 'react'
import type {
  TriggerConfig,
  AutoTrigger,
  TriggerSourceId
} from '../../../../../shared/automations-types'

export type TriggerPillProps = {
  trigger: TriggerConfig
  onTriggerChange: (trigger: TriggerConfig) => void
  autoTriggers?: AutoTrigger[]
}

// Why: per-source short label keeps adding future sources to a single line.
const SOURCE_LABEL: Record<TriggerSourceId, string> = {
  'linear-issue': 'Linear auto'
}

function sourceLabelFor(source: TriggerSourceId): string {
  return SOURCE_LABEL[source] ?? 'auto'
}

// Why: shadcn Popover renders via Radix Portal which doesn't show up in
// renderToStaticMarkup-based tests. We render the popover content as a
// conditional inline <div> so the trigger pill is testable end-to-end without
// an extra jsdom harness — same pattern as AddStepControl in the modal.
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

export function TriggerPill(props: TriggerPillProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const label = triggerLabel(props.trigger, props.autoTriggers)
  const linearOn = props.trigger.acceptsLinearTicket === true
  const projectOn = props.trigger.acceptsProjectSelection === true

  const toggleLinear = (): void => {
    props.onTriggerChange({
      ...props.trigger,
      acceptsLinearTicket: !linearOn
    })
  }
  const toggleProject = (): void => {
    props.onTriggerChange({
      ...props.trigger,
      acceptsProjectSelection: !projectOn
    })
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        Trigger: {label}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Trigger options"
          className="absolute right-0 top-full z-20 mt-1 flex w-64 flex-col gap-2 rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground shadow-md"
        >
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              aria-label="Accept Linear ticket on Run"
              checked={linearOn}
              onChange={toggleLinear}
            />
            Accept Linear ticket on Run
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              aria-label="Pick project on Run"
              checked={projectOn}
              onChange={toggleProject}
            />
            Pick project on Run
          </label>
        </div>
      ) : null}
    </div>
  )
}
