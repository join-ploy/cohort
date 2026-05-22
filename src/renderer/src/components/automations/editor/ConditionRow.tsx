import * as React from 'react'
import { Check, ChevronDown, Plus, X } from 'lucide-react'
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

export type ConditionRowProps = {
  condition: Condition
  fieldCatalog: SerializableFieldDescriptor[]
  /** Returns options for the given field. The component calls this when the
   *  user opens an option-backed value editor. Caching is the caller's
   *  responsibility (TriggersModal memoizes by (sourceId, field)). */
  loadOptions: (field: string) => Promise<{ value: string; label: string }[]>
  onChange: (next: Condition) => void
  onRemove: () => void
}

// Why: human labels for each op. Kept here (not in shared/) because they are
// presentation-only — the wire format uses the op identifier.
const OP_LABEL: Record<ConditionOp, string> = {
  is: 'is',
  'is-not': 'is not',
  'is-any-of': 'is any of',
  'is-none-of': 'is none of',
  'contains-any': 'has any of',
  'contains-all': 'has all of',
  'contains-none': 'has none of',
  gte: '≥',
  lte: '≤',
  eq: '='
}

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

function isMultiOp(op: ConditionOp): boolean {
  return MULTI_OPS.has(op)
}

function defaultValueFor(
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

/** Pure helper: when the user switches the field, derive a new Condition that
 *  remains valid against the chosen descriptor. Exported for unit tests. */
export function resetConditionForField(
  condition: Condition,
  descriptor: SerializableFieldDescriptor
): Condition {
  const opAllowed = descriptor.ops.includes(condition.op)
  const nextOp: ConditionOp = opAllowed ? condition.op : (descriptor.ops[0] ?? 'is')
  return {
    field: descriptor.field,
    op: nextOp,
    value: defaultValueFor(nextOp, descriptor.valueKind)
  }
}

function findDescriptor(
  catalog: SerializableFieldDescriptor[],
  field: string
): SerializableFieldDescriptor | undefined {
  return catalog.find((d) => d.field === field)
}

// Why: shared pill style for the field/op selects so the row reads as one
// chip rhythm rather than three differently-shaped controls. Centralised so
// future changes (e.g. compact mode) only touch one place.
const PILL_BASE =
  'appearance-none rounded-md border border-input bg-background px-2.5 py-1 pr-7 text-xs font-medium text-foreground hover:bg-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50'

type PillSelectProps = {
  ariaLabel: string
  value: string
  onChange: (next: string) => void
  className?: string
  children: React.ReactNode
}

function PillSelect(props: PillSelectProps): React.JSX.Element {
  return (
    <div className="relative inline-flex">
      <select
        aria-label={props.ariaLabel}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className={cn(PILL_BASE, props.className)}
      >
        {props.children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
    </div>
  )
}

type ValueEditorProps = {
  condition: Condition
  descriptor: SerializableFieldDescriptor
  loadOptions: ConditionRowProps['loadOptions']
  onValueChange: (value: ConditionValue) => void
}

// Why: the multi-select editor renders an inline-conditional dropdown panel
// (no Radix Portal) because the parent feature uses renderToStaticMarkup
// tests — see TriggersModal/AutoTriggerCard comments.
function MultiValuePicker(props: ValueEditorProps): React.JSX.Element {
  const { condition, descriptor, loadOptions, onValueChange } = props
  const [options, setOptions] = React.useState<{ value: string; label: string }[]>([])
  const [open, setOpen] = React.useState(false)

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

  const selected = Array.isArray(condition.value) ? condition.value.map(String) : []
  const labelFor = (val: string): string => options.find((o) => o.value === val)?.label ?? val

  const toggle = (val: string): void => {
    const next = selected.includes(val) ? selected.filter((v) => v !== val) : [...selected, val]
    onValueChange(next)
  }

  const remove = (val: string): void => {
    onValueChange(selected.filter((v) => v !== val))
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
        type="button"
        variant="ghost"
        size="xs"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Plus className="size-3" />
        {selected.length === 0 ? 'Add value' : 'Add'}
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute left-0 top-full z-40 mt-1 min-w-[10rem] rounded-md border border-border bg-popover p-1 shadow-[0_10px_24px_rgba(0,0,0,0.18)]"
        >
          {options.length === 0 ? (
            <div className="p-2 text-xs text-muted-foreground">No options available.</div>
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
      ) : null}
    </div>
  )
}

function ValueEditor(props: ValueEditorProps): React.JSX.Element {
  const { condition, descriptor, loadOptions, onValueChange } = props
  const usesOptions =
    descriptor.valueKind === 'user' ||
    descriptor.valueKind === 'label' ||
    descriptor.valueKind === 'state' ||
    descriptor.valueKind === 'priority'

  const [options, setOptions] = React.useState<{ value: string; label: string }[]>([])

  // Why: lazy-load options on mount and whenever the bound field changes so
  // the dropdown is populated by the time the user opens it. The parent caches
  // by field, so flipping back to a previously-loaded field is free.
  React.useEffect(() => {
    if (!usesOptions || !descriptor.hasFetchOptions || isMultiOp(condition.op)) {
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
  }, [descriptor.field, descriptor.hasFetchOptions, usesOptions, condition.op, loadOptions])

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

  const single = typeof condition.value === 'string' ? condition.value : ''
  return (
    <PillSelect ariaLabel="Value" value={single} onChange={onValueChange}>
      <option value="">— Select —</option>
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </PillSelect>
  )
}

export function ConditionRow(props: ConditionRowProps): React.JSX.Element {
  const { condition, fieldCatalog, loadOptions, onChange, onRemove } = props
  const descriptor = findDescriptor(fieldCatalog, condition.field) ?? fieldCatalog[0]

  // Why: condition references a field not present in the catalog (e.g. a stale
  // saved rule whose source registered a different field set). Surface a
  // disabled stub rather than crashing — the user can pick a valid field or
  // remove the row.
  if (!descriptor) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed border-border bg-card px-2.5 py-2 text-xs text-muted-foreground">
        <span>Unknown field: {condition.field}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Remove condition"
          onClick={onRemove}
          className="ml-auto"
        >
          <X className="size-3.5" />
        </Button>
      </div>
    )
  }

  const handleFieldChange = (nextField: string): void => {
    const nextDescriptor = findDescriptor(fieldCatalog, nextField)
    if (!nextDescriptor) {
      return
    }
    onChange(resetConditionForField(condition, nextDescriptor))
  }

  const handleOpChange = (nextOp: ConditionOp): void => {
    // Why: switching between single- and multi- ops invalidates the existing
    // value shape (e.g. '' -> [] or vice versa), so reset to a type-appropriate
    // default on op transitions that cross that boundary.
    const wasMulti = isMultiOp(condition.op)
    const willMulti = isMultiOp(nextOp)
    const nextValue =
      wasMulti === willMulti ? condition.value : defaultValueFor(nextOp, descriptor.valueKind)
    onChange({ ...condition, op: nextOp, value: nextValue })
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-2.5 py-2 transition-colors hover:border-border/80">
      <PillSelect ariaLabel="Field" value={condition.field} onChange={handleFieldChange}>
        {fieldCatalog.map((d) => (
          <option key={d.field} value={d.field}>
            {d.label}
          </option>
        ))}
      </PillSelect>
      <PillSelect
        ariaLabel="Op"
        value={condition.op}
        onChange={(v) => handleOpChange(v as ConditionOp)}
        className="border-transparent bg-muted text-muted-foreground"
      >
        {descriptor.ops.map((op) => (
          <option key={op} value={op}>
            {OP_LABEL[op]}
          </option>
        ))}
      </PillSelect>
      <ValueEditor
        condition={condition}
        descriptor={descriptor}
        loadOptions={loadOptions}
        onValueChange={(value) => onChange({ ...condition, value })}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Remove condition"
        onClick={onRemove}
        className="ml-auto"
      >
        <X className="size-3.5" />
      </Button>
    </div>
  )
}
