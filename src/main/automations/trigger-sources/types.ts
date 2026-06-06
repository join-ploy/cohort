import type {
  ConditionOp,
  HttpEndpointConfig,
  TriggerSourceId
} from '../../../shared/automations-types'

export type PollCtx = {
  since: number
  hostId: string
  // Union of the watching triggers' repoIds; set by the engine for
  // source-scoped sources like github-pr, ignored by linear-issue.
  repoIds?: string[]
  // Set by the engine for the per-trigger http-endpoint source; ignored by
  // the global linear/github sources.
  http?: HttpEndpointConfig
  now?: number
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
  // Owning repo for repo-bound entities; drives the engine's watch-list guard
  // and becomes the run's projectId.
  repoId?: string
}

export type TriggerSource = {
  id: TriggerSourceId
  displayName: string
  fieldCatalog: FieldDescriptor[]
  poll: (ctx: PollCtx) => AsyncIterable<CandidateEvent>
}
