import * as React from 'react'
import { cn } from '@/lib/utils'
import type { RunPromptConfig, Step, StepConfig } from '../../../../../shared/automations-types'
import type { TuiAgent } from '../../../../../shared/types'
import type { AvailableVariables } from '../../../lib/template-dry-run'
import { TemplateInput } from './TemplateInput'
import { StepCardChrome } from './StepCardChrome'

export type RunPromptStepCardProps = {
  step: Step
  stepIndex: number
  available: AvailableVariables
  disableDrag?: boolean
  onIdChange: (newId: string) => void
  onConfigChange: (config: RunPromptConfig) => void
  onOnFailureChange: (val: 'halt' | 'continue') => void
  onTimeoutChange: (val: number | null) => void
  onDelete: () => void
}

const AGENT_CHOICES: { value: TuiAgent; label: string }[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'droid', label: 'Droid' }
]

/**
 * Body for a `run-prompt` step. Uses a native <select> for the agent picker
 * — the shadcn Select primitive renders via Radix Portal which doesn't show
 * up in renderToStaticMarkup-based tests, and we already use native <input>
 * elsewhere in the editor.
 */
export function RunPromptStepCard(props: RunPromptStepCardProps): React.JSX.Element {
  const config = props.step.config as RunPromptConfig
  const update = (patch: Partial<RunPromptConfig>): void => {
    props.onConfigChange({ ...config, ...patch })
  }
  // Why: when the user supplies a paneRef, the chain executor reuses the
  // existing pane's agent rather than the configured one — surface that with
  // a dim treatment + note so it's clear the agentId select is inert.
  const paneRef = config.paneRef ?? ''
  const agentDimmed = paneRef.length > 0

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
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Reuse pane (optional)</span>
        <TemplateInput
          value={paneRef}
          onChange={(v) => update({ paneRef: v })}
          placeholder={`{{steps.${props.step.id}.paneKey}}`}
          available={props.available}
          ariaLabel="Pane ref"
        />
      </label>
      <label className={cn('flex items-center gap-2 text-xs', agentDimmed && 'opacity-50')}>
        <span className="text-muted-foreground">Agent</span>
        <select
          aria-label="Agent"
          value={config.agentId}
          onChange={(e) => update({ agentId: e.target.value as TuiAgent })}
          className="rounded-md border border-input bg-background px-2 py-1 text-xs outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50"
        >
          {AGENT_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
        {agentDimmed ? (
          <span className="text-muted-foreground">Pane already has an agent.</span>
        ) : null}
      </label>
      <TemplateInput
        value={config.prompt}
        onChange={(v) => update({ prompt: v })}
        placeholder="Prompt"
        available={props.available}
        ariaLabel="Prompt"
        multiline
      />
      <label className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Done debounce (seconds)</span>
        <input
          type="number"
          aria-label="Done debounce seconds"
          min={1}
          value={config.doneDebounceSeconds}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10)
            update({ doneDebounceSeconds: Number.isFinite(n) && n > 0 ? n : 1 })
          }}
          className="w-20 rounded-md border border-input bg-background px-2 py-1 outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50"
        />
      </label>
    </StepCardChrome>
  )
}
