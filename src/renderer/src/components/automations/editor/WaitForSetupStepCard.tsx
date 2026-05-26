import * as React from 'react'
import type { Step, StepConfig, WaitForSetupConfig } from '../../../../../shared/automations-types'
import type { AvailableVariables } from '../../../lib/template-dry-run'
import { TemplateInput } from './TemplateInput'
import { StepCardChrome } from './StepCardChrome'

export type WaitForSetupStepCardProps = {
  step: Step
  stepIndex: number
  available: AvailableVariables
  disableDrag?: boolean
  onIdChange: (newId: string) => void
  onConfigChange: (config: WaitForSetupConfig) => void
  onOnFailureChange: (val: 'halt' | 'continue') => void
  onTimeoutChange: (val: number | null) => void
  onDelete: () => void
}

/**
 * Body for a `wait-for-setup` step. The worktreeRef field is almost always a
 * template referencing a prior create-worktree step's output, so it uses
 * TemplateInput. `requireSuccess` is a binary toggle — native checkbox to
 * stay consistent with CreateWorktreeStepCard.
 */
export function WaitForSetupStepCard(props: WaitForSetupStepCardProps): React.JSX.Element {
  const config = props.step.config as WaitForSetupConfig
  const update = (patch: Partial<WaitForSetupConfig>): void => {
    props.onConfigChange({ ...config, ...patch })
  }

  return (
    <StepCardChrome
      step={props.step}
      stepIndex={props.stepIndex}
      available={props.available}
      disableDrag={props.disableDrag}
      onIdChange={props.onIdChange}
      onConfigChange={props.onConfigChange as (config: StepConfig) => void}
      onOnFailureChange={props.onOnFailureChange}
      onTimeoutChange={props.onTimeoutChange}
      onDelete={props.onDelete}
    >
      <TemplateInput
        value={config.worktreeRef}
        onChange={(v) => update({ worktreeRef: v })}
        placeholder="{{steps.<id>.worktreeId}}"
        available={props.available}
        ariaLabel="Worktree ref"
      />
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          aria-label="Require success"
          checked={config.requireSuccess}
          onChange={(e) => update({ requireSuccess: e.target.checked })}
        />
        Require success
      </label>
    </StepCardChrome>
  )
}
