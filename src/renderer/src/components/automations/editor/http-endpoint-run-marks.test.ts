import { describe, it, expect } from 'vitest'
import type {
  AutomationRun,
  AutomationRunStatus,
  MappedField
} from '../../../../../shared/automations-types'
import {
  statusToRunMark,
  resolveIdVariableName,
  latestRunByIdValue
} from './http-endpoint-run-marks'

const mkRun = (over: Partial<AutomationRun> = {}): AutomationRun => ({
  id: 'r1',
  automationId: 'a1',
  title: 'Run',
  scheduledFor: 0,
  status: 'completed',
  trigger: 'manual',
  workspaceId: null,
  sessionKind: 'terminal',
  chatSessionId: null,
  terminalSessionId: null,
  error: null,
  startedAt: null,
  dispatchedAt: null,
  createdAt: 0,
  ...over
})

// Materialize the trigger.http vars the way the service writes them.
const withHttpVars = (vars: Record<string, unknown>): Pick<AutomationRun, 'context'> => ({
  context: { trigger: { http: vars } }
})

const field = (over: Partial<MappedField> = {}): MappedField => ({
  path: 'id',
  variableName: 'id',
  enabled: true,
  type: 'number',
  sampleValue: 1,
  ...over
})

describe('statusToRunMark', () => {
  it('maps active statuses to in-progress', () => {
    const active: AutomationRunStatus[] = [
      'pending',
      'dispatching',
      'dispatched',
      'running',
      'waiting'
    ]
    for (const s of active) {
      expect(statusToRunMark(s)).toBe('in-progress')
    }
  })

  it('maps completed to succeeded', () => {
    expect(statusToRunMark('completed')).toBe('succeeded')
  })

  it('maps failed, cancelled and every skipped status to failed', () => {
    const failed: AutomationRunStatus[] = [
      'failed',
      'dispatch_failed',
      'cancelled',
      'skipped_missed',
      'skipped_unavailable',
      'skipped_needs_interactive_auth'
    ]
    for (const s of failed) {
      expect(statusToRunMark(s)).toBe('failed')
    }
  })
})

describe('resolveIdVariableName', () => {
  it('returns the variableName for the field whose path matches idField', () => {
    const fields = [field({ path: 'issue.number', variableName: 'issue_number' }), field()]
    expect(resolveIdVariableName(fields, 'issue.number')).toBe('issue_number')
  })

  it('returns undefined when idField is unset', () => {
    expect(resolveIdVariableName([field()], undefined)).toBeUndefined()
  })

  it('returns undefined when no field path matches', () => {
    expect(resolveIdVariableName([field()], 'missing.path')).toBeUndefined()
  })
})

describe('latestRunByIdValue', () => {
  it('keys runs by the string-coerced identity value', () => {
    const run = mkRun({ ...withHttpVars({ id: 7 }) })
    const map = latestRunByIdValue([run], 'id')
    expect(map.get('7')).toBe(run)
  })

  it('keeps the most recent run per id regardless of input order', () => {
    const older = mkRun({ id: 'old', createdAt: 100, ...withHttpVars({ id: 1 }) })
    const newer = mkRun({ id: 'new', createdAt: 200, ...withHttpVars({ id: 1 }) })
    // Pass oldest-first to prove ordering comes from createdAt, not array order.
    const map = latestRunByIdValue([older, newer], 'id')
    expect(map.get('1')).toBe(newer)
  })

  it('skips runs whose identity value is null, undefined or empty', () => {
    const runs = [
      mkRun({ id: 'a', ...withHttpVars({ id: null }) }),
      mkRun({ id: 'b', ...withHttpVars({ id: '' }) }),
      mkRun({ id: 'c', context: { trigger: { http: {} } } }),
      mkRun({ id: 'd', context: undefined })
    ]
    expect(latestRunByIdValue(runs, 'id').size).toBe(0)
  })

  it('matches a numeric run value against a string item lookup', () => {
    const run = mkRun({ ...withHttpVars({ id: 42 }) })
    const map = latestRunByIdValue([run], 'id')
    // Item vars may arrive as a string; both sides string-coerce.
    expect(map.get(String('42'))).toBe(run)
  })
})
