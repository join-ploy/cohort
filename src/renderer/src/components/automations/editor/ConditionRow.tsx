import * as React from 'react'
import { ChevronDown, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type {
  Condition,
  ConditionOp,
  SerializableFieldDescriptor
} from '../../../../../shared/automations-types'
import { defaultValueFor, isMultiOp, PILL_BASE, ValueEditor } from './ConditionValueEditor'

/** Returns options for the given field. The component calls this when the
 *  user opens an option-backed value editor. Caching is the caller's
 *  responsibility (TriggersModal memoizes by (sourceId, field)). Passing
 *  { force: true } bypasses the cache and refetches — used on dropdown open
 *  so freshly-created Linear tags/labels show up without reloading the modal. */
export type LoadOptionsFn = (
  field: string,
  opts?: { force?: boolean }
) => Promise<{ value: string; label: string }[]>

export type ConditionRowProps = {
  condition: Condition
  fieldCatalog: SerializableFieldDescriptor[]
  loadOptions: LoadOptionsFn
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
