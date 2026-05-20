import * as React from 'react'
import { Braces } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  dryRunTemplate,
  type AvailableVariables,
  type TemplateError
} from '../../../lib/template-dry-run'

export type TemplateInputProps = {
  value: string
  onChange: (value: string) => void
  available: AvailableVariables
  placeholder?: string
  multiline?: boolean
  className?: string
  // Optional label for screen readers / form association.
  ariaLabel?: string
  // Optional callback for picker integration (P5.5 will use it):
  // fired when the user types '{{' with the caret position info.
  onPickerOpen?: (anchorEl: HTMLElement | null, caretIndex: number) => void
}

// Live dry-run-validated template input. Renders an <input> by default,
// or <textarea> when `multiline` is set. The `{ }` corner icon switches
// to rose when dryRunTemplate reports any errors so the field draws the
// eye without having to open a popover. The popover itself lands in P5.5.
export function TemplateInput(props: TemplateInputProps): React.JSX.Element {
  const inputRef = React.useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const errors = React.useMemo<TemplateError[]>(
    () => dryRunTemplate(props.value, props.available),
    [props.value, props.available]
  )
  const hasError = errors.length > 0
  const firstErrorMessage = hasError ? errors[0].message : undefined

  const { onChange, onPickerOpen } = props
  const handleChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement> | React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value
      const caret = e.target.selectionStart ?? next.length
      // The two chars immediately to the left of the caret form '{{' when
      // the user has just typed the opening token — that's the picker cue.
      if (onPickerOpen && caret >= 2 && next.slice(caret - 2, caret) === '{{') {
        onPickerOpen(inputRef.current as HTMLElement | null, caret)
      }
      onChange(next)
    },
    [onChange, onPickerOpen]
  )

  const baseClasses =
    'font-mono text-xs rounded-md border bg-background px-2 py-1.5 pr-7 w-full outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50'
  const errorClasses = hasError ? 'ring-1 ring-rose-500/60 border-rose-500/60' : 'border-input'

  return (
    <div className={cn('relative w-full', props.className)}>
      {props.multiline ? (
        <textarea
          ref={inputRef as React.RefObject<HTMLTextAreaElement>}
          value={props.value}
          onChange={handleChange}
          placeholder={props.placeholder}
          aria-label={props.ariaLabel}
          aria-invalid={hasError || undefined}
          title={firstErrorMessage}
          rows={3}
          className={cn(baseClasses, errorClasses)}
        />
      ) : (
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          type="text"
          value={props.value}
          onChange={handleChange}
          placeholder={props.placeholder}
          aria-label={props.ariaLabel}
          aria-invalid={hasError || undefined}
          title={firstErrorMessage}
          className={cn(baseClasses, errorClasses)}
        />
      )}
      <Braces
        aria-hidden
        className={cn(
          'pointer-events-none absolute right-1.5 top-1.5 size-3.5',
          hasError ? 'text-rose-500' : 'text-muted-foreground/40'
        )}
      />
    </div>
  )
}
