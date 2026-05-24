import { randomUUID } from 'crypto'
import type {
  Automation,
  Step,
  RunPromptConfig,
  CreateWorktreeConfig,
  CreateWorkspaceGroupConfig
} from '../shared/automations-types'

// Why: legacy automations stored before the chain-engine refactor have rrule/prompt
// but no trigger/steps. Upgrade on read (non-destructive) so the engine sees the
// new shape without forcing a disk migration; first save back rewrites in new shape.
export function upgradeLegacyAutomation(automation: Automation): Automation {
  if (automation.trigger && automation.steps) {
    return automation
  }

  if (automation.workspaceMode === 'new_per_run') {
    // Why (grouped-workspaces L3): when the operator picked a `group` target,
    // a per-run workspace creation must produce a WorkspaceGroup spanning every
    // member repo — not a single worktree. Emit a `create-workspace-group`
    // step instead so the run-prompt step downstream addresses the group via
    // `{{steps.<id>.groupId}}` and the chain executor's group-aware CWD
    // override (run-prompt-runner) launches the agent at the shared parent.
    if (automation.target?.kind === 'group') {
      const createGroupId = randomUUID()
      const promptId = randomUUID()
      const groupConfig: CreateWorkspaceGroupConfig = {
        // Why: branchName doubles as workspaceName + parent folder name in the
        // IPC handler. Use the automation name as the default; the operator
        // can edit after migration. Display name matches so the group card has
        // a readable label without a second template entry.
        branchName: automation.name,
        displayName: automation.name,
        linkLinearIssue: false,
        members: automation.target.projectIds.map((repoId) => ({
          repoId,
          baseBranch: automation.baseBranch ?? 'main'
        }))
      }
      const promptConfig: RunPromptConfig = {
        // Why: the run-prompt step targets the freshly-created group. The
        // runner branches on `group:` prefix to set the agent's CWD to the
        // group's parentPath (so `pwd` shows the shared workspace folder).
        worktreeRef: `{{steps.${createGroupId}.groupId}}`,
        agentId: automation.agentId,
        prompt: automation.prompt,
        doneDebounceSeconds: 15
      }
      return {
        ...automation,
        trigger: { kind: 'manual' },
        steps: [
          {
            id: createGroupId,
            kind: 'create-workspace-group',
            config: groupConfig,
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
