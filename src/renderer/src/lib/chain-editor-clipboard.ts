import type { HttpRequestStepConfig, Step, StepKind } from '../../../shared/automations-types'

// Tagged envelope so paste can distinguish an Orca node from arbitrary clipboard
// text. Bump the version if the persisted Step shape changes incompatibly.
const STEP_CLIPBOARD_KIND = 'orca/automation-step'
const STEP_CLIPBOARD_VERSION = 1

// A Record<StepKind, true> rather than a bare array so the compiler flags this
// list the moment a StepKind is added or removed — keeping the runtime guard in
// sync with the type.
const KNOWN_STEP_KINDS: Record<StepKind, true> = {
  'run-prompt': true,
  'create-worktree': true,
  'create-workspace-group': true,
  'wait-for-setup': true,
  'run-command': true,
  'update-linear-issue': true,
  'collect-ci-results': true,
  'http-request': true
}

/**
 * Returns a deep copy of `step` with every secret value blanked. Only
 * http-request configs carry secrets; the renderer never holds a real secret
 * (it sees the mask sentinel), so clearing here guarantees nothing secret —
 * real or masked — is ever written to the OS clipboard. Non-secret fields
 * (connectionId, sampleResponse, fields, …) are preserved verbatim.
 */
export function clearStepSecrets(step: Step): Step {
  const copy = structuredClone(step)
  if (copy.kind === 'http-request') {
    const config = copy.config as HttpRequestStepConfig
    for (const header of config.request.headers) {
      if (header.secret) {
        header.value = ''
      }
    }
    for (const param of config.request.query) {
      if (param.secret) {
        param.value = ''
      }
    }
    if (config.request.bodySecret) {
      config.request.body = ''
    }
  }
  return copy
}

/** Serializes a step (secrets cleared) into the clipboard envelope JSON. */
export function serializeStepForClipboard(step: Step): string {
  return JSON.stringify({
    kind: STEP_CLIPBOARD_KIND,
    version: STEP_CLIPBOARD_VERSION,
    step: clearStepSecrets(step)
  })
}

/**
 * Parses clipboard text back into a Step, or null when the text isn't an Orca
 * node (non-JSON, wrong envelope, unknown kind, or a malformed step). The step
 * is returned verbatim — deeper config validation is left to the editor's
 * existing computeAllErrors, so a pasted node with issues surfaces them the
 * same way any other edit does.
 */
export function parseStepFromClipboard(text: string): Step | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(data)) {
    return null
  }
  if (data.kind !== STEP_CLIPBOARD_KIND || data.version !== STEP_CLIPBOARD_VERSION) {
    return null
  }
  return isValidStep(data.step) ? data.step : null
}

function isValidStep(value: unknown): value is Step {
  if (!isRecord(value)) {
    return false
  }
  if (typeof value.id !== 'string' || value.id.length === 0) {
    return false
  }
  if (typeof value.kind !== 'string' || !isKnownStepKind(value.kind)) {
    return false
  }
  if (!isRecord(value.config)) {
    return false
  }
  if (value.onFailure !== 'halt' && value.onFailure !== 'continue') {
    return false
  }
  if (value.timeoutSeconds !== null && typeof value.timeoutSeconds !== 'number') {
    return false
  }
  return true
}

function isKnownStepKind(kind: string): kind is StepKind {
  return Object.prototype.hasOwnProperty.call(KNOWN_STEP_KINDS, kind)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
