import type { NestedSchema, SchemaLeafType } from '../../../shared/automation-step-schemas'
import type { AvailableVariables } from './template-dry-run'

// A single leaf in the variable tree, flattened to a dotted path.
// Shared by VariablePickerPopover (insertion menu) and AvailableVariablesPanel
// (read-only footer summary) so both surfaces present the same set in the same
// order.
export type PathEntry = {
  namespace: 'automation' | 'trigger' | 'steps'
  stepId?: string
  // Full dotted path, e.g. 'automation.projectId' or 'steps.cw1.worktreeId'.
  path: string
  leaf: string
  type: SchemaLeafType
}

// Flatten the namespaced schema into a list of dotted paths. Order matches the
// shape of the input: automation -> trigger -> steps (in step-id iteration order).
// Trigger can nest (e.g. `trigger.linear.issue.*`) so we walk it recursively;
// automation + steps remain flat.
export function buildPaths(available: AvailableVariables): PathEntry[] {
  const out: PathEntry[] = []
  for (const [key, type] of Object.entries(available.automation)) {
    out.push({ namespace: 'automation', path: `automation.${key}`, leaf: key, type })
  }
  walkTriggerPaths(available.trigger, '', out)
  for (const [stepId, schema] of Object.entries(available.steps)) {
    for (const [key, type] of Object.entries(schema)) {
      out.push({
        namespace: 'steps',
        stepId,
        path: `steps.${stepId}.${key}`,
        leaf: key,
        type
      })
    }
  }
  return out
}

function walkTriggerPaths(schema: NestedSchema, prefix: string, out: PathEntry[]): void {
  for (const [key, value] of Object.entries(schema)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') {
      out.push({ namespace: 'trigger', path: `trigger.${path}`, leaf: key, type: value })
    } else {
      walkTriggerPaths(value, path, out)
    }
  }
}
