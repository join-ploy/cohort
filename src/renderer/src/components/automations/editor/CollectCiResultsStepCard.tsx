import * as React from 'react'
import type {
  Step,
  StepConfig,
  CollectCiResultsConfig
} from '../../../../../shared/automations-types'
import type { AvailableVariables } from '../../../lib/template-dry-run'
import { TemplateInput } from './TemplateInput'
import { StepCardChrome } from './StepCardChrome'

export type CollectCiResultsStepCardProps = {
  step: Step
  stepIndex: number
  available: AvailableVariables
  disableDrag?: boolean
  onIdChange: (newId: string) => void
  onConfigChange: (config: CollectCiResultsConfig) => void
  onOnFailureChange: (val: 'halt' | 'continue') => void
  onTimeoutChange: (val: number | null) => void
  onDelete: () => void
}

export function CollectCiResultsStepCard(props: CollectCiResultsStepCardProps): React.JSX.Element {
  const config = props.step.config as CollectCiResultsConfig
  const update = (patch: Partial<CollectCiResultsConfig>): void => {
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
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Poll interval (s)
          <input
            type="number"
            min={10}
            max={300}
            value={config.pollIntervalSeconds ?? 30}
            onChange={(e) => update({ pollIntervalSeconds: Number(e.target.value) || 30 })}
            className="w-16 rounded border border-border bg-background px-2 py-1 text-xs"
            aria-label="Poll interval seconds"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            aria-label="Include comments"
            checked={config.includeComments ?? true}
            onChange={(e) => update({ includeComments: e.target.checked })}
          />
          Include comments
        </label>
      </div>
    </StepCardChrome>
  )
}
