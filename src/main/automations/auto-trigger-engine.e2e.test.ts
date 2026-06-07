/* Why: end-to-end integration test for the auto-trigger pipeline. Unlike
   `auto-trigger-engine.test.ts` (which stubs dispatchAutoRun and the store),
   this file wires a real Store + AutomationService and only fakes the
   TriggerSource. The goal is to lock the cross-module contract: an event
   yielded by a source results in a persisted run with the full provenance
   metadata and a dedup row, and restart-of-auto reuses that metadata without
   adding a new dedup row. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AutoTriggerEngine } from './auto-trigger-engine'
import { TriggerSourceRegistry } from './trigger-sources/registry'
import { makeHttpEndpointSource } from './trigger-sources/http-endpoint'
import { AutomationService } from './service'
import type { HttpEndpointResponse } from './http-endpoint-request'
import type { CandidateEvent, TriggerSource } from './trigger-sources/types'
import type { Repo } from '../../shared/types'
import type { Store } from '../persistence'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

vi.mock('../git/repo', () => ({
  getGitUsername: vi.fn().mockReturnValue('testuser')
}))

async function createStore(): Promise<Store> {
  vi.resetModules()
  const { Store: StoreCtor, initDataPath } = await import('../persistence')
  initDataPath()
  return new StoreCtor()
}

const makeRepo = (overrides: Partial<Repo> = {}): Repo => ({
  id: 'p1',
  path: '/repo',
  displayName: 'test',
  badgeColor: '#fff',
  addedAt: 1,
  ...overrides
})

const makeEvent = (overrides: Partial<CandidateEvent> = {}): CandidateEvent => ({
  entityId: 'iss-1',
  entityIdentifier: 'ORC-1',
  updatedAt: 1000,
  payload: {
    issue: {
      id: 'iss-1',
      identifier: 'ORC-1',
      title: 'Test issue',
      description: '',
      url: 'https://example/ORC-1',
      assigneeEmail: 'me@example.com',
      stateName: 'Todo',
      priority: 2
    }
  },
  fields: {
    'linear.assignee': 'u1',
    'linear.tag': [],
    'linear.state': 'Todo',
    'linear.priority': 2
  },
  ...overrides
})

type SetupOpts = {
  events: CandidateEvent[]
  enabledAt?: number
}

type Harness = {
  store: Store
  service: AutomationService
  engine: AutoTriggerEngine
  automationId: string
  autoTriggerId: string
}

async function setup(opts: SetupOpts): Promise<Harness> {
  const store = await createStore()
  store.addRepo(makeRepo())
  const automation = store.createAutomation({
    name: 'auto-x',
    prompt: '',
    agentId: 'claude',
    projectId: 'p1',
    workspaceMode: 'new_per_run',
    timezone: 'UTC',
    rrule: '',
    dtstart: 0,
    trigger: { kind: 'manual' },
    // Why: wait-for-setup with no registered setup-script entry short-circuits
    // to `done`, so the fire-and-forget chain tick completes cleanly without
    // requiring any runner deps wired up.
    steps: [
      {
        id: 'step-1',
        kind: 'wait-for-setup',
        config: { worktreeRef: 'dummy', requireSuccess: false },
        onFailure: 'continue',
        timeoutSeconds: null
      }
    ]
  })
  const stored = store.listAutomations().find((entry) => entry.id === automation.id)!
  const autoTriggerId = 'at1'
  stored.autoTriggers = [
    {
      id: autoTriggerId,
      source: 'linear-issue',
      enabled: true,
      enabledAt: opts.enabledAt ?? 0,
      rules: [{ id: 'rl1', projectId: 'p1', conditions: [] }]
    }
  ]

  const events = opts.events
  const fakeSource: TriggerSource = {
    id: 'linear-issue',
    displayName: 'Linear',
    fieldCatalog: [],
    async *poll() {
      for (const e of events) {
        yield e
      }
    }
  }
  const registry = new TriggerSourceRegistry()
  registry.register(fakeSource)

  const service = new AutomationService(store, { tickMs: 60_000 })
  const engine = new AutoTriggerEngine({
    registry,
    listAutomations: () => store.listAutomations(),
    dispatchAutoRun: async (args) => {
      await service.dispatchAutoRun(args)
    },
    dedupHas: (a, t, e) => store.hasAutomationAutoDedup(a, t, e),
    dedupInsert: (a, t, s, e, ei, firedAt) =>
      store.insertAutomationAutoDedup({
        automationId: a,
        autoTriggerId: t,
        sourceId: s,
        entityId: e,
        entityIdentifier: ei,
        firedAt
      }),
    lastPoll: () => 0,
    lastPollSet: () => undefined,
    httpLastPoll: () => 0,
    httpLastPollSet: () => undefined,
    scheduleNextRun: () => 0,
    scheduleNextRunSet: () => undefined,
    hostId: 'test',
    now: () => Date.now()
  })
  return { store, service, engine, automationId: automation.id, autoTriggerId }
}

// Fixed clock so the per-trigger interval gate is deterministic across ticks.
const HTTP_NOW = Date.parse('2026-06-06T00:00:00Z')
const HTTP_ENABLED_AT = Date.parse('2026-06-01T00:00:00Z')

type HttpHarness = {
  store: Store
  engine: AutoTriggerEngine
  automationId: string
  autoTriggerId: string
  executeCalls: () => number
  httpLastPollMap: Map<string, number>
}

// Mirrors `setup` but seeds an http-endpoint trigger driven by a stub executor
// returning two items: one past `enabledAt` (fires) and one before it (date-gated).
async function setupHttp(): Promise<HttpHarness> {
  const store = await createStore()
  store.addRepo(makeRepo())
  const automation = store.createAutomation({
    name: 'auto-http',
    prompt: '',
    agentId: 'claude',
    projectId: 'p1',
    workspaceMode: 'new_per_run',
    timezone: 'UTC',
    rrule: '',
    dtstart: 0,
    trigger: { kind: 'manual' },
    steps: [
      {
        id: 'step-1',
        kind: 'wait-for-setup',
        config: { worktreeRef: 'dummy', requireSuccess: false },
        onFailure: 'continue',
        timeoutSeconds: null
      }
    ]
  })
  const stored = store.listAutomations().find((entry) => entry.id === automation.id)!
  const autoTriggerId = 'at-http'
  stored.autoTriggers = [
    {
      id: autoTriggerId,
      source: 'http-endpoint',
      enabled: true,
      enabledAt: HTTP_ENABLED_AT,
      pollingEnabled: true,
      rules: [],
      http: {
        request: { method: 'GET', url: 'https://api.test/items', headers: [], query: [] },
        itemsPath: 'data',
        fields: [
          { path: 'id', variableName: 'id', enabled: true, type: 'number', sampleValue: 0 },
          { path: 'title', variableName: 'title', enabled: true, type: 'string', sampleValue: '' },
          { path: 'updated', variableName: 'updated', enabled: true, type: 'date', sampleValue: '' }
        ],
        dedupeFields: ['id'],
        dateGateField: 'updated',
        intervalMs: 300_000
      }
    }
  ]

  let executeCount = 0
  const execute = async (): Promise<HttpEndpointResponse> => {
    executeCount++
    return {
      status: 200,
      durationMs: 1,
      body: {
        data: [
          { id: 1, title: 'New', updated: '2026-06-05T00:00:00Z' }, // past enabledAt → fires
          { id: 2, title: 'Old', updated: '2026-05-01T00:00:00Z' } // before enabledAt → gated out
        ]
      }
    }
  }
  const registry = new TriggerSourceRegistry()
  registry.register(makeHttpEndpointSource({ execute, now: () => HTTP_NOW }))

  const httpLastPollMap = new Map<string, number>()
  const service = new AutomationService(store, { tickMs: 60_000 })
  const engine = new AutoTriggerEngine({
    registry,
    listAutomations: () => store.listAutomations(),
    dispatchAutoRun: async (args) => {
      await service.dispatchAutoRun(args)
    },
    dedupHas: (a, t, e) => store.hasAutomationAutoDedup(a, t, e),
    dedupInsert: (a, t, s, e, ei, firedAt) =>
      store.insertAutomationAutoDedup({
        automationId: a,
        autoTriggerId: t,
        sourceId: s,
        entityId: e,
        entityIdentifier: ei,
        firedAt
      }),
    lastPoll: () => 0,
    lastPollSet: () => undefined,
    httpLastPoll: (id) => httpLastPollMap.get(id) ?? 0,
    httpLastPollSet: (id, v) => {
      httpLastPollMap.set(id, v)
    },
    scheduleNextRun: () => 0,
    scheduleNextRunSet: () => undefined,
    hostId: 'test',
    now: () => HTTP_NOW
  })
  return {
    store,
    engine,
    automationId: automation.id,
    autoTriggerId,
    executeCalls: () => executeCount,
    httpLastPollMap
  }
}

describe('AutoTriggerEngine end-to-end (real service + store, fake source)', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-auto-e2e-test-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('matching event yields a run with trigger=auto and full context', async () => {
    const { store, engine, automationId, autoTriggerId } = await setup({
      events: [makeEvent()]
    })
    await engine.tick()
    const runs = store.listAutomationRuns(automationId)
    expect(runs).toHaveLength(1)
    const [run] = runs
    expect(run.trigger).toBe('auto')
    expect(run.triggerSource).toBe('linear-issue')
    expect(run.triggerEntityId).toBe('iss-1')
    expect(run.triggerAutoTriggerId).toBe(autoTriggerId)
    expect(run.triggerRuleId).toBe('rl1')
    const ctx = run.context as { trigger?: { linear?: { issue: { identifier: string } } } }
    expect(ctx.trigger?.linear?.issue.identifier).toBe('ORC-1')
    expect(store.hasAutomationAutoDedup(automationId, autoTriggerId, 'iss-1')).toBe(true)
  })

  it('second tick on the same event does NOT create a second run', async () => {
    const { store, engine, automationId } = await setup({
      events: [makeEvent()]
    })
    await engine.tick()
    await engine.tick()
    expect(store.listAutomationRuns(automationId)).toHaveLength(1)
  })

  it('event with updatedAt < trigger.enabledAt is ignored', async () => {
    const { store, engine, automationId } = await setup({
      events: [makeEvent({ updatedAt: 100 })],
      enabledAt: 100_000
    })
    await engine.tick()
    expect(store.listAutomationRuns(automationId)).toHaveLength(0)
  })

  it('two concurrent ticks racing on the same entity insert exactly one run (mutex)', async () => {
    const { store, engine, automationId, autoTriggerId } = await setup({
      events: [makeEvent()]
    })
    // Why: per Phase 5 the engine's `ticking` flag makes the second `tick()`
    // return immediately while the first is still running. This verifies the
    // mutex holds when both calls share a real store and service rather than
    // exercising parallel-dispatch races.
    await Promise.all([engine.tick(), engine.tick()])
    expect(store.listAutomationRuns(automationId)).toHaveLength(1)
    expect(store.listAutomationAutoDedup(automationId, autoTriggerId)).toHaveLength(1)
  })

  it('restarting an auto-fired failed run preserves all trigger metadata and does NOT add a dedup row', async () => {
    const { store, service, engine, automationId } = await setup({
      events: [makeEvent()]
    })
    await engine.tick()
    const original = store.listAutomationRuns(automationId)[0]
    // Why: dispatchRun marks the run as `running` and fires the chain tick
    // asynchronously — flip the status to `failed` so restartRun's
    // RESTARTABLE_STATUSES gate lets it through.
    original.status = 'failed'
    store.replaceAutomationRun(original)
    const dedupBefore = store.listAutomationAutoDedup(automationId).length

    const restarted = await service.restartRun(original.id)
    expect(restarted.trigger).toBe('auto')
    expect(restarted.triggerSource).toBe(original.triggerSource)
    expect(restarted.triggerAutoTriggerId).toBe(original.triggerAutoTriggerId)
    expect(restarted.triggerRuleId).toBe(original.triggerRuleId)
    expect(restarted.triggerEntityId).toBe(original.triggerEntityId)
    expect(restarted.restartedFromRunId).toBe(original.id)

    const dedupAfter = store.listAutomationAutoDedup(automationId).length
    expect(dedupAfter).toBe(dedupBefore)
  })
})

describe('AutoTriggerEngine http-endpoint end-to-end (real service + store, stub executor)', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-auto-http-e2e-test-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('polls the endpoint and dispatches exactly ONE run with trigger.http context (date-gated item only)', async () => {
    const { store, engine, automationId, autoTriggerId } = await setupHttp()
    await engine.tick()

    const runs = store.listAutomationRuns(automationId)
    expect(runs).toHaveLength(1)
    const [run] = runs
    expect(run.trigger).toBe('auto')
    expect(run.triggerSource).toBe('http-endpoint')
    // Empty rules → one implicit match; dedup key is the JSON-encoded id value.
    expect(run.triggerRuleId).toBe('implicit')
    expect(run.triggerEntityId).toBe('[1]')
    expect(run.triggerAutoTriggerId).toBe(autoTriggerId)
    // trigger.http carries the mapped variables from the firing (un-gated) item only.
    const ctx = run.context as { trigger?: { http?: Record<string, unknown> } }
    expect(ctx.trigger?.http).toEqual({ id: 1, title: 'New', updated: '2026-06-05T00:00:00Z' })
    expect(store.hasAutomationAutoDedup(automationId, autoTriggerId, '[1]')).toBe(true)
  })

  it('a second tick within intervalMs re-polls nothing and never re-fires the deduped item', async () => {
    const { store, engine, automationId, executeCalls, httpLastPollMap } = await setupHttp()
    await engine.tick()
    await engine.tick()

    expect(store.listAutomationRuns(automationId)).toHaveLength(1)
    // Interval gate: the second tick must skip the poll entirely (not just dedup).
    expect(executeCalls()).toBe(1)
    // Clock was stamped on the first poll and is reused to gate the second tick.
    expect(httpLastPollMap.get('at-http')).toBe(HTTP_NOW)
  })
})
