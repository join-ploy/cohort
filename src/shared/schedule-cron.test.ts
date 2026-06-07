import { describe, it, expect } from 'vitest'
import {
  nextOccurrenceAfter,
  nextOccurrences,
  isValidCron,
  describeCron,
  cronFromRecurrence,
  recurrenceFromCron
} from './schedule-cron'

const LONDON = 'Europe/London'

describe('schedule-cron', () => {
  it('computes the next daily occurrence in the given timezone', () => {
    // 2026-06-07T00:00:00Z is 01:00 London (BST). Next "0 9 * * *" is 09:00 London = 08:00Z.
    const from = Date.UTC(2026, 5, 7, 0, 0, 0)
    const next = nextOccurrenceAfter('0 9 * * *', LONDON, from)
    expect(next).toBe(Date.UTC(2026, 5, 7, 8, 0, 0))
  })

  it('returns occurrences strictly after `from`, in ascending order', () => {
    const from = Date.UTC(2026, 5, 7, 8, 0, 0) // exactly 09:00 London
    const runs = nextOccurrences('0 9 * * *', LONDON, from, 3)
    expect(runs).toHaveLength(3)
    expect(runs[0]).toBe(Date.UTC(2026, 5, 8, 8, 0, 0)) // next day, not `from` itself
    expect(runs[0]).toBeLessThan(runs[1])
    expect(runs[1]).toBeLessThan(runs[2])
  })

  it('holds 09:00 wall-clock across the autumn DST change', () => {
    // London clocks go back on 2026-10-25. 09:00 local is 08:00Z before, 09:00Z after.
    const beforeDst = Date.UTC(2026, 9, 24, 12, 0, 0)
    expect(nextOccurrenceAfter('0 9 * * *', LONDON, beforeDst)).toBe(Date.UTC(2026, 9, 25, 9, 0, 0))
  })

  it('validates cron expressions', () => {
    expect(isValidCron('0 9 * * 1-5')).toBe(true)
    expect(isValidCron('not a cron')).toBe(false)
    expect(isValidCron('')).toBe(false)
  })

  it('round-trips builder recurrences through cron', () => {
    expect(cronFromRecurrence({ freq: 'daily', hour: 9, minute: 0 })).toBe('0 9 * * *')
    expect(cronFromRecurrence({ freq: 'hourly', minute: 30 })).toBe('30 * * * *')
    expect(cronFromRecurrence({ freq: 'weekly', days: [1, 3, 5], hour: 9, minute: 0 })).toBe(
      '0 9 * * 1,3,5'
    )
    expect(cronFromRecurrence({ freq: 'monthly', dayOfMonth: 1, hour: 9, minute: 0 })).toBe(
      '0 9 1 * *'
    )

    expect(recurrenceFromCron('0 9 * * *')).toEqual({ freq: 'daily', hour: 9, minute: 0 })
    expect(recurrenceFromCron('30 * * * *')).toEqual({ freq: 'hourly', minute: 30 })
    expect(recurrenceFromCron('0 9 * * 1,3,5')).toEqual({
      freq: 'weekly',
      days: [1, 3, 5],
      hour: 9,
      minute: 0
    })
    expect(recurrenceFromCron('0 9 1 * *')).toEqual({
      freq: 'monthly',
      dayOfMonth: 1,
      hour: 9,
      minute: 0
    })
  })

  it('returns null for cron shapes the builder cannot represent', () => {
    expect(recurrenceFromCron('*/15 9-17 * * *')).toBeNull()
    expect(recurrenceFromCron('garbage')).toBeNull()
  })

  it('returns null for out-of-range fields, matching cron validity', () => {
    expect(recurrenceFromCron('99 * * * *')).toBeNull() // minute > 59
    expect(recurrenceFromCron('0 25 * * *')).toBeNull() // hour > 23
    expect(recurrenceFromCron('0 9 32 * *')).toBeNull() // day-of-month > 31
    expect(recurrenceFromCron('0 9 0 * *')).toBeNull() // day-of-month < 1
  })

  it('normalizes weekly days (sorted, de-duplicated) on parse', () => {
    expect(recurrenceFromCron('0 9 * * 5,1,3')).toEqual({
      freq: 'weekly',
      days: [1, 3, 5],
      hour: 9,
      minute: 0
    })
    expect(recurrenceFromCron('0 9 * * 1,1')).toEqual({
      freq: 'weekly',
      days: [1],
      hour: 9,
      minute: 0
    })
  })

  it('returns null for valid crons the builder cannot model', () => {
    // Weekday ranges and Sunday-as-7 aren't representable by the visual builder (0–6 only).
    expect(recurrenceFromCron('0 9 * * 1-5')).toBeNull()
    expect(recurrenceFromCron('0 9 * * 7')).toBeNull()
  })

  it('describes a builder cron and falls back to Custom for the rest', () => {
    expect(describeCron('0 9 * * *')).toBe('Daily at 09:00')
    expect(describeCron('*/15 9-17 * * *')).toBe('Custom (*/15 9-17 * * *)')
  })

  it('describes hourly, weekly, and monthly builder crons', () => {
    expect(describeCron('30 * * * *')).toBe('Hourly at :30')
    expect(describeCron('0 9 * * 5,1,3')).toBe('Weekly on Mon, Wed, Fri at 09:00')
    expect(describeCron('0 9 15 * *')).toBe('Monthly on day 15 at 09:00')
  })
})
