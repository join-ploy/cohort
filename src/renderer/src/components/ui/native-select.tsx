import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

// Kept as a native <select> (not a Radix Select) for the short, fixed option
// lists the trigger editors use; shared so the schedule + http cards read alike.
const SELECT_CLASS = cn(
  'appearance-none rounded-md border border-input bg-background px-2 py-1 pr-7 text-xs transition-colors hover:bg-accent',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50'
)

export type NativeSelectProps = {
  ariaLabel: string
  value: string
  onChange: (next: string) => void
  className?: string
  children: React.ReactNode
}

export function NativeSelect(props: NativeSelectProps): React.JSX.Element {
  return (
    <div className="relative inline-flex" data-slot="native-select">
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
