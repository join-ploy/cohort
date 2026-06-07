import { describe, it, expect } from 'vitest'
import {
  clearStepSecrets,
  serializeStepForClipboard,
  parseStepFromClipboard
} from './chain-editor-clipboard'
import type {
  HttpRequestStepConfig,
  RunCommandConfig,
  Step
} from '../../../shared/automations-types'

function runCommandStep(): Step {
  return {
    id: 'run-command-1',
    kind: 'run-command',
    config: {
      worktreeRef: '{{steps.create-worktree-1.worktreeId}}',
      source: 'custom',
      customCommand: 'echo hi',
      captureStdout: true
    } satisfies RunCommandConfig,
    onFailure: 'continue',
    timeoutSeconds: 120
  }
}

function httpStepWithSecrets(): Step {
  return {
    id: 'http-request-1',
    kind: 'http-request',
    config: {
      connectionId: 'conn-9',
      request: {
        method: 'POST',
        url: 'https://api.example.com/things',
        headers: [
          { id: 'h1', key: 'Authorization', value: 'Bearer real-token', secret: true },
          { id: 'h2', key: 'Accept', value: 'application/json' }
        ],
        query: [
          { id: 'q1', key: 'apiKey', value: 'real-key', secret: true },
          { id: 'q2', key: 'page', value: '1' }
        ],
        body: '{"password":"hunter2"}',
        bodySecret: true
      },
      itemsPath: 'data',
      fields: [{ path: 'id', variableName: 'id', enabled: true, type: 'string', sampleValue: 'x' }],
      sampleResponse: { data: [{ id: 'x' }] }
    } satisfies HttpRequestStepConfig,
    onFailure: 'halt',
    timeoutSeconds: null
  }
}

describe('clearStepSecrets', () => {
  it('leaves a non-http step untouched (deep copy, equal value)', () => {
    const step = runCommandStep()
    const cleared = clearStepSecrets(step)
    expect(cleared).toEqual(step)
    expect(cleared).not.toBe(step)
    expect(cleared.config).not.toBe(step.config)
  })

  it('blanks secret header/query values and a secret body, keeps non-secret values', () => {
    const cleared = clearStepSecrets(httpStepWithSecrets())
    const config = cleared.config as HttpRequestStepConfig
    expect(config.request.headers[0].value).toBe('')
    expect(config.request.headers[0].secret).toBe(true)
    expect(config.request.headers[1].value).toBe('application/json')
    expect(config.request.query[0].value).toBe('')
    expect(config.request.query[1].value).toBe('1')
    expect(config.request.body).toBe('')
    expect(config.request.bodySecret).toBe(true)
  })

  it('preserves non-secret http fields like connectionId, sampleResponse, fields, itemsPath', () => {
    const config = clearStepSecrets(httpStepWithSecrets()).config as HttpRequestStepConfig
    expect(config.connectionId).toBe('conn-9')
    expect(config.itemsPath).toBe('data')
    expect(config.fields).toHaveLength(1)
    expect(config.sampleResponse).toEqual({ data: [{ id: 'x' }] })
  })

  it('does not mutate the original step', () => {
    const step = httpStepWithSecrets()
    clearStepSecrets(step)
    const original = step.config as HttpRequestStepConfig
    expect(original.request.headers[0].value).toBe('Bearer real-token')
    expect(original.request.body).toBe('{"password":"hunter2"}')
  })
})

describe('serialize + parse round trip', () => {
  it('round-trips a non-http step preserving id and all values', () => {
    const step = runCommandStep()
    const parsed = parseStepFromClipboard(serializeStepForClipboard(step))
    expect(parsed).toEqual(step)
  })

  it('never writes a real secret to the serialized payload', () => {
    const text = serializeStepForClipboard(httpStepWithSecrets())
    expect(text).not.toContain('real-token')
    expect(text).not.toContain('real-key')
    expect(text).not.toContain('hunter2')
  })

  it('keeps the pasted id identical to the source id', () => {
    const parsed = parseStepFromClipboard(serializeStepForClipboard(runCommandStep()))
    expect(parsed?.id).toBe('run-command-1')
  })
})

describe('parseStepFromClipboard', () => {
  it('returns null for non-JSON text', () => {
    expect(parseStepFromClipboard('not json {')).toBeNull()
  })

  it('returns null for JSON that is not our envelope', () => {
    expect(parseStepFromClipboard(JSON.stringify({ hello: 'world' }))).toBeNull()
  })

  it('returns null for the wrong envelope kind', () => {
    const text = JSON.stringify({ kind: 'something/else', version: 1, step: runCommandStep() })
    expect(parseStepFromClipboard(text)).toBeNull()
  })

  it('returns null when the step kind is not a known StepKind', () => {
    const bad = { ...runCommandStep(), kind: 'totally-made-up' }
    const text = JSON.stringify({ kind: 'orca/automation-step', version: 1, step: bad })
    expect(parseStepFromClipboard(text)).toBeNull()
  })

  it('returns null when required step fields are missing or malformed', () => {
    const noId = JSON.stringify({
      kind: 'orca/automation-step',
      version: 1,
      step: { kind: 'run-command', config: {}, onFailure: 'halt', timeoutSeconds: null }
    })
    expect(parseStepFromClipboard(noId)).toBeNull()

    const badTimeout = JSON.stringify({
      kind: 'orca/automation-step',
      version: 1,
      step: { id: 'x', kind: 'run-command', config: {}, onFailure: 'halt', timeoutSeconds: 'soon' }
    })
    expect(parseStepFromClipboard(badTimeout)).toBeNull()

    const badOnFailure = JSON.stringify({
      kind: 'orca/automation-step',
      version: 1,
      step: { id: 'x', kind: 'run-command', config: {}, onFailure: 'maybe', timeoutSeconds: null }
    })
    expect(parseStepFromClipboard(badOnFailure)).toBeNull()
  })
})
