import { describe, it, expect, vi } from 'vitest'
import {
  makeAutomation,
  makeEngine,
  makeFakeSource,
  makeRule
} from './auto-trigger-engine-test-fixtures'

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
})
