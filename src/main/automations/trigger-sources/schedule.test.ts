import { describe, it, expect } from 'vitest'
import { makeScheduleSource } from './schedule'

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of iter) {
    out.push(x)
  }
  return out
}

describe('schedule trigger source', () => {
  it('formats one event for the scheduled instant', async () => {
    const source = makeScheduleSource()
    const scheduledFor = Date.UTC(2026, 5, 8, 8, 0, 0)
    const events = await collect(
      source.poll({
        since: scheduledFor,
        now: scheduledFor + 1234,
        hostId: 'h1',
        schedule: { cron: '0 9 * * *', timezone: 'Europe/London' }
      })
    )
    expect(events).toHaveLength(1)
    expect(events[0].entityId).toBe(new Date(scheduledFor).toISOString())
    expect(events[0].updatedAt).toBe(scheduledFor)
    expect(events[0].payload).toEqual({
      schedule: {
        firedAt: scheduledFor + 1234,
        scheduledFor,
        cron: '0 9 * * *',
        timezone: 'Europe/London'
      }
    })
  })

  it('yields nothing when no schedule config is present', async () => {
    const source = makeScheduleSource()
    const events = await collect(source.poll({ since: 0, hostId: 'h1' }))
    expect(events).toHaveLength(0)
  })
})
