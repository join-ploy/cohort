import * as React from 'react'
import { Braces } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  dryRunTemplate,
  type AvailableVariables,
  type TemplateError
} from '../../../lib/template-dry-run'
import { VariablePickerPopover } from './VariablePickerPopover'

export type TemplateInputProps = {
  value: string
  onChange: (value: string) => void
  available: AvailableVariables
  placeholder?: string
  multiline?: boolean
  className?: string
  // Optional label for screen readers / form association.
  ariaLabel?: string
}

// Live dry-run-validated template input. Renders an <input> by default,
// or <textarea> when `multiline` is set. The `{ }` corner icon switches
// to rose when dryRunTemplate reports any errors so the field draws the
// eye without having to open a popover. Mounts a VariablePickerPopover
// inline; typing '{{' opens it and selecting a row inserts the path and
// closing '}}' at the caret.
export function TemplateInput(props: TemplateInputProps): React.JSX.Element {
  const inputRef = React.useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const errors = React.useMemo<TemplateError[]>(
    () => dryRunTemplate(props.value, props.available),
    [props.value, props.available]
  )
  const hasError = errors.length > 0
  const firstErrorMessage = hasError ? errors[0].message : undefined

  const [pickerOpen, setPickerOpen] = React.useState(false)
  // Caret position immediately after the user typed '{{'. Insertion happens
  // here so we end up with '{{<path>}}' without disturbing the rest of value.
  const [caretAt, setCaretAt] = React.useState(0)

  const { onChange } = props
  const handleChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement> | React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value
      const caret = e.target.selectionStart ?? next.length
      // The two chars immediately to the left of the caret form '{{' when
      // the user has just typed the opening token — that's the picker cue.
      if (caret >= 2 && next.slice(caret - 2, caret) === '{{') {
        setCaretAt(caret)
        setPickerOpen(true)
      }
      onChange(next)
    },
    [onChange]
  )

  const handleSelect = React.useCallback(
    (path: string) => {
      // Value currently has '{{' at [caretAt-2, caretAt). We insert
      // `${path}}}` at caretAt so the result is '{{<path>}}' — leaves the
      // opening braces the user typed in place and closes the token.
      const current = props.value
      const insertion = `${path}}}`
      const next = current.slice(0, caretAt) + insertion + current.slice(caretAt)
      onChange(next)
    },
    [props.value, caretAt, onChange]
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
      <VariablePickerPopover
        open={pickerOpen}
        anchor={inputRef.current as HTMLElement | null}
        available={props.available}
        onSelect={handleSelect}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  )
}
