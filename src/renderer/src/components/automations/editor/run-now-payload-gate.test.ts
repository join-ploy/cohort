import { describe, it, expect } from 'vitest'
import type { AutoTrigger } from '../../../../../shared/automations-types'
import { automationNeedsRunNowPayload } from './run-now-payload-gate'

const httpTrigger = (over: Partial<AutoTrigger> = {}): AutoTrigger => ({
  id: 'http-1',
  source: 'http-endpoint',
  enabled: true,
  enabledAt: 0,
  rules: [],
  http: {
    request: { method: 'GET', url: 'https://x', headers: [], query: [] },
    itemsPath: null,
    fields: [],
    dedupeFields: [],
    dateGateField: null
  },
  ...over
})

describe('automationNeedsRunNowPayload', () => {
  it('is true for a manual-enabled http trigger (the C1 gap)', () => {
    expect(
      automationNeedsRunNowPayload({
        trigger: { kind: 'manual' },
        autoTriggers: [httpTrigger({ manualEnabled: true, pollingEnabled: false })]
      })
    ).toBe(true)
  })

  it('is false for a polling-only http trigger', () => {
    expect(
      automationNeedsRunNowPayload({
        trigger: { kind: 'manual' },
        autoTriggers: [httpTrigger({ manualEnabled: false, pollingEnabled: true })]
      })
    ).toBe(false)
  })

  it('is true when the trigger accepts a Linear ticket', () => {
    expect(
      automationNeedsRunNowPayload({ trigger: { kind: 'manual', acceptsLinearTicket: true } })
    ).toBe(true)
  })

  it('is true when the trigger accepts a project selection', () => {
    expect(
      automationNeedsRunNowPayload({ trigger: { kind: 'manual', acceptsProjectSelection: true } })
    ).toBe(true)
  })

  it('is false for a plain manual trigger with no extra inputs', () => {
    expect(automationNeedsRunNowPayload({ trigger: { kind: 'manual' } })).toBe(false)
  })

  it('is false when there are no triggers at all', () => {
    expect(automationNeedsRunNowPayload({})).toBe(false)
  })
})
