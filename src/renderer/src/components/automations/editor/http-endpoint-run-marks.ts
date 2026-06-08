import type {
  AutomationRun,
  AutomationRunStatus,
  MappedField
} from '../../../../../shared/automations-types'

// The coarse run-status mark shown beside a manual-picker item. Three buckets
// cover every run status; an item with no matching run renders no mark.
export type HttpItemRunMark = 'in-progress' | 'succeeded' | 'failed'

// Why: exhaustive switch (no default) so adding a new AutomationRunStatus is a
// type error here until it's bucketed. Cancelled/skipped fold into `failed` —
// an interrupted or never-run latest run reads as "not a clean success".
export function statusToRunMark(status: AutomationRunStatus): HttpItemRunMark {
  switch (status) {
    case 'pending':
    case 'dispatching':
    case 'dispatched':
    case 'running':
    case 'waiting':
      return 'in-progress'
    case 'completed':
      return 'succeeded'
    case 'failed':
    case 'dispatch_failed':
    case 'cancelled':
    case 'skipped_missed':
    case 'skipped_unavailable':
    case 'skipped_needs_interactive_auth':
      return 'failed'
  }
}

// The configured id field stores a dot-path (like labelField/subtitleField), but
// item.vars and run.context.trigger.http are keyed by variableName. Resolve the
// path to its variableName so both sides can be looked up directly.
export function resolveIdVariableName(
  fields: MappedField[],
  idField: string | undefined
): string | undefined {
  if (!idField) {
    return undefined
  }
  return fields.find((f) => f.path === idField)?.variableName
}

function readRunHttpVar(run: AutomationRun, variableName: string): unknown {
  const trigger = run.context?.trigger
  if (trigger == null || typeof trigger !== 'object') {
    return undefined
  }
  const http = (trigger as { http?: unknown }).http
  if (http == null || typeof http !== 'object') {
    return undefined
  }
  return (http as Record<string, unknown>)[variableName]
}

// Map each identity value to the most recent run carrying it (by createdAt), so
// the picker marks items by their latest run independent of run-list ordering.
// Values are string-coerced to survive numeric-vs-string id drift.
export function latestRunByIdValue(
  runs: AutomationRun[],
  matchVariableName: string
): Map<string, AutomationRun> {
  const out = new Map<string, AutomationRun>()
  for (const run of runs) {
    const value = readRunHttpVar(run, matchVariableName)
    if (value == null || value === '') {
      continue
    }
    const key = String(value)
    const existing = out.get(key)
    if (!existing || run.createdAt > existing.createdAt) {
      out.set(key, run)
    }
  }
  return out
}
