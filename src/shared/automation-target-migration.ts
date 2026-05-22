import type { Automation, AutomationTarget } from './automations-types'

/** Read-time normalizer: legacy automations have `projectId` only and no
 *  `target`. Inflate them into `{ kind: 'single', projectId }` so downstream
 *  code can branch on `target.kind` uniformly. Idempotent: if target is
 *  already set, return as-is. */
export function normalizeAutomationTarget(automation: Automation): AutomationTarget {
  if (automation.target) {
    return automation.target
  }
  return { kind: 'single', projectId: automation.projectId }
}
