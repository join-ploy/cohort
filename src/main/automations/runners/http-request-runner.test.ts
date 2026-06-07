import { describe, it, expect, vi } from 'vitest'

// Mock safeStorage so decryptHttpRequest is identity — lets us assert plaintext
// header/query values flow through unchanged.
vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false }
}))

import type { Step, StepRunState, HttpRequestStepConfig } from '../../../shared/automations-types'
import type { HttpEndpointResponse } from '../http-endpoint-request'
import { HttpRequestRunner } from './http-request-runner'
import type { StepRunnerCtx } from '../step-runner'

const baseConfig: HttpRequestStepConfig = {
  request: {
    method: 'GET',
    url: 'https://api.test/u',
    headers: [],
    query: []
  },
  itemsPath: null,
  fields: []
}

const baseStep: Step = {
  id: 'hr1',
  kind: 'http-request',
  config: baseConfig,
  onFailure: 'halt',
  timeoutSeconds: null
}

const baseState: StepRunState = {
  stepId: 'hr1',
  status: 'pending',
  startedAt: null,
  finishedAt: null,
  output: null,
  error: null
}

const baseCtx = (overrides: Partial<StepRunnerCtx> = {}): StepRunnerCtx => ({
  runId: 'r1',
  step: baseStep,
  state: baseState,
  context: {},
  ...overrides
})

const ok = (body: unknown): HttpEndpointResponse => ({ status: 200, durationMs: 1, body })

describe('HttpRequestRunner', () => {
  it('resolves templates in non-secret url + query before execute', async () => {
    const execute = vi.fn().mockResolvedValue(ok({}))
    const runner = new HttpRequestRunner({ execute })
    const step: Step = {
      ...baseStep,
      config: {
        ...baseConfig,
        request: {
          method: 'GET',
          url: 'https://api.test/u/{{trigger.http.id}}',
          headers: [],
          query: [{ key: 'q', value: '{{trigger.http.q}}' }]
        }
      }
    }
    const ctx = baseCtx({
      step,
      context: { trigger: { http: { id: '7', q: 'hi' } } }
    })
    const result = await runner.tick(ctx)
    expect(result.outcome).toBe('done')
    const sent = execute.mock.calls[0][0]
    expect(sent.url).toBe('https://api.test/u/7')
    expect(sent.query[0].value).toBe('hi')
  })

  it('merges a referenced connection (base URL + headers) before execute', async () => {
    const execute = vi.fn().mockResolvedValue(ok({}))
    const getConnection = (id: string) =>
      id === 'c1'
        ? {
            id: 'c1',
            displayName: 'A',
            baseUrl: 'https://api.acme.dev',
            headers: [{ key: 'Authorization', value: 'Bearer xyz', secret: true }]
          }
        : undefined
    const runner = new HttpRequestRunner({ execute, getConnection })
    const step: Step = {
      ...baseStep,
      config: {
        ...baseConfig,
        connectionId: 'c1',
        request: { method: 'GET', url: '/u/7', headers: [], query: [] }
      }
    }
    const result = await runner.tick(baseCtx({ step }))
    expect(result.outcome).toBe('done')
    const sent = execute.mock.calls[0][0]
    expect(sent.url).toBe('https://api.acme.dev/u/7')
    expect(sent.headers).toContainEqual({ key: 'Authorization', value: 'Bearer xyz', secret: true })
  })

  it('maps the response with itemsPath set (first item)', async () => {
    const execute = vi.fn().mockResolvedValue(ok({ data: [{ id: 9, name: 'x' }] }))
    const runner = new HttpRequestRunner({ execute })
    const step: Step = {
      ...baseStep,
      config: {
        ...baseConfig,
        itemsPath: 'data',
        fields: [
          { path: 'id', variableName: 'id', enabled: true, type: 'number', sampleValue: 0 },
          { path: 'name', variableName: 'name', enabled: true, type: 'string', sampleValue: '' }
        ]
      }
    }
    const result = await runner.tick(baseCtx({ step }))
    expect(result.outcome).toBe('done')
    expect(result.status).toBe('succeeded')
    expect(result.output).toEqual({ id: 9, name: 'x' })
    expect(result.contextPatch).toEqual({ steps: { hr1: { id: 9, name: 'x' } } })
  })

  it('maps the whole body when itemsPath is null', async () => {
    const execute = vi.fn().mockResolvedValue(ok({ id: 5 }))
    const runner = new HttpRequestRunner({ execute })
    const step: Step = {
      ...baseStep,
      config: {
        ...baseConfig,
        itemsPath: null,
        fields: [{ path: 'id', variableName: 'id', enabled: true, type: 'number', sampleValue: 0 }]
      }
    }
    const result = await runner.tick(baseCtx({ step }))
    expect(result.outcome).toBe('done')
    expect(result.output).toEqual({ id: 5 })
  })

  it('fails on a non-2xx response and records no contextPatch', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 404, durationMs: 1, body: {} })
    const runner = new HttpRequestRunner({ execute })
    const result = await runner.tick(baseCtx())
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/404/)
    expect(result.contextPatch).toBeUndefined()
  })

  it('fails fast on a template error without calling execute', async () => {
    const execute = vi.fn().mockResolvedValue(ok({}))
    const runner = new HttpRequestRunner({ execute })
    const step: Step = {
      ...baseStep,
      config: {
        ...baseConfig,
        request: { method: 'GET', url: 'https://api.test/{{missing.path}}', headers: [], query: [] }
      }
    }
    const result = await runner.tick(baseCtx({ step, context: {} }))
    expect(result.outcome).toBe('failed')
    expect(result.status).toBe('failed')
    expect(execute).not.toHaveBeenCalled()
  })

  it('is idempotent: a re-tick returns the cached outcome without re-firing execute', async () => {
    const execute = vi.fn().mockResolvedValue(ok({ id: 1 }))
    const runner = new HttpRequestRunner({ execute })
    const result1 = await runner.tick(baseCtx())
    const result2 = await runner.tick(baseCtx())
    expect(result1.outcome).toBe('done')
    expect(result2.outcome).toBe('done')
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
