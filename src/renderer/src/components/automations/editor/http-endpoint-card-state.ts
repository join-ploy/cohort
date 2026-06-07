import { type AutoTrigger, type HttpEndpointConfig } from '../../../../../shared/automations-types'

// Why: every reducer is a no-op on a trigger with no http config so a stray
// call can't corrupt a linear/github trigger. Returns the same reference when
// there's nothing to do.
function withHttp(
  trigger: AutoTrigger,
  update: (http: HttpEndpointConfig) => HttpEndpointConfig
): AutoTrigger {
  if (!trigger.http) {
    return trigger
  }
  return { ...trigger, http: update(trigger.http) }
}

// --- Poll + manual settings ------------------------------------------------

export function setDedupeFields(trigger: AutoTrigger, dedupeFields: string[]): AutoTrigger {
  return withHttp(trigger, (http) => ({ ...http, dedupeFields }))
}

export function setDateGateField(trigger: AutoTrigger, dateGateField: string | null): AutoTrigger {
  return withHttp(trigger, (http) => ({ ...http, dateGateField }))
}

export function setIntervalMs(trigger: AutoTrigger, intervalMs: number | undefined): AutoTrigger {
  return withHttp(trigger, (http) => ({ ...http, intervalMs }))
}

export function setLabelField(trigger: AutoTrigger, labelField: string | undefined): AutoTrigger {
  return withHttp(trigger, (http) => ({ ...http, labelField }))
}

export function setSubtitleField(
  trigger: AutoTrigger,
  subtitleField: string | undefined
): AutoTrigger {
  return withHttp(trigger, (http) => ({ ...http, subtitleField }))
}

// --- Capability toggles ----------------------------------------------------

export function setPollingEnabled(trigger: AutoTrigger, value: boolean): AutoTrigger {
  if (!trigger.http) {
    return trigger
  }
  // Why: `enabled` is the engine's master switch — derive it from the two
  // capability toggles so turning both off also disables the trigger.
  return { ...trigger, pollingEnabled: value, enabled: value || (trigger.manualEnabled ?? false) }
}

export function setManualEnabled(trigger: AutoTrigger, value: boolean): AutoTrigger {
  if (!trigger.http) {
    return trigger
  }
  return { ...trigger, manualEnabled: value, enabled: value || (trigger.pollingEnabled ?? false) }
}
