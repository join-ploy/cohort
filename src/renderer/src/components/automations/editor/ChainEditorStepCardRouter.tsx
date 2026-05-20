import * as React from 'react'
import type { Step, StepConfig } from '../../../../../shared/automations-types'
import type { SidebarPromptCommand } from '../../../../../shared/types'
import type { AvailableVariables } from '../../../lib/template-dry-run'
import { CreateWorktreeStepCard } from './CreateWorktreeStepCard'
import { WaitForSetupStepCard } from './WaitForSetupStepCard'
import { RunPromptStepCard } from './RunPromptStepCard'
import { RunCommandStepCard } from './RunCommandStepCard'

export type ChainEditorStepCardRouterProps = {
  step: Step
  index: number
  available: AvailableVariables
  reviewCommands: SidebarPromptCommand[]
  createPrCommands: SidebarPromptCommand[]
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
    onIdChange: props.onIdChange,
    onOnFailureChange: props.onOnFailureChange,
    onTimeoutChange: props.onTimeoutChange,
    onDelete: props.onDelete
  }
  switch (props.step.kind) {
    case 'create-worktree':
      return <CreateWorktreeStepCard {...common} onConfigChange={props.onConfigChange} />
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
  }
}
