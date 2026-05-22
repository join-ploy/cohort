import { describe, it, expect, vi } from 'vitest'
import { AutoTriggerEngine } from './auto-trigger-engine'
import { TriggerSourceRegistry } from './trigger-sources/registry'
import type { CandidateEvent, TriggerSource } from './trigger-sources/types'
import {
  makeAutomation,
  makeEngine,
  makeFakeSource,
  makeRule,
  type DispatchedRecord
} from './auto-trigger-engine-test-fixtures'

describe('AutoTriggerEngine — mutex, error isolation, timer lifecycle', () => {
  it('mutex prevents overlapping ticks', async () => {
    // Source yields one event then pauses on a controllable Promise; while
    // paused, a second tick() should return immediately (mutex) instead of
    // double-firing the same event.
    let resolveGate: () => void = () => {}
    const gate = new Promise<void>((r) => {
      resolveGate = r
    })

    const slowSource: TriggerSource = {
      id: 'linear-issue',
      displayName: 'L',
      fieldCatalog: [],
      async *poll() {
        yield { entityId: 'ORC-1', updatedAt: 1000, payload: {}, fields: {} }
        await gate
      }
    }
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
    const { engine, dispatched } = makeEngine({ source: slowSource, automations: [automation] })

    const firstTick = engine.tick()
    await Promise.resolve()
    await Promise.resolve()
    const secondTick = engine.tick()
    await secondTick
    expect(dispatched.length).toBe(1)
    resolveGate()
    await firstTick
    expect(dispatched.length).toBe(1)
  })

  it('error in per-event evaluation does not abort the loop', async () => {
    const errors: { where: string }[] = []
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
    let throwOnFirstDispatch = true
    const dispatched: DispatchedRecord[] = []
    const dedup = new Set<string>()
    const registry = new TriggerSourceRegistry()
    registry.register(
      makeFakeSource([
        { entityId: 'ORC-1', updatedAt: 1000, payload: {}, fields: {} },
        { entityId: 'ORC-2', updatedAt: 1100, payload: {}, fields: {} }
      ])
    )
    const engine = new AutoTriggerEngine({
      registry,
      listAutomations: () => [automation],
      dispatchAutoRun: ({ automation: a, rule, event }) => {
        if (throwOnFirstDispatch) {
          throwOnFirstDispatch = false
          throw new Error('boom')
        }
        dispatched.push({ automationId: a.id, ruleId: rule.id, entityId: event.entityId })
      },
      dedupHas: (a, t, e) => dedup.has(`${a}|${t}|${e}`),
      dedupInsert: (a, t, _s, e) => {
        dedup.add(`${a}|${t}|${e}`)
      },
      lastPoll: () => 0,
      lastPollSet: () => undefined,
      hostId: 'h',
      now: () => 5000,
      onError: (where) => {
        errors.push({ where })
      }
    })
    await engine.tick()
    expect(dispatched.length).toBe(1)
    expect(errors.length).toBe(1)
    expect(errors[0].where).toMatch(/ORC-1/)
  })

  it('error from a source does not abort other sources', async () => {
    const errors: { where: string }[] = []
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
    const registry = new TriggerSourceRegistry()
    // Why: oxlint's require-yield rule rejects an async-generator body
    // without a yield expression. Build a hand-rolled async iterable that
    // rejects on first iteration instead.
    const throwingSource: TriggerSource = {
      id: 'linear-issue',
      displayName: 'L',
      fieldCatalog: [],
      poll: () => ({
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<CandidateEvent>> {
              return Promise.reject(new Error('source-poll-failed'))
            }
          }
        }
      })
    }
    registry.register(throwingSource)
    const engine = new AutoTriggerEngine({
      registry,
      listAutomations: () => [automation],
      dispatchAutoRun: () => {},
      dedupHas: () => false,
      dedupInsert: () => {},
      lastPoll: () => 0,
      lastPollSet: () => undefined,
      hostId: 'h',
      now: () => 5000,
      onError: (where) => {
        errors.push({ where })
      }
    })
    await engine.tick()
    expect(errors.length).toBe(1)
    expect(errors[0].where).toMatch(/linear-issue/)
  })

  it('start() schedules tick on interval; stop() clears it', async () => {
    vi.useFakeTimers()
    try {
      const { engine } = makeEngine({
        source: makeFakeSource([]),
        automations: []
      })
      const spy = vi.spyOn(engine, 'tick')
      engine.start(1000)
      await vi.advanceTimersByTimeAsync(3000)
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2)
      engine.stop()
      const after = spy.mock.calls.length
      await vi.advanceTimersByTimeAsync(3000)
      expect(spy.mock.calls.length).toBe(after)
    } finally {
      vi.useRealTimers()
    }
  })
})
