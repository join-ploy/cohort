import { describe, it, expect, vi, beforeEach } from 'vitest'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))

// Why: the module imports ipcMain; secret-encryption reads safeStorage. With
// encryption unavailable, encrypt/decrypt are identity so we can assert the
// mask/reuse logic against raw "ciphertext" strings.
vi.mock('electron', () => ({
  ipcMain: { handle: handleMock },
  safeStorage: { isEncryptionAvailable: () => false }
}))

import { runTest, runFetchItems, resolveDraftRequest } from './http-endpoint'
import { registerAutomationHandlers } from './automations'
import type { Store } from '../persistence'
import type { AutomationService } from '../automations/service'
import {
  HTTP_SECRET_MASK,
  type Automation,
  type AutomationCreateInput,
  type AutomationUpdateInput,
  type AutoTrigger,
  type HttpEndpointConfig,
  type HttpRequestConfig
} from '../../shared/automations-types'
import type { HttpEndpointResponse } from '../automations/http-endpoint-request'

const httpConfig = (over: Partial<HttpEndpointConfig> = {}): HttpEndpointConfig => ({
  request: { method: 'GET', url: 'https://api.test/items', headers: [], query: [] },
  itemsPath: 'data',
  fields: [
    { path: 'id', variableName: 'id', enabled: true, type: 'number', sampleValue: 0 },
    { path: 'title', variableName: 'title', enabled: true, type: 'string', sampleValue: '' }
  ],
  dedupeFields: ['id'],
  dateGateField: null,
  ...over
})

const httpTrigger = (over: Partial<HttpEndpointConfig> = {}): AutoTrigger => ({
  id: 't1',
  source: 'http-endpoint',
  enabled: true,
  enabledAt: 0,
  rules: [],
  http: httpConfig(over)
})

function automation(over: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    name: 'A',
    prompt: '',
    agentId: 'claude' as Automation['agentId'],
    projectId: 'p1',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    timezone: 'UTC',
    rrule: '',
    dtstart: 0,
    enabled: true,
    nextRunAt: 0,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 0,
    updatedAt: 0,
    ...over
  }
}

function fakeStore(automations: Automation[]): Store {
  return { listAutomations: () => automations } as unknown as Store
}

describe('resolveDraftRequest', () => {
  it('resolves a masked secret to the saved ciphertext, leaving plain values alone', () => {
    const saved = automation({
      autoTriggers: [
        httpTrigger({
          request: {
            method: 'GET',
            url: 'https://api.test/items',
            headers: [{ key: 'Authorization', value: 'CIPHER', secret: true }],
            query: []
          }
        })
      ]
    })
    const draft: HttpRequestConfig = {
      method: 'GET',
      url: 'https://api.test/items',
      headers: [
        { key: 'Authorization', value: HTTP_SECRET_MASK, secret: true },
        { key: 'X-Plain', value: 'keep' }
      ],
      query: []
    }
    const resolved = resolveDraftRequest(fakeStore([saved]), draft, 'a1', 't1')
    expect(resolved.headers[0].value).toBe('CIPHER') // identity decrypt of the reused ciphertext
    expect(resolved.headers[1].value).toBe('keep')
  })

  it('encrypts a freshly typed secret (not the mask)', () => {
    const draft: HttpRequestConfig = {
      method: 'GET',
      url: 'https://api.test/items',
      headers: [{ key: 'Authorization', value: 'Bearer typed', secret: true }],
      query: []
    }
    const resolved = resolveDraftRequest(fakeStore([]), draft)
    // Why: no saved trigger + non-mask value → the draft value passes through
    // (identity encrypt/decrypt under disabled safeStorage).
    expect(resolved.headers[0].value).toBe('Bearer typed')
  })
})

describe('runTest', () => {
  it('returns ONLY status/durationMs/body — never echoes request secrets', async () => {
    const execute = vi.fn(
      async (): Promise<HttpEndpointResponse> =>
        ({
          status: 200,
          durationMs: 5,
          body: { ok: true },
          // Extra fields a buggy executor might leak; runTest must drop them.
          leaked: 'Bearer super-secret'
        }) as unknown as HttpEndpointResponse
    )
    const res = await runTest(
      { store: fakeStore([]), execute },
      {
        request: {
          method: 'GET',
          url: 'https://api.test/items',
          headers: [{ key: 'Authorization', value: 'Bearer super-secret', secret: true }],
          query: []
        }
      }
    )
    expect(Object.keys(res).sort()).toEqual(['body', 'durationMs', 'status'])
    expect(JSON.stringify(res)).not.toContain('super-secret')
  })

  it('resolves the masked secret against the saved trigger before executing', async () => {
    const saved = automation({
      autoTriggers: [
        httpTrigger({
          request: {
            method: 'GET',
            url: 'https://api.test/items',
            headers: [{ key: 'Authorization', value: 'CIPHER', secret: true }],
            query: []
          }
        })
      ]
    })
    let seen: HttpRequestConfig | undefined
    const execute = vi.fn(async (req: HttpRequestConfig): Promise<HttpEndpointResponse> => {
      seen = req
      return { status: 200, durationMs: 1, body: [] }
    })
    await runTest(
      { store: fakeStore([saved]), execute },
      {
        request: {
          method: 'GET',
          url: 'https://api.test/items',
          headers: [{ key: 'Authorization', value: HTTP_SECRET_MASK, secret: true }],
          query: []
        },
        automationId: 'a1',
        autoTriggerId: 't1'
      }
    )
    expect(seen?.headers[0].value).toBe('CIPHER')
  })
})

describe('runFetchItems', () => {
  const saved = automation({
    autoTriggers: [
      httpTrigger({
        labelField: 'title',
        subtitleField: 'author',
        dedupeFields: ['id']
      })
    ]
  })

  it('maps items to {key,label,subtitle,vars} using dedup key + label/subtitle fields', async () => {
    const body = {
      data: [
        { id: 7, title: 'First', author: 'Ada' },
        { id: 9, title: 'Second', author: 'Bob' }
      ]
    }
    const execute = vi.fn(
      async (): Promise<HttpEndpointResponse> => ({ status: 200, durationMs: 1, body })
    )
    const items = await runFetchItems(
      { store: fakeStore([saved]), execute },
      { automationId: 'a1', autoTriggerId: 't1' }
    )
    expect(items).toEqual([
      {
        key: JSON.stringify([7]),
        label: 'First',
        subtitle: 'Ada',
        vars: { id: 7, title: 'First' }
      },
      {
        key: JSON.stringify([9]),
        label: 'Second',
        subtitle: 'Bob',
        vars: { id: 9, title: 'Second' }
      }
    ])
  })

  it('falls back to the index key and "Item N" label when no dedup/label fields', async () => {
    const noMeta = automation({
      autoTriggers: [
        httpTrigger({ dedupeFields: [], labelField: undefined, subtitleField: undefined })
      ]
    })
    const body = { data: [{ id: 1, title: 'x' }] }
    const execute = vi.fn(
      async (): Promise<HttpEndpointResponse> => ({ status: 200, durationMs: 1, body })
    )
    const items = await runFetchItems(
      { store: fakeStore([noMeta]), execute },
      { automationId: 'a1', autoTriggerId: 't1' }
    )
    expect(items[0].key).toBe('0')
    expect(items[0].label).toBe('Item 1')
    expect(items[0].subtitle).toBe('')
  })

  it('throws on a non-2xx response', async () => {
    const execute = vi.fn(
      async (): Promise<HttpEndpointResponse> => ({ status: 503, durationMs: 1, body: 'down' })
    )
    await expect(
      runFetchItems(
        { store: fakeStore([saved]), execute },
        { automationId: 'a1', autoTriggerId: 't1' }
      )
    ).rejects.toThrow()
  })

  it('returns [] when the trigger or its http config is missing', async () => {
    const execute = vi.fn(
      async (): Promise<HttpEndpointResponse> => ({ status: 200, durationMs: 1, body: {} })
    )
    const items = await runFetchItems(
      { store: fakeStore([]), execute },
      { automationId: 'missing', autoTriggerId: 'nope' }
    )
    expect(items).toEqual([])
    expect(execute).not.toHaveBeenCalled()
  })
})

// --- automations.ts masking/sealing round-trip ---------------------------

function statefulStore(): {
  store: Store
  automations: Automation[]
} {
  const automations: Automation[] = []
  const store = {
    listAutomations: () => automations,
    listAutomationRuns: () => [],
    createAutomation: (input: AutomationCreateInput): Automation => {
      const created = automation({
        id: 'created',
        name: input.name,
        autoTriggers: input.autoTriggers
      })
      automations.push(created)
      return created
    },
    updateAutomation: (id: string, updates: AutomationUpdateInput): Automation => {
      const idx = automations.findIndex((a) => a.id === id)
      automations[idx] = { ...automations[idx], ...updates }
      return automations[idx]
    }
  } as unknown as Store
  return { store, automations }
}

function getHandler(channel: string): (event: unknown, args?: unknown) => unknown {
  const call = handleMock.mock.calls.find((c) => c[0] === channel)
  return call?.[1] as (event: unknown, args?: unknown) => unknown
}

const fakeService = {} as unknown as AutomationService

describe('automations IPC secret masking', () => {
  beforeEach(() => {
    handleMock.mockClear()
  })

  it('create then list returns the secret header masked (never plaintext/ciphertext)', () => {
    const { store } = statefulStore()
    registerAutomationHandlers(store, fakeService)

    const create = getHandler('automations:create')
    const list = getHandler('automations:list')

    create(null, {
      name: 'A',
      autoTriggers: [
        httpTrigger({
          request: {
            method: 'GET',
            url: 'https://api.test',
            headers: [{ key: 'Authorization', value: 'Bearer raw-token', secret: true }],
            query: []
          }
        })
      ]
    })

    const listed = list(null) as Automation[]
    const header = listed[0].autoTriggers![0].http!.request.headers[0]
    expect(header.value).toBe(HTTP_SECRET_MASK)
    // The create RETURN is also masked.
    expect(JSON.stringify(listed)).not.toContain('raw-token')
  })

  it('update with a masked value preserves the prior stored ciphertext', () => {
    const { store, automations } = statefulStore()
    registerAutomationHandlers(store, fakeService)
    const create = getHandler('automations:create')
    const update = getHandler('automations:update')

    create(null, {
      name: 'A',
      autoTriggers: [
        httpTrigger({
          request: {
            method: 'GET',
            url: 'https://api.test',
            headers: [{ key: 'Authorization', value: 'Bearer raw-token', secret: true }],
            query: []
          }
        })
      ]
    })
    const id = automations[0].id

    // The renderer sends back the masked sentinel for the unchanged secret.
    update(null, {
      id,
      updates: {
        autoTriggers: [
          httpTrigger({
            request: {
              method: 'GET',
              url: 'https://api.test/changed',
              headers: [{ key: 'Authorization', value: HTTP_SECRET_MASK, secret: true }],
              query: []
            }
          })
        ]
      }
    })

    // Stored ciphertext is the original token (identity encryption), not the mask.
    const stored = automations[0].autoTriggers![0].http!.request
    expect(stored.headers[0].value).toBe('Bearer raw-token')
    expect(stored.url).toBe('https://api.test/changed')
  })

  it('create return is masked too', () => {
    const { store } = statefulStore()
    registerAutomationHandlers(store, fakeService)
    const create = getHandler('automations:create')
    const returned = create(null, {
      name: 'A',
      autoTriggers: [
        httpTrigger({
          request: {
            method: 'GET',
            url: 'https://api.test',
            headers: [{ key: 'Authorization', value: 'Bearer raw-token', secret: true }],
            query: []
          }
        })
      ]
    }) as Automation
    expect(returned.autoTriggers![0].http!.request.headers[0].value).toBe(HTTP_SECRET_MASK)
  })
})
