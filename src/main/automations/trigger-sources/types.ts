import type { ConditionOp, TriggerSourceId } from '../../../shared/automations-types'

export type PollCtx = {
  since: number
  hostId: string
}

export type FieldDescriptor = {
  field: string
  label: string
  valueKind: 'user' | 'label' | 'state' | 'priority' | 'string' | 'number'
  ops: ConditionOp[]
  // Optional async lookup so sources can populate dropdowns (e.g. Linear labels)
  // without forcing every field to ship a static option list.
  fetchOptions?: (ctx: PollCtx) => Promise<{ value: string; label: string }[]>
}

export type CandidateEvent = {
  entityId: string
  entityIdentifier?: string
  updatedAt: number
  payload: Record<string, unknown>
  fields: Record<string, unknown>
}

export type TriggerSource = {
  id: TriggerSourceId
  displayName: string
  fieldCatalog: FieldDescriptor[]
  poll: (ctx: PollCtx) => AsyncIterable<CandidateEvent>
}
