import * as React from 'react'
import type { Step, StepConfig } from '../../../../../shared/automations-types'
import type { Repo, SidebarPromptCommand } from '../../../../../shared/types'
import type { AvailableVariables } from '../../../lib/template-dry-run'
import { CreateWorktreeStepCard } from './CreateWorktreeStepCard'
import { CreateWorkspaceGroupStepCard } from './CreateWorkspaceGroupStepCard'
import { WaitForSetupStepCard } from './WaitForSetupStepCard'
import { RunPromptStepCard } from './RunPromptStepCard'
import { RunCommandStepCard } from './RunCommandStepCard'
import { UpdateLinearIssueStepCard } from './UpdateLinearIssueStepCard'

export type ChainEditorStepCardRouterProps = {
  step: Step
  index: number
  available: AvailableVariables
  // Why: the create-workspace-group card surfaces the project's repos in a
  // multi-select; threaded through here so the modal stays the only owner of
  // the repos list.
  repos: Repo[]
  reviewCommands: SidebarPromptCommand[]
  createPrCommands: SidebarPromptCommand[]
  /** Forwarded to StepCardChrome — disables the sortable drag handle when the
   *  card lives inside a parallel group container that owns vertical drag. */
  disableDrag?: boolean
  onIdChange: (newId: string) => void
  onConfigChange: (config: StepConfig) => void
  onOnFailureChange: (val: 'halt' | 'continue') => void
  onTimeoutChange: (val: number | null) => void
  onDelete: () => void
}

/**
 * Routes a step to the per-kind card. Each step kind has its own card
 * component with kind-specific config types; this wrapper picks the right
 * one based on `step.kind` so the modal body stays kind-agnostic.
 */
export function ChainEditorStepCardRouter(
  props: ChainEditorStepCardRouterProps
): React.JSX.Element {
  const common = {
    step: props.step,
    stepIndex: props.index,
    available: props.available,
    disableDrag: props.disableDrag,
    onIdChange: props.onIdChange,
    onOnFailureChange: props.onOnFailureChange,
    onTimeoutChange: props.onTimeoutChange,
    onDelete: props.onDelete
  }
  switch (props.step.kind) {
    case 'create-worktree':
      return <CreateWorktreeStepCard {...common} onConfigChange={props.onConfigChange} />
    case 'create-workspace-group':
      return (
        <CreateWorkspaceGroupStepCard
          {...common}
          repos={props.repos}
          onConfigChange={props.onConfigChange}
        />
      )
    case 'wait-for-setup':
      return <WaitForSetupStepCard {...common} onConfigChange={props.onConfigChange} />
    case 'run-prompt':
      return <RunPromptStepCard {...common} onConfigChange={props.onConfigChange} />
    case 'run-command':
      return (
        <RunCommandStepCard
          {...common}
          reviewCommands={props.reviewCommands}
          createPrCommands={props.createPrCommands}
          onConfigChange={props.onConfigChange}
        />
      )
    case 'update-linear-issue':
      return <UpdateLinearIssueStepCard {...common} onConfigChange={props.onConfigChange} />
  }
}
