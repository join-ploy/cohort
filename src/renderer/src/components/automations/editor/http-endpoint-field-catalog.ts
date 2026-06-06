import type {
  ConditionOp,
  MappedField,
  SerializableFieldDescriptor
} from '../../../../../shared/automations-types'

// Why: HTTP fields are free-typed (no option lookups), so the value editor
// renders a plain number/text input. These op sets mirror what the renderer's
// ValueEditor can render for each valueKind (see ConditionValueEditor.tsx).
const NUMBER_OPS: ConditionOp[] = ['eq', 'gte', 'lte', 'is-any-of']
const STRING_OPS: ConditionOp[] = ['is', 'is-not', 'is-any-of', 'is-none-of']

// Build the condition editor catalog from the Test-derived fields. Disabled
// fields are excluded; numbers get numeric ops, everything else string equality.
// `hasFetchOptions` is always false — HTTP fields have no option lookups.
export function httpFieldsToCatalog(fields: MappedField[]): SerializableFieldDescriptor[] {
  return fields
    .filter((f) => f.enabled)
    .map((f) => ({
      field: f.variableName,
      label: f.path,
      valueKind: f.type === 'number' ? 'number' : 'string',
      ops: f.type === 'number' ? NUMBER_OPS : STRING_OPS,
      hasFetchOptions: false
    }))
}
