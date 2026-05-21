import * as React from 'react'
import type {
  CreateWorktreeConfig,
  Step,
  StepConfig
} from '../../../../../shared/automations-types'
import type { AvailableVariables } from '../../../lib/template-dry-run'
import { TemplateInput } from './TemplateInput'
import { StepCardChrome } from './StepCardChrome'

export type CreateWorktreeStepCardProps = {
  step: Step
  stepIndex: number
  available: AvailableVariables
  onIdChange: (newId: string) => void
  onConfigChange: (config: CreateWorktreeConfig) => void
  onOnFailureChange: (val: 'halt' | 'continue') => void
  onTimeoutChange: (val: number | null) => void
  onDelete: () => void
}

/**
 * Body for a `create-worktree` step. All three string fields are template
 * inputs so users can reference earlier outputs (`{{steps.foo.x}}`) inside
 * branch/display names. Linear-link is a plain checkbox; shadcn's Switch
 * primitive isn't available in this build, so we use a native input.
 */
export function CreateWorktreeStepCard(props: CreateWorktreeStepCardProps): React.JSX.Element {
  const config = props.step.config as CreateWorktreeConfig
  const update = (patch: Partial<CreateWorktreeConfig>): void => {
    props.onConfigChange({ ...config, ...patch })
  }

  return (
    <StepCardChrome
      step={props.step}
      stepIndex={props.stepIndex}
      available={props.available}
      onIdChange={props.onIdChange}
      onConfigChange={props.onConfigChange as (config: StepConfig) => void}
      onOnFailureChange={props.onOnFailureChange}
      onTimeoutChange={props.onTimeoutChange}
      onDelete={props.onDelete}
    >
      <TemplateInput
        value={config.baseBranch}
        onChange={(v) => update({ baseBranch: v })}
        placeholder="Base branch (e.g., main)"
        available={props.available}
        ariaLabel="Base branch"
      />
      <TemplateInput
        value={config.branchName}
        onChange={(v) => update({ branchName: v })}
        placeholder="Branch name (leave blank to auto-generate)"
        available={props.available}
        ariaLabel="Branch name"
      />
      <TemplateInput
        value={config.displayName}
        onChange={(v) => update({ displayName: v })}
        placeholder="Display name (leave blank to auto-generate)"
        available={props.available}
        ariaLabel="Display name"
      />
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          aria-label="Link Linear issue"
          checked={config.linkLinearIssue}
          onChange={(e) => update({ linkLinearIssue: e.target.checked })}
        />
        Link Linear issue
      </label>
    </StepCardChrome>
  )
}
