import type { NestedSchema, SchemaLeafType } from '../../../shared/automation-step-schemas'
import type { AvailableVariables } from './template-dry-run'

// A single leaf in the variable tree, flattened to a dotted path.
// Shared by VariablePickerPopover (insertion menu) and AvailableVariablesPanel
// (read-only footer summary) so both surfaces present the same set in the same
// order.
export type PathEntry = {
  namespace: 'automation' | 'trigger' | 'steps' | 'group'
  stepId?: string
  // Full dotted path, e.g. 'automation.projectId' or 'steps.cw1.worktreeId'.
  path: string
  leaf: string
  type: SchemaLeafType
}

// Flatten the namespaced schema into a list of dotted paths. Order matches the
// shape of the input: automation -> trigger -> group -> steps (in step-id
// iteration order). Trigger and group can nest so we walk them recursively;
// automation + steps remain flat.
export function buildPaths(available: AvailableVariables): PathEntry[] {
  const out: PathEntry[] = []
  for (const [key, type] of Object.entries(available.automation)) {
    out.push({ namespace: 'automation', path: `automation.${key}`, leaf: key, type })
  }
  walkNestedPaths(available.trigger, '', out, 'trigger')
  if (available.group) {
    walkNestedPaths(available.group, '', out, 'group')
  }
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

// Why: trigger and group both nest arbitrarily — same recursive walk for both,
// parameterized by the top-level namespace key so the dotted path stays correct.
function walkNestedPaths(
  schema: NestedSchema,
  prefix: string,
  out: PathEntry[],
  namespace: 'trigger' | 'group'
): void {
  for (const [key, value] of Object.entries(schema)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') {
      out.push({ namespace, path: `${namespace}.${path}`, leaf: key, type: value })
    } else {
      walkNestedPaths(value, path, out, namespace)
    }
  }
}
