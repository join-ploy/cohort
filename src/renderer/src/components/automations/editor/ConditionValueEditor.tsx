import * as React from 'react'
import { Check, ChevronDown, Loader2, Plus, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type {
  Condition,
  ConditionOp,
  ConditionValue,
  SerializableFieldDescriptor
} from '../../../../../shared/automations-types'
import type { LoadOptionsFn } from './ConditionRow'

// Why: ops whose value editor renders as multi-select. Single-select ops
// (is/is-not/eq/gte/lte) get a single-value editor instead. Centralized here
// so the field-change reset logic and the value-editor renderer agree.
const MULTI_OPS: ReadonlySet<ConditionOp> = new Set<ConditionOp>([
  'is-any-of',
  'is-none-of',
  'contains-any',
  'contains-all',
  'contains-none'
])

export function isMultiOp(op: ConditionOp): boolean {
  return MULTI_OPS.has(op)
}

export function defaultValueFor(
  op: ConditionOp,
  valueKind: SerializableFieldDescriptor['valueKind']
): ConditionValue {
  if (isMultiOp(op)) {
    return []
  }
  if (valueKind === 'number') {
    return 0
  }
  return ''
}

// Why: shared pill style for the field/op selects so the row reads as one
// chip rhythm rather than three differently-shaped controls. Centralised so
// future changes (e.g. compact mode) only touch one place.
export const PILL_BASE =
  'appearance-none rounded-md border border-input bg-background px-2.5 py-1 pr-7 text-xs font-medium text-foreground hover:bg-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50'

export type ValueEditorProps = {
  condition: Condition
  descriptor: SerializableFieldDescriptor
  loadOptions: LoadOptionsFn
  onValueChange: (value: ConditionValue) => void
}

// Why: the multi-select editor renders an inline-conditional dropdown panel
// (no Radix Portal) because the parent feature uses renderToStaticMarkup
// tests — see TriggersModal/AutoTriggerCard comments.
export function MultiValuePicker(props: ValueEditorProps): React.JSX.Element {
  const { condition, descriptor, loadOptions, onValueChange } = props
  const [options, setOptions] = React.useState<{ value: string; label: string }[]>([])
  const [open, setOpen] = React.useState(false)
  const [refreshing, setRefreshing] = React.useState(false)
  // Why: position panel as `fixed` from trigger rect so ancestor
  // `overflow-hidden` (AutoTriggerCard / AutoTriggerRuleRow) doesn't clip it.
  type DropdownPosition = {
    top: number
    left: number
    minWidth: number
    maxHeight: number
  }
  const [position, setPosition] = React.useState<DropdownPosition | null>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)

  // Why: initial cache-friendly load — first paint reuses the modal-level
  // cached array (no force). Refresh-on-open below handles bypass for staleness.
  React.useEffect(() => {
    if (!descriptor.hasFetchOptions) {
      return
    }
    let cancelled = false
    void loadOptions(descriptor.field).then((next) => {
      if (!cancelled) {
        setOptions(next)
      }
    })
    return () => {
      cancelled = true
    }
  }, [descriptor.field, descriptor.hasFetchOptions, loadOptions])

  // Why: close on outside click / scroll / resize so a `fixed`-positioned
  // panel can't drift away from its trigger or strand the user.
  React.useEffect(() => {
    if (!open) {
      return
    }
    const close = (): void => setOpen(false)
    const onDocMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (!triggerRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    // Capture-phase scroll catches every scroll container ancestor, not just window.
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    document.addEventListener('mousedown', onDocMouseDown)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      document.removeEventListener('mousedown', onDocMouseDown)
    }
  }, [open])

  const selected = Array.isArray(condition.value) ? condition.value.map(String) : []
  const labelFor = (val: string): string => options.find((o) => o.value === val)?.label ?? val

  const toggle = (val: string): void => {
    const next = selected.includes(val) ? selected.filter((v) => v !== val) : [...selected, val]
    onValueChange(next)
  }

  const remove = (val: string): void => {
    onValueChange(selected.filter((v) => v !== val))
  }

  // Why: force-refetch each time the dropdown opens so freshly-added Linear
  // tags/labels appear without reopening the modal. Closing the panel is a
  // no-op so a stray close doesn't trigger an extra IPC.
  const openDropdown = (): void => {
    const willOpen = !open
    if (willOpen) {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect) {
        const VIEWPORT_PADDING = 8
        const GAP = 4
        const PREFERRED_MAX = 320
        const MIN_USABLE = 160

        const spaceBelow = window.innerHeight - rect.bottom - GAP - VIEWPORT_PADDING
        const spaceAbove = rect.top - GAP - VIEWPORT_PADDING

        // Why: flip above only when below is too small and above has more room.
        const placeBelow = spaceBelow >= MIN_USABLE || spaceBelow >= spaceAbove

        const maxHeight = Math.max(
          MIN_USABLE,
          Math.min(PREFERRED_MAX, placeBelow ? spaceBelow : spaceAbove)
        )

        setPosition({
          top: placeBelow
            ? rect.bottom + GAP
            : Math.max(VIEWPORT_PADDING, rect.top - GAP - maxHeight),
          left: rect.left,
          minWidth: Math.max(rect.width, 160),
          maxHeight
        })
      }
    }
    setOpen(willOpen)
    if (!willOpen || !descriptor.hasFetchOptions) {
      return
    }
    setRefreshing(true)
    void loadOptions(descriptor.field, { force: true })
      .then((fresh) => {
        setOptions(fresh)
      })
      .finally(() => {
        setRefreshing(false)
      })
  }

  return (
    <div className="relative flex flex-wrap items-center gap-1" aria-label="Value">
      {selected.map((val) => {
        const label = labelFor(val)
        return (
          <Badge key={val} variant="secondary" className="gap-1">
            {label}
            <button
              type="button"
              aria-label={`Remove ${label}`}
              onClick={() => remove(val)}
              className="cursor-pointer transition-colors hover:text-destructive"
            >
              <X className="size-3" />
            </button>
          </Badge>
        )
      })}
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="xs"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={openDropdown}
      >
        <Plus className="size-3" />
        {selected.length === 0 ? 'Add value' : 'Add'}
      </Button>
      {open ? (
        <div
          ref={panelRef}
          role="menu"
          style={
            position
              ? {
                  top: position.top,
                  left: position.left,
                  minWidth: position.minWidth,
                  maxHeight: position.maxHeight
                }
              : undefined
          }
          className="fixed z-50 flex flex-col rounded-md border border-border bg-popover p-1 shadow-[0_10px_24px_rgba(0,0,0,0.18)] overflow-hidden"
        >
          {refreshing ? (
            <div className="flex shrink-0 items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Refreshing…
            </div>
          ) : null}
          <div className="flex-1 overflow-y-auto">
            {options.length === 0 ? (
              <div className="px-2 py-2 text-xs text-muted-foreground">No options available.</div>
            ) : (
              options.map((opt) => {
                const isSelected = selected.includes(opt.value)
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={isSelected}
                    onClick={() => toggle(opt.value)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
                  >
                    <span className="flex size-3 items-center justify-center">
                      {isSelected ? <Check className="size-3" /> : null}
                    </span>
                    <span>{opt.label}</span>
                  </button>
                )
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

// Why: extracted so the refresh-on-open wiring (handleRefresh + onMouseDown/
// onFocus on the native <select>) is contained and testable without dragging
// the full ValueEditor branch tree along.
export function SingleValuePicker(props: ValueEditorProps): React.JSX.Element {
  const { condition, descriptor, loadOptions, onValueChange } = props
  const [options, setOptions] = React.useState<{ value: string; label: string }[]>([])
  const [refreshing, setRefreshing] = React.useState(false)

  // Why: lazy-load options on mount and whenever the bound field changes so
  // the dropdown is populated by the time the user opens it. The parent caches
  // by field, so flipping back to a previously-loaded field is free.
  React.useEffect(() => {
    if (!descriptor.hasFetchOptions) {
      return
    }
    let cancelled = false
    void loadOptions(descriptor.field).then((next) => {
      if (!cancelled) {
        setOptions(next)
      }
    })
    return () => {
      cancelled = true
    }
  }, [descriptor.field, descriptor.hasFetchOptions, loadOptions])

  // Why: native <select> has no programmatic "open" event. Hook both
  // onMouseDown (mouse users open before menu shows) and onFocus (keyboard
  // users tab in then Space/Enter to open) — loadOptions is idempotent and the
  // modal-level cache key is stable, so double calls are safe.
  const handleRefresh = (): void => {
    if (!descriptor.hasFetchOptions) {
      return
    }
    setRefreshing(true)
    void loadOptions(descriptor.field, { force: true })
      .then((fresh) => {
        setOptions(fresh)
      })
      .finally(() => {
        setRefreshing(false)
      })
  }

  const single = typeof condition.value === 'string' ? condition.value : ''
  return (
    <div className="relative inline-flex" aria-busy={refreshing}>
      <select
        aria-label="Value"
        value={single}
        onMouseDown={handleRefresh}
        onFocus={handleRefresh}
        onChange={(e) => onValueChange(e.target.value)}
        className={cn(PILL_BASE)}
      >
        <option value="">— Select —</option>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
    </div>
  )
}

export function ValueEditor(props: ValueEditorProps): React.JSX.Element {
  const { condition, descriptor, loadOptions, onValueChange } = props

  if (descriptor.valueKind === 'number') {
    const numeric = typeof condition.value === 'number' ? condition.value : 0
    return (
      <Input
        type="number"
        aria-label="Value"
        value={numeric}
        onChange={(e) => onValueChange(Number(e.target.value))}
        className="h-7 w-24 text-xs"
      />
    )
  }

  if (descriptor.valueKind === 'string') {
    const text = typeof condition.value === 'string' ? condition.value : ''
    return (
      <Input
        type="text"
        aria-label="Value"
        value={text}
        onChange={(e) => onValueChange(e.target.value)}
        className="h-7 w-40 text-xs"
      />
    )
  }

  if (isMultiOp(condition.op)) {
    return (
      <MultiValuePicker
        condition={condition}
        descriptor={descriptor}
        loadOptions={loadOptions}
        onValueChange={onValueChange}
      />
    )
  }

  return (
    <SingleValuePicker
      condition={condition}
      descriptor={descriptor}
      loadOptions={loadOptions}
      onValueChange={onValueChange}
    />
  )
}
