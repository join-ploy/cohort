import { randomUUID } from 'crypto'
import type {
  Automation,
  Step,
  RunPromptConfig,
  CreateWorktreeConfig
} from '../shared/automations-types'

// Why: legacy automations stored before the chain-engine refactor have rrule/prompt
// but no trigger/steps. Upgrade on read (non-destructive) so the engine sees the
// new shape without forcing a disk migration; first save back rewrites in new shape.
export function upgradeLegacyAutomation(automation: Automation): Automation {
  if (automation.trigger && automation.steps) {
    return automation
  }

  if (automation.workspaceMode === 'new_per_run') {
    const createWtId = randomUUID()
    const promptId = randomUUID()
    const createWtConfig: CreateWorktreeConfig = {
      baseBranch: automation.baseBranch ?? 'main',
      // Why: legacy automations had no explicit branchName/displayName; use the
      // automation name as a sensible default. Authors can edit after migration.
      branchName: automation.name,
      displayName: automation.name,
      // Why: legacy automations predate Linear linkage; default to false.
      linkLinearIssue: false
    }
    const promptConfig: RunPromptConfig = {
      // Why: downstream prompt step targets the worktree the previous step
      // created. Template path matches what CreateWorktreeRunner will emit.
      worktreeRef: `{{steps.${createWtId}.worktreeId}}`,
      agentId: automation.agentId,
      prompt: automation.prompt,
      doneDebounceSeconds: 15
    }
    return {
      ...automation,
      trigger: { kind: 'manual' },
      steps: [
        {
          id: createWtId,
          kind: 'create-worktree',
          config: createWtConfig,
          onFailure: 'halt',
          timeoutSeconds: null
        },
        {
          id: promptId,
          kind: 'run-prompt',
          config: promptConfig,
          onFailure: 'halt',
          timeoutSeconds: null
        }
      ]
    }
  }

  // workspaceMode === 'existing' — unchanged behavior from Phase 1
  const stepConfig: RunPromptConfig = {
    worktreeRef: automation.workspaceId ?? '{{automation.workspaceId}}',
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
