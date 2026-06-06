import type { AutoTrigger, TriggerConfig } from '../../../../../shared/automations-types'

// Why: the Run Now confirm modal must open whenever a manual run needs extra
// operator input — a Linear ticket, a picked project, OR a manual http-endpoint
// trigger whose live item seeds run.context.trigger.http.*. Without the manual-http
// case a manual-only http automation skips the picker and dispatches an empty
// payload (silent wrong run). Accepts the minimal shape shared by both Automation
// and the editor's ChainDraft.
export function automationNeedsRunNowPayload(input: {
  trigger?: TriggerConfig
  autoTriggers?: AutoTrigger[]
}): boolean {
  return (
    !!input.trigger?.acceptsLinearTicket ||
    !!input.trigger?.acceptsProjectSelection ||
    (input.autoTriggers?.some((t) => t.source === 'http-endpoint' && t.manualEnabled) ?? false)
  )
}
