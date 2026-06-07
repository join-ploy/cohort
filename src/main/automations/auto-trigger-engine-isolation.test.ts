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
    // Why: the mutex is enforced by the synchronous `this.ticking = true` at
    // the top of tick() — `secondTick` would observe it `true` even without
    // the awaits. The gate-pause + microtask drains are belt-and-suspenders
    // so the test also exercises the scenario where the FIRST tick is
    // genuinely mid-flight when the SECOND tick is invoked.
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
      httpLastPoll: () => 0,
      httpLastPollSet: () => undefined,
      scheduleNextRun: () => 0,
      scheduleNextRunSet: () => undefined,
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
      httpLastPoll: () => 0,
      httpLastPollSet: () => undefined,
      scheduleNextRun: () => 0,
      scheduleNextRunSet: () => undefined,
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

  it('mid-stream iterator rejection: prior events dispatched, watermark NOT advanced', async () => {
    // Why: covers the case where a source yields one event successfully then
    // its iterator rejects on the next pull (e.g. pagination fails on page 2).
    // The rejection escapes pollSource's per-event try/catch and is caught by
    // the per-source try/catch in tick(), which skips the lastPollSet call —
    // so the watermark stays put and a retry re-polls from the same `since`.
    const errors: { where: string }[] = []
    const dispatched: DispatchedRecord[] = []
    const dedup = new Set<string>()
    const lastPollMap = new Map<string, number>()

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

    let phase = 0
    const flakySource: TriggerSource = {
      id: 'linear-issue',
      displayName: 'L',
      fieldCatalog: [],
      poll: () =>
        ({
          [Symbol.asyncIterator]() {
            return this
          },
          next(): Promise<IteratorResult<CandidateEvent>> {
            phase += 1
            if (phase === 1) {
              return Promise.resolve({
                value: { entityId: 'ORC-1', updatedAt: 1000, payload: {}, fields: {} },
                done: false
              })
            }
            return Promise.reject(new Error('mid-stream'))
          }
        }) as AsyncIterableIterator<CandidateEvent>
    }

    const registry = new TriggerSourceRegistry()
    registry.register(flakySource)

    const engine = new AutoTriggerEngine({
      registry,
      listAutomations: () => [automation],
      dispatchAutoRun: ({ automation: a, rule, event }) => {
        dispatched.push({ automationId: a.id, ruleId: rule.id, entityId: event.entityId })
      },
      dedupHas: (a, t, e) => dedup.has(`${a}|${t}|${e}`),
      dedupInsert: (a, t, _s, e) => {
        dedup.add(`${a}|${t}|${e}`)
      },
      lastPoll: (s, h) => lastPollMap.get(`${s}|${h}`) ?? 0,
      lastPollSet: (s, h, v) => {
        lastPollMap.set(`${s}|${h}`, v)
      },
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

    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]).toMatchObject({ entityId: 'ORC-1' })
    expect(dedup.has('a1|at1|ORC-1')).toBe(true)
    expect(errors).toHaveLength(1)
    expect(errors[0].where).toMatch(/linear-issue/)
    // Watermark NOT advanced — source failed mid-stream, so retry re-polls from since.
    expect(lastPollMap.get('linear-issue|h1')).toBeUndefined()
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
