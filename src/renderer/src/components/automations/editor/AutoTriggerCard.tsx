import * as React from 'react'
import { GitPullRequest, History, Plus, Trash2, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type {
  AutoDedupEntry,
  AutoTrigger,
  Condition,
  ConditionOp,
  Rule,
  SerializableFieldDescriptor,
  TriggerSourceId
} from '../../../../../shared/automations-types'
import type { Repo } from '../../../../../shared/types'
import RepoMultiCombobox from '@/components/ui/repo-multi-combobox'
import { AutoTriggerRuleRow } from './AutoTriggerRuleRow'
import type { LoadOptionsFn } from './ConditionRow'
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
  /** Repo catalog for the github-pr watch-list combobox. Optional so legacy /
   *  linear-only call sites stay unchanged; defaults to an empty list. */
  repos?: Repo[]
  /** Catalog of fields the trigger's source can match on. Empty array is safe —
   *  the card still renders the rule skeleton, conditions just can't be added. */
  fieldCatalog: SerializableFieldDescriptor[]
  /** Closure bound to this trigger's source by the parent so ConditionRow can
   *  fetch option lists without knowing about source ids. */
  loadOptions: LoadOptionsFn
  /** Forwarded to each rule row so the per-rule project select can hint that
   *  it's optional when the chain itself supplies project context (group
   *  target). */
  chainProvidesProject?: boolean
}

// Why: per-source human label + icon. Long form (vs. TriggerPill's chip) since
// this surface is the editor.
const SOURCE_META: Record<
  TriggerSourceId,
  { label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  'linear-issue': { label: 'Linear issue', icon: Zap },
  'github-pr': { label: 'GitHub PR', icon: GitPullRequest }
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

export function setRepoIds(trigger: AutoTrigger, repoIds: string[]): AutoTrigger {
  return { ...trigger, repoIds }
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
  const {
    trigger,
    onChange,
    onRemove,
    automationId,
    projects,
    repos = [],
    fieldCatalog,
    loadOptions,
    chainProvidesProject = false
  } = props

  // Why: github-pr scopes polling to a repo watch-list and the matched repo
  // comes from the PR event, so the per-rule project picker is hidden.
  const isGithubPr = trigger.source === 'github-pr'
  const selectedRepoIds = React.useMemo(() => new Set(trigger.repoIds ?? []), [trigger.repoIds])

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
  const ruleCount = trigger.rules.length
  const meta = SOURCE_META[trigger.source] ?? { label: trigger.source, icon: Zap }
  const SourceIcon = meta.icon

  return (
    <div
      aria-label={`auto trigger ${trigger.id}`}
      className="rounded-lg border border-border bg-card text-sm shadow-xs"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <SourceIcon className="size-4 text-muted-foreground" />
          <span className="font-medium">{meta.label}</span>
          <Badge variant="outline" className="font-normal text-muted-foreground">
            {ruleCount} {ruleCount === 1 ? 'rule' : 'rules'}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer select-none items-center gap-2">
            <input
              type="checkbox"
              aria-label="Trigger enabled"
              checked={trigger.enabled}
              onChange={onToggle}
              className="size-4 cursor-pointer rounded border-input"
            />
            <span className="text-xs text-muted-foreground">
              {trigger.enabled ? 'Active' : 'Disabled'}
            </span>
          </label>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove trigger ${trigger.id}`}
            title="Remove trigger"
            onClick={onRemove}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="space-y-3 px-4 py-3">
        {isGithubPr ? (
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              Watch repositories
            </label>
            <RepoMultiCombobox
              repos={repos}
              selected={selectedRepoIds}
              onChange={(next) => onChange(setRepoIds(trigger, Array.from(next)))}
              onSelectAll={() =>
                onChange(
                  setRepoIds(
                    trigger,
                    repos.map((r) => r.id)
                  )
                )
              }
              triggerClassName="h-8 text-xs"
            />
          </div>
        ) : null}

        {trigger.rules.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-background p-4 text-center">
            <p className="text-xs text-muted-foreground">
              No rules yet — add one to start matching events.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {trigger.rules.map((rule, idx) => (
              <AutoTriggerRuleRow
                key={rule.id}
                rule={rule}
                index={idx}
                total={trigger.rules.length}
                projects={projects}
                fieldCatalog={fieldCatalog}
                loadOptions={loadOptions}
                chainProvidesProject={chainProvidesProject}
                hideProjectPicker={isGithubPr}
                onProjectChange={(projectId) =>
                  onChange(updateRule(trigger, rule.id, { projectId }))
                }
                onMoveUp={() => onChange(reorderRule(trigger, idx, idx - 1))}
                onMoveDown={() => onChange(reorderRule(trigger, idx, idx + 1))}
                onDelete={() => onChange(removeRule(trigger, rule.id))}
                onAddCondition={() => onChange(addCondition(trigger, rule.id, fieldCatalog))}
                onRemoveCondition={(i) => onChange(removeCondition(trigger, rule.id, i))}
                onUpdateCondition={(i, next) =>
                  onChange(updateCondition(trigger, rule.id, i, next))
                }
              />
            ))}
          </ul>
        )}

        <Button type="button" variant="outline" size="xs" onClick={onAddRule}>
          <Plus className="size-3" />
          Add rule
        </Button>
      </div>

      <div className="relative flex items-center justify-between border-t border-border bg-muted/20 px-4 py-2.5">
        <span className="text-xs text-muted-foreground">
          Fired for <span className="font-medium text-foreground">{dedupEntries.length}</span>{' '}
          {dedupEntries.length === 1 ? 'issue' : 'issues'}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label="View fired issues"
          disabled={!hasAutomationId}
          onClick={() => setDedupOpen(true)}
        >
          <History className="size-3" />
          View
        </Button>
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
