import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { AutomationRun, AutomationRunStatus } from '../../../../shared/automations-types'

const ACTIVE_STATUSES: ReadonlySet<AutomationRunStatus> = new Set([
  'pending',
  'dispatching',
  'dispatched',
  'running'
])

export function isAutomationRunActive(status: AutomationRunStatus): boolean {
  return ACTIVE_STATUSES.has(status)
}

export type AutomationRunsSlice = {
  automationRunsById: Record<string, AutomationRun>
  /** True once the initial listRuns() has returned, even if the response was
   *  empty. Lets consumers distinguish "no runs yet" from "still hydrating". */
  automationRunsHydrated: boolean
  fetchAutomationRuns: () => Promise<void>
}

export const createAutomationRunsSlice: StateCreator<AppState, [], [], AutomationRunsSlice> = (
  set
) => ({
  automationRunsById: {},
  automationRunsHydrated: false,
  fetchAutomationRuns: async () => {
    try {
      const runs = await window.api.automations.listRuns()
      const next: Record<string, AutomationRun> = {}
      for (const run of runs) {
        next[run.id] = run
      }
      set({ automationRunsById: next, automationRunsHydrated: true })
    } catch {
      // Why: this slice powers a passive sidebar indicator — a fetch failure
      // is non-fatal. Mark hydrated so consumers don't spin forever; the
      // automations:changed listener will retry on the next broadcast.
      set({ automationRunsHydrated: true })
    }
  }
})
