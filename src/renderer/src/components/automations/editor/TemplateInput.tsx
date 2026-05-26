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
  // Position of the `{{` opener in the value string. Everything between
  // openBraceAt+2 and the current caret is the live search query.
  const [openBraceAt, setOpenBraceAt] = React.useState(0)
  const [query, setQuery] = React.useState('')

  const { onChange } = props
  const handleChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement> | React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value
      const caret = e.target.selectionStart ?? next.length
      if (!pickerOpen && caret >= 2 && next.slice(caret - 2, caret) === '{{') {
        setOpenBraceAt(caret - 2)
        setQuery('')
        setPickerOpen(true)
      } else if (pickerOpen) {
        const afterBraces = caret - (openBraceAt + 2)
        if (afterBraces < 0 || next.slice(openBraceAt, openBraceAt + 2) !== '{{') {
          setPickerOpen(false)
        } else {
          setQuery(next.slice(openBraceAt + 2, caret))
        }
      }
      onChange(next)
    },
    [onChange, pickerOpen, openBraceAt]
  )

  const handleSelect = React.useCallback(
    (path: string) => {
      // Replace everything from `{{` through the current query with `{{path}}`.
      const current = props.value
      const queryEnd = openBraceAt + 2 + query.length
      const next = `${current.slice(0, openBraceAt)}{{${path}}}${current.slice(queryEnd)}`
      onChange(next)
    },
    [props.value, openBraceAt, query, onChange]
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
        query={query}
        onSelect={handleSelect}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  )
}
