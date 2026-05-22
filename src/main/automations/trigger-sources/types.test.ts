import { describe, it, expectTypeOf } from 'vitest'
import type { TriggerSource, FieldDescriptor, CandidateEvent, PollCtx } from './types'
import type { ConditionOp, TriggerSourceId } from '../../../shared/automations-types'

describe('TriggerSource interface', () => {
  it('publishes id/displayName/fieldCatalog/poll', () => {
    expectTypeOf<TriggerSource>().toHaveProperty('id')
    expectTypeOf<TriggerSource>().toHaveProperty('displayName')
    expectTypeOf<TriggerSource>().toHaveProperty('fieldCatalog')
    expectTypeOf<TriggerSource>().toHaveProperty('poll')
  })

  it('id is typed as TriggerSourceId', () => {
    expectTypeOf<TriggerSource['id']>().toEqualTypeOf<TriggerSourceId>()
  })

  it('fieldCatalog is an array of FieldDescriptor', () => {
    expectTypeOf<TriggerSource['fieldCatalog']>().toEqualTypeOf<FieldDescriptor[]>()
  })

  it('FieldDescriptor exposes field/label/valueKind/ops', () => {
    expectTypeOf<FieldDescriptor['field']>().toEqualTypeOf<string>()
    expectTypeOf<FieldDescriptor['label']>().toEqualTypeOf<string>()
    expectTypeOf<FieldDescriptor['valueKind']>().toEqualTypeOf<
      'user' | 'label' | 'state' | 'priority' | 'string' | 'number'
    >()
    expectTypeOf<FieldDescriptor['ops']>().toEqualTypeOf<ConditionOp[]>()
  })

  it('CandidateEvent exposes entityId/updatedAt/payload/fields', () => {
    expectTypeOf<CandidateEvent['entityId']>().toEqualTypeOf<string>()
    expectTypeOf<CandidateEvent['updatedAt']>().toEqualTypeOf<number>()
    expectTypeOf<CandidateEvent['payload']>().toEqualTypeOf<Record<string, unknown>>()
    expectTypeOf<CandidateEvent['fields']>().toEqualTypeOf<Record<string, unknown>>()
  })

  it('PollCtx carries since + hostId', () => {
    expectTypeOf<PollCtx['since']>().toEqualTypeOf<number>()
    expectTypeOf<PollCtx['hostId']>().toEqualTypeOf<string>()
  })
})
