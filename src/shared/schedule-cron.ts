import { Cron } from 'croner'

// Single source of truth for schedule semantics: both the auto-trigger engine
// (firing) and the renderer (preview) call these, so what's previewed is exactly
// what fires — including DST — because croner owns the timezone math.

export type Recurrence =
  | { freq: 'hourly'; minute: number }
  | { freq: 'daily'; hour: number; minute: number }
  | { freq: 'weekly'; days: number[]; hour: number; minute: number } // 0=Sun…6=Sat
  | { freq: 'monthly'; dayOfMonth: number; hour: number; minute: number }

function makeCron(cron: string, timezone: string): Cron | null {
  try {
    // croner throws on malformed expressions; treat any throw as invalid.
    return new Cron(cron, { timezone })
  } catch {
    return null
  }
}

export function isValidCron(cron: string): boolean {
  if (!cron.trim()) {
    return false
  }
  // Validate against a fixed valid zone so a bad tz can't mask a bad expression.
  return makeCron(cron, 'UTC') !== null
}

export function nextOccurrenceAfter(cron: string, timezone: string, fromMs: number): number | null {
  const c = makeCron(cron, timezone)
  const next = c?.nextRun(new Date(fromMs))
  return next ? next.getTime() : null
}

export function nextOccurrences(
  cron: string,
  timezone: string,
  fromMs: number,
  n: number
): number[] {
  const c = makeCron(cron, timezone)
  if (!c) {
    return []
  }
  return c.nextRuns(n, new Date(fromMs)).map((d) => d.getTime())
}

// ---- builder <-> cron bridge -------------------------------------------------

export function cronFromRecurrence(r: Recurrence): string {
  switch (r.freq) {
    case 'hourly':
      return `${r.minute} * * * *`
    case 'daily':
      return `${r.minute} ${r.hour} * * *`
    case 'weekly':
      return `${r.minute} ${r.hour} * * ${[...r.days].sort((a, b) => a - b).join(',')}`
    case 'monthly':
      return `${r.minute} ${r.hour} ${r.dayOfMonth} * *`
  }
}

const INT = /^\d+$/

// Reverse only the constrained shapes the visual builder emits; anything else
// returns null, which the UI reads as "Custom" (raw-cron) mode.
export function recurrenceFromCron(cron: string): Recurrence | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) {
    return null
  }
  const [min, hr, dom, mon, dow] = parts
  if (mon !== '*') {
    return null
  }
  // Bound each field to its cron-valid range so recurrenceFromCron and
  // isValidCron stay consistent — out-of-range fields fall through to null.
  if (!INT.test(min)) {
    return null
  }
  const minute = Number(min)
  if (minute > 59) {
    return null
  }

  // hourly: "<min> * * * *"
  if (hr === '*' && dom === '*' && dow === '*') {
    return { freq: 'hourly', minute }
  }
  if (!INT.test(hr)) {
    return null
  }
  const hour = Number(hr)
  if (hour > 23) {
    return null
  }

  // daily: "<min> <hr> * * *"
  if (dom === '*' && dow === '*') {
    return { freq: 'daily', hour, minute }
  }

  // weekly: "<min> <hr> * * <d,d,...>"
  if (dom === '*' && dow !== '*') {
    const days = dow.split(',')
    if (!days.every((d) => INT.test(d) && Number(d) >= 0 && Number(d) <= 6)) {
      return null
    }
    // Normalize to match the builder's canonical day list (sorted, de-duplicated).
    const normalized = [...new Set(days.map(Number))].sort((a, b) => a - b)
    return { freq: 'weekly', days: normalized, hour, minute }
  }

  // monthly: "<min> <hr> <dom> * *"
  if (dow === '*' && INT.test(dom)) {
    const dayOfMonth = Number(dom)
    if (dayOfMonth < 1 || dayOfMonth > 31) {
      return null
    }
    return { freq: 'monthly', dayOfMonth, hour, minute }
  }

  return null
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] // index = cron day (0=Sun)

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

// Human summary for card headers; falls back to the raw expression for shapes
// the builder can't model so the header still says something meaningful.
export function describeCron(cron: string): string {
  const r = recurrenceFromCron(cron)
  if (!r) {
    return `Custom (${cron})`
  }
  switch (r.freq) {
    case 'hourly':
      return `Hourly at :${pad2(r.minute)}`
    case 'daily':
      return `Daily at ${pad2(r.hour)}:${pad2(r.minute)}`
    case 'weekly':
      return `Weekly on ${[...r.days]
        .sort((a, b) => a - b)
        .map((d) => WEEKDAY_NAMES[d])
        .join(', ')} at ${pad2(r.hour)}:${pad2(r.minute)}`
    case 'monthly':
      return `Monthly on day ${r.dayOfMonth} at ${pad2(r.hour)}:${pad2(r.minute)}`
  }
}
