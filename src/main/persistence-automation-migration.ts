import { randomUUID } from 'crypto'
import type { Automation, Step, RunPromptConfig } from '../shared/automations-types'

// Why: legacy automations stored before the chain-engine refactor have rrule/prompt
// but no trigger/steps. Upgrade on read (non-destructive) so the engine sees the
// new shape without forcing a disk migration; first save back rewrites in new shape.
export function upgradeLegacyAutomation(automation: Automation): Automation {
  if (automation.trigger && automation.steps) {
    return automation
  }
  const stepConfig: RunPromptConfig = {
    worktreeRef:
      automation.workspaceMode === 'new_per_run'
        ? '{{automation.workspaceId}}'
        : (automation.workspaceId ?? '{{automation.workspaceId}}'),
    agentId: automation.agentId,
    prompt: automation.prompt,
    doneDebounceSeconds: 15
  }
  const step: Step = {
    id: randomUUID(),
    kind: 'run-prompt',
    config: stepConfig,
    onFailure: 'halt',
    timeoutSeconds: null
  }
  return {
    ...automation,
    trigger: { kind: 'manual' },
    steps: [step]
  }
}
