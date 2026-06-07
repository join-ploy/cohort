import { describe, it, expect, vi } from 'vitest'
import {
  makeAutomation,
  makeEngine,
  makeFakeSource,
  makeRecordingSource,
  makeRule
} from './auto-trigger-engine-test-fixtures'
import { AutoTriggerEngine } from './auto-trigger-engine'
import { TriggerSourceRegistry } from './trigger-sources/registry'
import { makeHttpEndpointSource } from './trigger-sources/http-endpoint'
import { makeScheduleSource } from './trigger-sources/schedule'
import type { HttpEndpointConfig } from '../../shared/automations-types'

const httpCfg = (over: Partial<HttpEndpointConfig> = {}): HttpEndpointConfig => ({
  request: { method: 'GET', url: 'https://api.test/items', headers: [], query: [] },
  itemsPath: 'data',
  fields: [{ path: 'id', variableName: 'id', enabled: true, type: 'number', sampleValue: 0 }],
  dedupeFields: ['id'],
  dateGateField: null,
  ...over
})

describe('AutoTriggerEngine — dispatch, dedup, watermark, grouping', () => {
  it('dispatches first matching rule for a new event', async () => {
    const automation = makeAutomation({
      autoTriggers: [
        {
          id: 'at1',
          source: 'linear-issue',
          enabled: true,
          enabledAt: 0,
          rules: [makeRule({ id: 'rl1', projectId: 'p1', field: 'a', value: 1 })]
        }
      ]
    })
    const { engine, dispatched, dedup } = makeEngine({
      source: makeFakeSource([
        { entityId: 'ORC-1', updatedAt: 1000, payload: {}, fields: { a: 1 } }
      ]),
      automations: [automation]
    })
    await engine.tick()
    expect(dispatched).toEqual([{ automationId: 'a1', ruleId: 'rl1', entityId: 'ORC-1' }])
    expect(dedup.has('a1|at1|ORC-1')).toBe(true)
  })

  it('does not dispatch for a paused automation even if the trigger is enabled', async () => {
    // "Pause" sets automation.enabled=false but leaves autoTriggers[].enabled true.
    // The engine must honor the automation-level pause, like the rrule scheduler does.
    const automation = makeAutomation({
      enabled: false,
      autoTriggers: [
        {
          id: 'at1',
          source: 'linear-issue',
          enabled: true,
          enabledAt: 0,
          rules: [makeRule({ id: 'rl1', projectId: 'p1', field: 'a', value: 1 })]
        }
      ]
    })
    const { engine, dispatched, dedup } = makeEngine({
      source: makeFakeSource([
        { entityId: 'ORC-1', updatedAt: 1000, payload: {}, fields: { a: 1 } }
      ]),
      automations: [automation]
    })
    await engine.tick()
    expect(dispatched).toEqual([])
    // No dedup burn either — resuming must let the issue fire.
    expect(dedup.has('a1|at1|ORC-1')).toBe(false)
  })

  it('skips dedup-hit events on subsequent ticks', async () => {
    const automation = makeAutomation({
      autoTriggers: [
        {
          id: 'at1',
          source: 'linear-issue',
          enabled: true,
          enabledAt: 0,
          rules: [makeRule({ id: 'rl1', projectId: 'p1' })]
        }
      ]
    })
    const dedup = new Set<string>(['a1|at1|ORC-1'])
    const { engine, dispatched } = makeEngine({
      source: makeFakeSource([{ entityId: 'ORC-1', updatedAt: 1000, payload: {}, fields: {} }]),
      automations: [automation],
      dedup
    })
    await engine.tick()
    expect(dispatched).toEqual([])
  })

  it('skips events with updatedAt < trigger.enabledAt', async () => {
    const automation = makeAutomation({
      autoTriggers: [
        {
          id: 'at1',
          source: 'linear-issue',
          enabled: true,
          enabledAt: 5000,
          rules: [makeRule({ id: 'rl1', projectId: 'p1' })]
        }
      ]
    })
    const { engine, dispatched } = makeEngine({
      source: makeFakeSource([{ entityId: 'ORC-1', updatedAt: 1000, payload: {}, fields: {} }]),
      automations: [automation]
    })
    await engine.tick()
    expect(dispatched).toEqual([])
  })

  it('skips disabled triggers', async () => {
    const automation = makeAutomation({
      autoTriggers: [
        {
          id: 'at1',
          source: 'linear-issue',
          enabled: false,
          enabledAt: 0,
          rules: [makeRule({ id: 'rl1', projectId: 'p1' })]
        }
      ]
    })
    const { engine, dispatched } = makeEngine({
      source: makeFakeSource([{ entityId: 'ORC-1', updatedAt: 1000, payload: {}, fields: {} }]),
      automations: [automation]
    })
    await engine.tick()
    expect(dispatched).toEqual([])
  })

  it('groups by source — calls source.poll ONCE per source per tick', async () => {
    const source = makeFakeSource([])
    const pollSpy = vi.spyOn(source, 'poll')
    const a1 = makeAutomation({
      id: 'a1',
      autoTriggers: [
        {
          id: 'at1',
          source: 'linear-issue',
          enabled: true,
          enabledAt: 0,
          rules: [makeRule({ id: 'r', projectId: 'p1' })]
        }
      ]
    })
    const a2 = makeAutomation({
      id: 'a2',
      autoTriggers: [
        {
          id: 'at2',
          source: 'linear-issue',
          enabled: true,
          enabledAt: 0,
          rules: [makeRule({ id: 'r', projectId: 'p1' })]
        }
      ]
    })
    const { engine } = makeEngine({ source, automations: [a1, a2] })
    await engine.tick()
    expect(pollSpy).toHaveBeenCalledTimes(1)
  })

  it('updates lastPollTimestamp at end of source iteration', async () => {
    const automation = makeAutomation({
      autoTriggers: [
        {
          id: 'at1',
          source: 'linear-issue',
          enabled: true,
          enabledAt: 0,
          rules: [makeRule({ id: 'r', projectId: 'p1' })]
        }
      ]
    })
    const lastPollMap = new Map<string, number>()
    const { engine } = makeEngine({
      source: makeFakeSource([]),
      automations: [automation],
      now: 5000,
      lastPollMap
    })
    await engine.tick()
    expect(lastPollMap.get('linear-issue|h1')).toBe(5000)
  })

  it('skips legacy (non-chain-shape) automations entirely — no dispatch, no dedup row', async () => {
    // Why: regression test for the engine-side filter. Legacy automations
    // (no `trigger`/`steps`) attached to an autoTrigger would otherwise burn
    // a dedup row when dispatchAutoRun → dispatchRun rejected, blocking
    // future fires for the same entity even though no run was ever created.
    const automation = makeAutomation({
      autoTriggers: [
        {
          id: 'at1',
          source: 'linear-issue',
          enabled: true,
          enabledAt: 0,
          rules: [makeRule({ id: 'r', projectId: 'p1' })]
        }
      ],
      trigger: undefined,
      steps: undefined
    })
    const { engine, dispatched, dedup } = makeEngine({
      source: makeFakeSource([{ entityId: 'ORC-1', updatedAt: 1000, payload: {}, fields: {} }]),
      automations: [automation]
    })
    await engine.tick()
    expect(dispatched).toEqual([])
    expect(dedup.size).toBe(0)
  })

  it('first match wins across rules', async () => {
    const automation = makeAutomation({
      autoTriggers: [
        {
          id: 'at1',
          source: 'linear-issue',
          enabled: true,
          enabledAt: 0,
          rules: [
            makeRule({ id: 'rl1', projectId: 'p1', field: 'a', value: 99 }),
            makeRule({ id: 'rl2', projectId: 'p2', field: 'a', value: 1 }),
            makeRule({ id: 'rl3', projectId: 'p3', field: 'a', value: 1 })
          ]
        }
      ]
    })
    const { engine, dispatched } = makeEngine({
      source: makeFakeSource([
        { entityId: 'ORC-1', updatedAt: 1000, payload: {}, fields: { a: 1 } }
      ]),
      automations: [automation]
    })
    await engine.tick()
    expect(dispatched).toEqual([{ automationId: 'a1', ruleId: 'rl2', entityId: 'ORC-1' }])
  })

  it('passes the union of watching triggers repoIds into poll ctx', async () => {
    const automation = makeAutomation({
      autoTriggers: [
        {
          id: 'at1',
          source: 'linear-issue',
          enabled: true,
          enabledAt: 0,
          repoIds: ['a'],
          rules: [makeRule({ id: 'rl1', projectId: 'p1' })]
        },
        {
          id: 'at2',
          source: 'linear-issue',
          enabled: true,
          enabledAt: 0,
          repoIds: ['b', 'c'],
          rules: [makeRule({ id: 'rl2', projectId: 'p1' })]
        }
      ]
    })
    const source = makeRecordingSource([])
    const { engine } = makeEngine({ source, automations: [automation] })
    await engine.tick()
    expect(source.polls).toHaveLength(1)
    expect(new Set(source.polls[0].repoIds)).toEqual(new Set(['a', 'b', 'c']))
  })

  it('fires a trigger only for events whose repoId is in its repoIds', async () => {
    const automation = makeAutomation({
      autoTriggers: [
        {
          id: 'at1',
          source: 'linear-issue',
          enabled: true,
          enabledAt: 0,
          repoIds: ['a'],
          rules: [makeRule({ id: 'rl1', projectId: 'p1' })]
        }
      ]
    })
    const { engine, dispatched } = makeEngine({
      source: makeFakeSource([
        { entityId: 'ORC-1', updatedAt: 1000, payload: {}, fields: {}, repoId: 'a' },
        { entityId: 'ORC-2', updatedAt: 1000, payload: {}, fields: {}, repoId: 'b' }
      ]),
      automations: [automation]
    })
    await engine.tick()
    expect(dispatched).toEqual([{ automationId: 'a1', ruleId: 'rl1', entityId: 'ORC-1' }])
  })

  it('still fires triggers with no repoIds for any event', async () => {
    const automation = makeAutomation({
      autoTriggers: [
        {
          id: 'at1',
          source: 'linear-issue',
          enabled: true,
          enabledAt: 0,
          rules: [makeRule({ id: 'rl1', projectId: 'p1' })]
        }
      ]
    })
    const { engine, dispatched } = makeEngine({
      source: makeFakeSource([{ entityId: 'ORC-1', updatedAt: 1000, payload: {}, fields: {} }]),
      automations: [automation]
    })
    await engine.tick()
    expect(dispatched).toEqual([{ automationId: 'a1', ruleId: 'rl1', entityId: 'ORC-1' }])
  })
})

describe('AutoTriggerEngine — per-trigger http polling', () => {
  it('polls a polling-enabled http-endpoint trigger once per item (empty rules = implicit match)', async () => {
    const execute = vi.fn(async () => ({
      status: 200,
      durationMs: 1,
      body: { data: [{ id: 1 }, { id: 2 }] }
    }))
    const automation = makeAutomation({
      autoTriggers: [
        {
          id: 'at1',
          source: 'http-endpoint',
          enabled: true,
          enabledAt: 0,
          pollingEnabled: true,
          http: httpCfg(),
          rules: []
        }
      ]
    })
    const { engine, dispatched } = makeEngine({
      source: makeHttpEndpointSource({ execute, now: () => 5000 }),
      automations: [automation]
    })
    await engine.tick()
    expect(execute).toHaveBeenCalledTimes(1)
    // Empty rules => one implicit match per item, targeting automation.projectId.
    // Dedup key is the JSON-encoded positional values from buildDedupKey.
    expect(dispatched).toEqual([
      { automationId: 'a1', ruleId: 'implicit', entityId: '[1]' },
      { automationId: 'a1', ruleId: 'implicit', entityId: '[2]' }
    ])
  })

  it('honors configured rules on an http trigger (firstMatch picks the rule projectId)', async () => {
    const execute = vi.fn(async () => ({
      status: 200,
      durationMs: 1,
      body: { data: [{ id: 7 }] }
    }))
    const automation = makeAutomation({
      autoTriggers: [
        {
          id: 'at1',
          source: 'http-endpoint',
          enabled: true,
          enabledAt: 0,
          pollingEnabled: true,
          http: httpCfg(),
          rules: [makeRule({ id: 'rl1', projectId: 'p9', field: 'id', value: 7 })]
        }
      ]
    })
    const { engine, dispatched } = makeEngine({
      source: makeHttpEndpointSource({ execute, now: () => 5000 }),
      automations: [automation]
    })
    await engine.tick()
    expect(dispatched).toEqual([{ automationId: 'a1', ruleId: 'rl1', entityId: '[7]' }])
  })

  it('skips dedup-hit http items on subsequent ticks', async () => {
    const execute = vi.fn(async () => ({
      status: 200,
      durationMs: 1,
      body: { data: [{ id: 1 }] }
    }))
    const automation = makeAutomation({
      autoTriggers: [
        {
          id: 'at1',
          source: 'http-endpoint',
          enabled: true,
          enabledAt: 0,
          pollingEnabled: true,
          http: httpCfg(),
          rules: []
        }
      ]
    })
    const dedup = new Set<string>(['a1|at1|[1]'])
    const { engine, dispatched } = makeEngine({
      source: makeHttpEndpointSource({ execute, now: () => 5000 }),
      automations: [automation],
      dedup
    })
    await engine.tick()
    expect(dispatched).toEqual([])
  })

  it('does not poll a manual-only http trigger (pollingEnabled=false)', async () => {
    const execute = vi.fn(async () => ({
      status: 200,
      durationMs: 1,
      body: { data: [{ id: 1 }] }
    }))
    const automation = makeAutomation({
      autoTriggers: [
        {
          id: 'at1',
          source: 'http-endpoint',
          enabled: true,
          enabledAt: 0,
          pollingEnabled: false,
          http: httpCfg(),
          rules: []
        }
      ]
    })
    const { engine, dispatched } = makeEngine({
      source: makeHttpEndpointSource({ execute, now: () => 5000 }),
      automations: [automation]
    })
    await engine.tick()
    expect(execute).not.toHaveBeenCalled()
    expect(dispatched).toEqual([])
  })

  it('skips an http trigger still inside its intervalMs', async () => {
    const execute = vi.fn(async () => ({
      status: 200,
      durationMs: 1,
      body: { data: [{ id: 1 }] }
    }))
    const automation = makeAutomation({
      autoTriggers: [
        {
          id: 'at1',
          source: 'http-endpoint',
          enabled: true,
          enabledAt: 0,
          pollingEnabled: true,
          http: httpCfg({ intervalMs: 300_000 }),
          rules: []
        }
      ]
    })
    const { engine, dispatched, httpLastPollMap } = makeEngine({
      source: makeHttpEndpointSource({ execute, now: () => 5000 }),
      automations: [automation],
      now: 1_000_000,
      // Polled 1s ago — well inside the 5-minute interval, so this tick must skip.
      httpLastPollMap: new Map([['at1', 999_000]])
    })
    await engine.tick()
    expect(execute).not.toHaveBeenCalled()
    expect(dispatched).toEqual([])
    // Clock not re-stamped because we never polled.
    expect(httpLastPollMap.get('at1')).toBe(999_000)
  })

  it('stamps the per-trigger clock before polling and dispatches when the interval has elapsed', async () => {
    const execute = vi.fn(async () => ({
      status: 200,
      durationMs: 1,
      body: { data: [{ id: 1 }] }
    }))
    const automation = makeAutomation({
      autoTriggers: [
        {
          id: 'at1',
          source: 'http-endpoint',
          enabled: true,
          enabledAt: 0,
          pollingEnabled: true,
          http: httpCfg({ intervalMs: 1000 }),
          rules: []
        }
      ]
    })
    const { engine, dispatched, httpLastPollMap } = makeEngine({
      source: makeHttpEndpointSource({ execute, now: () => 5000 }),
      automations: [automation],
      now: 1_000_000,
      httpLastPollMap: new Map([['at1', 990_000]])
    })
    await engine.tick()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(dispatched).toEqual([{ automationId: 'a1', ruleId: 'implicit', entityId: '[1]' }])
    expect(httpLastPollMap.get('at1')).toBe(1_000_000)
  })

  it('isolates a per-event error so other http items still dispatch', async () => {
    const errors: { where: string }[] = []
    const execute = vi.fn(async () => ({
      status: 200,
      durationMs: 1,
      body: { data: [{ id: 1 }, { id: 2 }] }
    }))
    const automation = makeAutomation({
      autoTriggers: [
        {
          id: 'at1',
          source: 'http-endpoint',
          enabled: true,
          enabledAt: 0,
          pollingEnabled: true,
          http: httpCfg(),
          rules: []
        }
      ]
    })
    const dispatched: string[] = []
    let throwOnFirst = true
    const dedup = new Set<string>()
    const registry = new TriggerSourceRegistry()
    registry.register(makeHttpEndpointSource({ execute, now: () => 5000 }))
    const engine = new AutoTriggerEngine({
      registry,
      listAutomations: () => [automation],
      dispatchAutoRun: ({ event }) => {
        if (throwOnFirst) {
          throwOnFirst = false
          throw new Error('boom')
        }
        dispatched.push(event.entityId)
      },
      dedupHas: (a, t, e) => dedup.has(`${a}|${t}|${e}`),
      dedupInsert: (a, t, _s, e) => {
        dedup.add(`${a}|${t}|${e}`)
      },
      lastPoll: () => 0,
      lastPollSet: () => undefined,
      httpLastPoll: () => 0,
      httpLastPollSet: () => undefined,
      scheduleNextRun: () => 0,
      scheduleNextRunSet: () => undefined,
      hostId: 'h1',
      now: () => 5000,
      onError: (where) => {
        errors.push({ where })
      }
    })
    await engine.tick()
    // First item threw inside dispatch; the second item still dispatched.
    expect(dispatched).toEqual(['[2]'])
    expect(errors).toHaveLength(1)
    expect(errors[0].where).toMatch(/http/)
  })

  it('keeps the clock stamped after a failing poll so the next within-interval tick skips', async () => {
    const errors: { where: string }[] = []
    // Non-2xx makes the source throw; the per-trigger catch should log it and
    // the clock (stamped before the poll) must rate-limit the next tick.
    const execute = vi.fn(async () => ({ status: 503, durationMs: 1, body: 'down' }))
    const automation = makeAutomation({
      autoTriggers: [
        {
          id: 'at1',
          source: 'http-endpoint',
          enabled: true,
          enabledAt: 0,
          pollingEnabled: true,
          http: httpCfg({ intervalMs: 1000 }),
          rules: []
        }
      ]
    })
    const { engine, dispatched, httpLastPollMap } = makeEngine({
      source: makeHttpEndpointSource({ execute, now: () => 5000 }),
      automations: [automation],
      now: 1_000_000,
      onError: (where) => {
        errors.push({ where })
      }
    })
    await engine.tick() // polls, source throws, clock stamped to 1_000_000
    await engine.tick() // within interval → skipped, no second poll
    expect(execute).toHaveBeenCalledTimes(1)
    expect(dispatched).toEqual([])
    expect(httpLastPollMap.get('at1')).toBe(1_000_000)
    expect(errors.some((e) => /http/.test(e.where))).toBe(true)
  })

  it('reports the per-trigger clock + interval for http triggers in getPollStatus', async () => {
    const automation = makeAutomation({
      autoTriggers: [
        {
          id: 'at1',
          source: 'http-endpoint',
          enabled: true,
          enabledAt: 0,
          pollingEnabled: true,
          http: httpCfg({ intervalMs: 30_000 }),
          rules: []
        }
      ]
    })
    const { engine } = makeEngine({
      source: makeHttpEndpointSource({ execute: vi.fn(), now: () => 5000 }),
      automations: [automation],
      httpLastPollMap: new Map([['at1', 777_000]])
    })
    expect(engine.getPollStatus().get('http-endpoint')).toEqual({
      lastPollAt: 777_000,
      intervalMs: 30_000
    })
  })
})

describe('AutoTriggerEngine — schedule trigger', () => {
  // Daily at 09:00 UTC.
  const CRON = '0 9 * * *'
  const NINE_AM = Date.UTC(2026, 5, 7, 9, 0, 0)
  const NEXT_NINE_AM = Date.UTC(2026, 5, 8, 9, 0, 0)

  const scheduleAutomation = (): ReturnType<typeof makeAutomation> =>
    makeAutomation({
      autoTriggers: [
        {
          id: 'at1',
          source: 'schedule',
          enabled: true,
          enabledAt: 0,
          rules: [],
          schedule: { cron: CRON, timezone: 'UTC' }
        }
      ]
    })

  it('anchors to the next future occurrence on first tick without firing', async () => {
    const scheduleNextRunMap = new Map<string, number>()
    const { engine, dispatched } = makeEngine({
      source: makeScheduleSource(),
      automations: [scheduleAutomation()],
      now: Date.UTC(2026, 5, 7, 8, 30, 0),
      scheduleNextRunMap
    })
    await engine.tick()
    expect(dispatched).toEqual([])
    expect(scheduleNextRunMap.get('at1')).toBe(NINE_AM)
  })

  it('fires exactly once when the instant elapses live, then advances', async () => {
    const scheduleNextRunMap = new Map<string, number>([['at1', NINE_AM]])
    const { engine, dispatched } = makeEngine({
      source: makeScheduleSource(),
      automations: [scheduleAutomation()],
      now: NINE_AM + 10_000, // 10s late, within the grace window
      scheduleNextRunMap
    })
    await engine.tick()
    expect(dispatched).toEqual([
      {
        automationId: 'a1',
        ruleId: 'implicit',
        entityId: new Date(NINE_AM).toISOString()
      }
    ])
    expect(scheduleNextRunMap.get('at1')).toBe(NEXT_NINE_AM)
  })

  it('targets the automation project via the implicit rule', async () => {
    const automation = scheduleAutomation()
    let firedProjectId: string | undefined
    const registry = new TriggerSourceRegistry()
    registry.register(makeScheduleSource())
    const scheduleNextRunMap = new Map<string, number>([['at1', NINE_AM]])
    const engine = new AutoTriggerEngine({
      registry,
      listAutomations: () => [automation],
      dispatchAutoRun: ({ rule }) => {
        firedProjectId = rule.projectId
      },
      dedupHas: () => false,
      dedupInsert: () => undefined,
      lastPoll: () => 0,
      lastPollSet: () => undefined,
      httpLastPoll: () => 0,
      httpLastPollSet: () => undefined,
      scheduleNextRun: (id) => scheduleNextRunMap.get(id) ?? 0,
      scheduleNextRunSet: (id, v) => {
        scheduleNextRunMap.set(id, v)
      },
      hostId: 'h1',
      now: () => NINE_AM + 10_000
    })
    await engine.tick()
    expect(firedProjectId).toBe(automation.projectId)
  })

  it('does not fire when the instant is not due yet', async () => {
    const scheduleNextRunMap = new Map<string, number>([['at1', NINE_AM]])
    const { engine, dispatched } = makeEngine({
      source: makeScheduleSource(),
      automations: [scheduleAutomation()],
      now: NINE_AM - 60_000,
      scheduleNextRunMap
    })
    await engine.tick()
    expect(dispatched).toEqual([])
    expect(scheduleNextRunMap.get('at1')).toBe(NINE_AM)
  })

  it('is idempotent under a double tick at the same instant', async () => {
    const scheduleNextRunMap = new Map<string, number>([['at1', NINE_AM]])
    const { engine, dispatched } = makeEngine({
      source: makeScheduleSource(),
      automations: [scheduleAutomation()],
      now: NINE_AM + 10_000,
      scheduleNextRunMap
    })
    await engine.tick()
    await engine.tick()
    expect(dispatched).toHaveLength(1)
  })

  it('skips an instant missed by more than the grace window (re-anchors, no fire)', async () => {
    const scheduleNextRunMap = new Map<string, number>([['at1', NINE_AM]])
    const { engine, dispatched } = makeEngine({
      source: makeScheduleSource(),
      automations: [scheduleAutomation()],
      now: Date.UTC(2026, 5, 7, 12, 0, 0), // 3h late, beyond the grace window
      scheduleNextRunMap
    })
    await engine.tick()
    expect(dispatched).toEqual([])
    expect(scheduleNextRunMap.get('at1')).toBe(NEXT_NINE_AM)
  })

  it('does not fire for a paused automation', async () => {
    const automation = scheduleAutomation()
    automation.enabled = false
    const scheduleNextRunMap = new Map<string, number>([['at1', NINE_AM]])
    const { engine, dispatched } = makeEngine({
      source: makeScheduleSource(),
      automations: [automation],
      now: NINE_AM + 10_000,
      scheduleNextRunMap
    })
    await engine.tick()
    expect(dispatched).toEqual([])
  })
})
