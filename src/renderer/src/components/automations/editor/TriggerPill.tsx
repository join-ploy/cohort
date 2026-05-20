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
  const w = trigger.acceptsWorktreeSelection === true
  if (l && w) {
    return 'Manual (2 prompts)'
  }
  if (l) {
    return 'Manual + Linear'
  }
  if (w) {
    return 'Manual + Worktree'
  }
  return 'Manual'
}

export function TriggerPill(props: TriggerPillProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const label = triggerLabel(props.trigger)
  const linearOn = props.trigger.acceptsLinearTicket === true
  const worktreeOn = props.trigger.acceptsWorktreeSelection === true

  const toggleLinear = (): void => {
    props.onTriggerChange({
      ...props.trigger,
      acceptsLinearTicket: !linearOn
    })
  }
  const toggleWorktree = (): void => {
    props.onTriggerChange({
      ...props.trigger,
      acceptsWorktreeSelection: !worktreeOn
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
              aria-label="Accept worktree selection on Run"
              checked={worktreeOn}
              onChange={toggleWorktree}
            />
            Accept worktree selection on Run
          </label>
        </div>
      ) : null}
    </div>
  )
}
