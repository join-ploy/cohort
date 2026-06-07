import { describe, it, expect } from 'vitest'
import { msToDurationParts, durationPartsToMs, MIN_ARCHIVE_TTL_MS } from './archive-duration'

describe('archive-duration', () => {
  it('picks the largest whole unit', () => {
    expect(msToDurationParts(3 * 86_400_000)).toEqual({ value: 3, unit: 'days' })
    expect(msToDurationParts(604_800_000)).toEqual({ value: 1, unit: 'weeks' })
    expect(msToDurationParts(3_600_000)).toEqual({ value: 1, unit: 'hours' })
    expect(msToDurationParts(2 * 604_800_000)).toEqual({ value: 2, unit: 'weeks' })
  })

  it('falls back to rounded hours for non-aligned values', () => {
    expect(msToDurationParts(90 * 60_000)).toEqual({ value: 2, unit: 'hours' }) // 1.5h -> 2h
  })

  it('round-trips through durationPartsToMs', () => {
    const ms = durationPartsToMs(3, 'days')
    expect(ms).toBe(3 * 86_400_000)
    expect(msToDurationParts(ms)).toEqual({ value: 3, unit: 'days' })
  })

  it('clamps to the minimum (1 hour)', () => {
    expect(durationPartsToMs(0, 'hours')).toBe(MIN_ARCHIVE_TTL_MS)
    expect(durationPartsToMs(-5, 'days')).toBe(MIN_ARCHIVE_TTL_MS)
    expect(msToDurationParts(1000)).toEqual({ value: 1, unit: 'hours' })
  })
})
