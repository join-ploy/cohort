import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { Automation, AutomationCreateInput } from '../../../../shared/automations-types'

export type AutomationsSlice = {
  /** Duplicate an existing automation. Returns the new (server-assigned) row.
   *  Throws if the source can't be located. */
  duplicateAutomation: (id: string) => Promise<Automation>
}

/**
 * Build the create-input payload for a duplicated automation. Pure helper so
 * the cloning rules (new name, disabled by default, reset transient fields,
 * preserve everything else) are testable without IPC.
 *
 * Why: id is minted server-side by `automations:create`, so we don't carry
 * `id`, `nextRunAt`, `lastRunAt`, `createdAt`, or `updatedAt` here — the store
 * stamps the new row's timestamps on create.
 */
export function buildDuplicateAutomationInput(source: Automation): AutomationCreateInput {
  return {
    name: `${source.name} (copy)`,
    prompt: source.prompt,
    agentId: source.agentId,
    projectId: source.projectId,
    ...(source.target ? { target: source.target } : {}),
    workspaceMode: source.workspaceMode,
    workspaceId: source.workspaceId,
    baseBranch: source.baseBranch,
    timezone: source.timezone,
    rrule: source.rrule,
    dtstart: source.dtstart,
    // Why: a freshly duplicated automation defaults to disabled so it doesn't
    // immediately race the original on its existing schedule / auto-triggers.
    enabled: false,
    missedRunGraceMinutes: source.missedRunGraceMinutes,
    ...(source.trigger ? { trigger: source.trigger } : {}),
    ...(source.steps ? { steps: source.steps } : {}),
    ...(source.autoTriggers ? { autoTriggers: source.autoTriggers } : {})
  }
}

export const createAutomationsSlice: StateCreator<AppState, [], [], AutomationsSlice> = () => ({
  duplicateAutomation: async (id: string): Promise<Automation> => {
    const list = await window.api.automations.list()
    const source = list.find((entry) => entry.id === id)
    if (!source) {
      throw new Error(`Automation ${id} not found.`)
    }
    return window.api.automations.create(buildDuplicateAutomationInput(source))
  }
})
