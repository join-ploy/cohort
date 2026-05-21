import * as React from 'react'
import type { TriggerConfig } from '../../../../../shared/automations-types'

export type TriggerPillProps = {
  trigger: TriggerConfig
  onTriggerChange: (trigger: TriggerConfig) => void
}

// Why: shadcn Popover renders via Radix Portal which doesn't show up in
// renderToStaticMarkup-based tests. We render the popover content as a
// conditional inline <div> so the trigger pill is testable end-to-end without
// an extra jsdom harness — same pattern as AddStepControl in the modal.
export function triggerLabel(trigger: TriggerConfig): string {
  const l = trigger.acceptsLinearTicket === true
  const p = trigger.acceptsProjectSelection === true
  if (l && p) {
    return 'Manual (2 prompts)'
  }
  if (l) {
    return 'Manual + Linear'
  }
  if (p) {
    return 'Manual + Project'
  }
  return 'Manual'
}

export function TriggerPill(props: TriggerPillProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const label = triggerLabel(props.trigger)
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
