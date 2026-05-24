import * as React from 'react'
import { ArrowDown, ArrowUp, ChevronDown, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type {
  Condition,
  Rule,
  SerializableFieldDescriptor
} from '../../../../../shared/automations-types'
import { ConditionRow, type LoadOptionsFn } from './ConditionRow'

export type AutoTriggerRuleRowProps = {
  rule: Rule
  index: number
  total: number
  projects: { id: string; displayName: string }[]
  fieldCatalog: SerializableFieldDescriptor[]
  loadOptions: LoadOptionsFn
  onProjectChange: (projectId: string) => void
  onMoveUp: () => void
  onMoveDown: () => void
  onDelete: () => void
  onAddCondition: () => void
  onRemoveCondition: (index: number) => void
  onUpdateCondition: (index: number, next: Condition) => void
  /** When true, the chain supplies its own project context (via a
   *  create-workspace-group step), so the per-rule project select becomes
   *  optional and the empty placeholder reads "Inferred from group" instead
   *  of "Select project". */
  chainProvidesProject?: boolean
}

// Why: a single rule inside an AutoTriggerCard. Extracted into its own file
// so AutoTriggerCard stays under the project's 300-line ceiling.
export function AutoTriggerRuleRow(props: AutoTriggerRuleRowProps): React.JSX.Element {
  const {
    rule,
    index,
    total,
    projects,
    fieldCatalog,
    loadOptions,
    onProjectChange,
    onMoveUp,
    onMoveDown,
    onDelete,
    onAddCondition,
    onRemoveCondition,
    onUpdateCondition,
    chainProvidesProject = false
  } = props
  const isFirst = index === 0
  const isLast = index === total - 1
  // Why: when the chain supplies its own project (group target), the per-rule
  // project select is optional — surface that with the placeholder text so
  // operators don't think they're being silently required to pick one.
  const placeholderLabel = chainProvidesProject ? '— Inferred from group —' : '— Select project —'

  return (
    <li aria-label={`rule ${rule.id}`} className="rounded-md border border-border bg-background">
      <div className="flex items-center justify-between gap-2 bg-muted/30 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="flex size-5 items-center justify-center rounded-full border border-border bg-card text-[10px] font-semibold text-muted-foreground">
            {index + 1}
          </span>
          <span className="text-xs text-muted-foreground">Rule</span>
          <div className="relative inline-flex">
            <select
              aria-label="Project"
              value={rule.projectId}
              onChange={(e) => onProjectChange(e.target.value)}
              className={cn(
                'appearance-none rounded-md border border-input bg-background px-2 py-1 pr-7 text-xs transition-colors hover:bg-accent',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50'
              )}
            >
              <option value="">{placeholderLabel}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Move up"
            disabled={isFirst}
            onClick={onMoveUp}
          >
            <ArrowUp className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Move down"
            disabled={isLast}
            onClick={onMoveDown}
          >
            <ArrowDown className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Delete rule"
            title="Delete rule"
            onClick={onDelete}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="space-y-2 px-3 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          All of the following must match
        </p>
        <div className="space-y-1.5">
          {rule.conditions.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No conditions — rule matches every candidate.
            </p>
          ) : (
            rule.conditions.map((cond, i) => (
              <ConditionRow
                key={i}
                condition={cond}
                fieldCatalog={fieldCatalog}
                loadOptions={loadOptions}
                onChange={(next) => onUpdateCondition(i, next)}
                onRemove={() => onRemoveCondition(i)}
              />
            ))
          )}
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={onAddCondition}
            disabled={fieldCatalog.length === 0}
          >
            <Plus className="size-3" />
            Add condition
          </Button>
        </div>
      </div>
    </li>
  )
}
