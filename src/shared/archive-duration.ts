// Why: the settings UI shows the archive TTL (stored as ms) as a number + unit.
// Conversion lives here so it's pure and unit-testable, separate from React.
export type DurationUnit = 'hours' | 'days' | 'weeks'

export const DURATION_UNIT_MS: Record<DurationUnit, number> = {
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
  weeks: 7 * 24 * 60 * 60 * 1000
}

// Why: guard against a typo (e.g. "0") setting near-instant auto-deletion of
// archived workspaces.
export const MIN_ARCHIVE_TTL_MS = DURATION_UNIT_MS.hours

export function durationPartsToMs(value: number, unit: DurationUnit): number {
  // Why: Math.max doesn't catch NaN/Infinity — guard here, the canonical
  // conversion point, so a non-finite input can never be persisted as a TTL.
  if (!Number.isFinite(value)) {
    return MIN_ARCHIVE_TTL_MS
  }
  const ms = Math.round(value) * DURATION_UNIT_MS[unit]
  return Math.max(MIN_ARCHIVE_TTL_MS, ms)
}

export function msToDurationParts(ms: number): { value: number; unit: DurationUnit } {
  const clamped = Number.isFinite(ms) ? Math.max(MIN_ARCHIVE_TTL_MS, ms) : MIN_ARCHIVE_TTL_MS
  for (const unit of ['weeks', 'days', 'hours'] as DurationUnit[]) {
    const unitMs = DURATION_UNIT_MS[unit]
    if (clamped % unitMs === 0) {
      return { value: clamped / unitMs, unit }
    }
  }
  // Fallback for non-aligned custom values: express in rounded hours.
  return { value: Math.round(clamped / DURATION_UNIT_MS.hours), unit: 'hours' }
}
