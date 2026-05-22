import * as React from 'react'
import type {
  AutoDedupEntry,
  AutoTrigger,
  Condition,
  ConditionOp,
  Rule,
  SerializableFieldDescriptor,
  TriggerSourceId
} from '../../../../../shared/automations-types'
import { ConditionRow } from './ConditionRow'
import { DedupListPopover } from './DedupListPopover'

export type AutoTriggerCardProps = {
  trigger: AutoTrigger
  onChange: (next: AutoTrigger) => void
  onRemove: () => void
  /** Owning automation id — required for dedup IPC. Empty string when the
   *  automation hasn't been saved yet; the footer renders 0 and disables View. */
  automationId: string
  /** Used for the per-rule project picker. */
  projects: { id: string; displayName: string }[]
  /** Catalog of fields the trigger's source can match on. Empty array is safe —
   *  the card still renders the rule skeleton, conditions just can't be added. */
  fieldCatalog: SerializableFieldDescriptor[]
  /** Closure bound to this trigger's source by the parent so ConditionRow can
   *  fetch option lists without knowing about source ids. */
  loadOptions: (field: string) => Promise<{ value: string; label: string }[]>
}

// Why: per-source human label; mirrors TriggerPill's SOURCE_LABEL but uses the
// long form because this surface is the editor, not the chip.
const SOURCE_LABEL: Record<TriggerSourceId, string> = {
  'linear-issue': 'Linear issue'
}

function sourceLabelFor(source: TriggerSourceId): string {
  return SOURCE_LABEL[source] ?? source
}

// Pure helpers — exported so they can be unit-tested without rendering. The
// component composes them and emits the result through `onChange`.

export function toggleEnabled(trigger: AutoTrigger): AutoTrigger {
  return { ...trigger, enabled: !trigger.enabled }
}

export function addRule(trigger: AutoTrigger): AutoTrigger {
  const next: Rule = { id: crypto.randomUUID(), conditions: [], projectId: '' }
  return { ...trigger, rules: [...trigger.rules, next] }
}

export function removeRule(trigger: AutoTrigger, ruleId: string): AutoTrigger {
  return { ...trigger, rules: trigger.rules.filter((r) => r.id !== ruleId) }
}

export function reorderRule(trigger: AutoTrigger, fromIdx: number, toIdx: number): AutoTrigger {
  if (
    fromIdx === toIdx ||
    fromIdx < 0 ||
    toIdx < 0 ||
    fromIdx >= trigger.rules.length ||
    toIdx >= trigger.rules.length
  ) {
    return trigger
  }
  const next = trigger.rules.slice()
  const [moved] = next.splice(fromIdx, 1)
  next.splice(toIdx, 0, moved)
  return { ...trigger, rules: next }
}

export function updateRule(
  trigger: AutoTrigger,
  ruleId: string,
  patch: Partial<Rule>
): AutoTrigger {
  return {
    ...trigger,
    rules: trigger.rules.map((r) => (r.id === ruleId ? { ...r, ...patch } : r))
  }
}

function defaultConditionValue(op: ConditionOp): Condition['value'] {
  // Why: mirror ConditionRow's defaultValueFor without importing it — the
  // catalog's valueKind isn't known here for string/number distinction at
  // append time, so always seed with the string/array shape and let
  // ConditionRow recompute on the first field change.
  const isMultiOp =
    op === 'is-any-of' ||
    op === 'is-none-of' ||
    op === 'contains-any' ||
    op === 'contains-all' ||
    op === 'contains-none'
  return isMultiOp ? [] : ''
}

export function addCondition(
  trigger: AutoTrigger,
  ruleId: string,
  fieldCatalog: SerializableFieldDescriptor[]
): AutoTrigger {
  const head = fieldCatalog[0]
  const newCondition: Condition = {
    field: head?.field ?? '',
    op: head?.ops[0] ?? 'is',
    value: defaultConditionValue(head?.ops[0] ?? 'is')
  }
  return {
    ...trigger,
    rules: trigger.rules.map((r) =>
      r.id === ruleId ? { ...r, conditions: [...r.conditions, newCondition] } : r
    )
  }
}

export function removeCondition(trigger: AutoTrigger, ruleId: string, index: number): AutoTrigger {
  return {
    ...trigger,
    rules: trigger.rules.map((r) =>
      r.id === ruleId ? { ...r, conditions: r.conditions.filter((_, i) => i !== index) } : r
    )
  }
}

export function updateCondition(
  trigger: AutoTrigger,
  ruleId: string,
  index: number,
  next: Condition
): AutoTrigger {
  return {
    ...trigger,
    rules: trigger.rules.map((r) =>
      r.id === ruleId
        ? { ...r, conditions: r.conditions.map((c, i) => (i === index ? next : c)) }
        : r
    )
  }
}

export function AutoTriggerCard(props: AutoTriggerCardProps): React.JSX.Element {
  const { trigger, onChange, onRemove, automationId, projects, fieldCatalog, loadOptions } = props

  const onToggle = (): void => {
    onChange(toggleEnabled(trigger))
  }
  const onAddRule = (): void => {
    onChange(addRule(trigger))
  }

  // Why: unsaved automations have no id so there's nothing to query; bail and
  // render the footer with zero entries + a disabled View button.
  const [dedupEntries, setDedupEntries] = React.useState<AutoDedupEntry[]>([])
  const [dedupOpen, setDedupOpen] = React.useState(false)
  const refresh = React.useCallback(async (): Promise<void> => {
    if (!automationId) {
      setDedupEntries([])
      return
    }
    const entries = await window.api.automations.listAutoDedup({
      automationId,
      autoTriggerId: trigger.id
    })
    setDedupEntries(entries)
  }, [automationId, trigger.id])
  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const hasAutomationId = automationId !== ''

  return (
    <div aria-label={`auto trigger ${trigger.id}`} className="rounded border bg-card p-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-medium">{sourceLabelFor(trigger.source)}</span>
          <label className="flex items-center gap-1 text-muted-foreground">
            <input
              type="checkbox"
              aria-label="Trigger enabled"
              checked={trigger.enabled}
              onChange={onToggle}
            />
            Enabled
          </label>
        </div>
        <button
          type="button"
          aria-label={`remove trigger ${trigger.id}`}
          onClick={onRemove}
          className="rounded border border-border bg-background px-2 py-0.5 hover:bg-accent hover:text-foreground"
        >
          Remove
        </button>
      </div>

      <ul className="mt-2 space-y-2">
        {trigger.rules.map((rule, idx) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            index={idx}
            total={trigger.rules.length}
            projects={projects}
            fieldCatalog={fieldCatalog}
            loadOptions={loadOptions}
            onProjectChange={(projectId) => onChange(updateRule(trigger, rule.id, { projectId }))}
            onMoveUp={() => onChange(reorderRule(trigger, idx, idx - 1))}
            onMoveDown={() => onChange(reorderRule(trigger, idx, idx + 1))}
            onDelete={() => onChange(removeRule(trigger, rule.id))}
            onAddCondition={() => onChange(addCondition(trigger, rule.id, fieldCatalog))}
            onRemoveCondition={(i) => onChange(removeCondition(trigger, rule.id, i))}
            onUpdateCondition={(i, next) => onChange(updateCondition(trigger, rule.id, i, next))}
          />
        ))}
      </ul>

      <button
        type="button"
        onClick={onAddRule}
        className="mt-2 rounded border border-border bg-background px-2 py-0.5 hover:bg-accent hover:text-foreground"
      >
        + Add rule
      </button>

      {/* Dedup management footer */}
      <div className="relative mt-3 flex items-center justify-between border-t pt-2 text-xs">
        <span className="text-muted-foreground">Fired for {dedupEntries.length} issues</span>
        <button
          type="button"
          aria-label="View fired issues"
          disabled={!hasAutomationId}
          onClick={() => setDedupOpen(true)}
          className="rounded border border-border bg-background px-2 py-0.5 hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          View
        </button>
        <DedupListPopover
          entries={dedupEntries}
          open={dedupOpen}
          onClearOne={(entityId) => {
            void window.api.automations
              .clearAutoDedup({
                automationId,
                autoTriggerId: trigger.id,
                entityId
              })
              .then(refresh)
          }}
          onClearAll={() => {
            void window.api.automations
              .clearAutoDedup({
                automationId,
                autoTriggerId: trigger.id
              })
              .then(refresh)
          }}
          onClose={() => setDedupOpen(false)}
        />
      </div>
    </div>
  )
}

type RuleRowProps = {
  rule: Rule
  index: number
  total: number
  projects: { id: string; displayName: string }[]
  fieldCatalog: SerializableFieldDescriptor[]
  loadOptions: (field: string) => Promise<{ value: string; label: string }[]>
  onProjectChange: (projectId: string) => void
  onMoveUp: () => void
  onMoveDown: () => void
  onDelete: () => void
  onAddCondition: () => void
  onRemoveCondition: (index: number) => void
  onUpdateCondition: (index: number, next: Condition) => void
}

function RuleRow(props: RuleRowProps): React.JSX.Element {
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
    onUpdateCondition
  } = props
  const isFirst = index === 0
  const isLast = index === total - 1
  return (
    <li aria-label={`rule ${rule.id}`} className="rounded border border-border bg-background p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">Rule {index + 1}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Move up"
            disabled={isFirst}
            onClick={onMoveUp}
            className="rounded border border-border bg-background px-1 hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            ▲
          </button>
          <button
            type="button"
            aria-label="Move down"
            disabled={isLast}
            onClick={onMoveDown}
            className="rounded border border-border bg-background px-1 hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            ▼
          </button>
          <button
            type="button"
            aria-label="Delete rule"
            onClick={onDelete}
            className="rounded border border-border bg-background px-2 py-0.5 hover:bg-accent hover:text-foreground"
          >
            Delete rule
          </button>
        </div>
      </div>

      <label className="mt-2 flex items-center gap-2">
        <span className="text-muted-foreground">Project:</span>
        <select
          aria-label="Project"
          value={rule.projectId}
          onChange={(e) => onProjectChange(e.target.value)}
          className="rounded border border-border bg-background px-1 py-0.5"
        >
          <option value="">— Select project —</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
      </label>

      <div className="mt-2 space-y-1">
        {rule.conditions.length === 0 ? (
          <p className="text-muted-foreground">No conditions — rule matches every candidate.</p>
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
        <button
          type="button"
          onClick={onAddCondition}
          disabled={fieldCatalog.length === 0}
          className="rounded border border-border bg-background px-2 py-0.5 hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          + Add condition
        </button>
      </div>
    </li>
  )
}
