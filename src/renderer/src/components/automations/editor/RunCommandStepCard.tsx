import * as React from 'react'
import { cn } from '@/lib/utils'
import type { RunCommandConfig, Step, StepConfig } from '../../../../../shared/automations-types'
import type { SidebarPromptCommand } from '../../../../../shared/types'
import type { AvailableVariables } from '../../../lib/template-dry-run'
import { TemplateInput } from './TemplateInput'
import { StepCardChrome } from './StepCardChrome'

export type RunCommandStepCardProps = {
  step: Step
  stepIndex: number
  available: AvailableVariables
  /** User-configured Review dropdown commands. Provided by the parent so this
   *  card stays decoupled from the app store and renders in tests without
   *  needing a Zustand provider. */
  reviewCommands: SidebarPromptCommand[]
  /** User-configured Create PR dropdown commands. */
  createPrCommands: SidebarPromptCommand[]
  onIdChange: (newId: string) => void
  onConfigChange: (config: RunCommandConfig) => void
  onOnFailureChange: (val: 'halt' | 'continue') => void
  onTimeoutChange: (val: number | null) => void
  onDelete: () => void
}

type SourceChoice = { value: RunCommandConfig['source']; label: string }
const SOURCE_CHOICES: SourceChoice[] = [
  { value: 'review', label: 'Review' },
  { value: 'create-pr', label: 'Create PR' },
  { value: 'custom', label: 'Custom' }
]

/**
 * Body for a `run-command` step. The source segmented control switches the
 * trailing input between a `commandId` select (sourced from the user's
 * Review / Create PR dropdown settings) and a free-form `customCommand`
 * template input. When switching source we clear the opposite field so the
 * persisted config never carries dead state.
 */
export function RunCommandStepCard(props: RunCommandStepCardProps): React.JSX.Element {
  const config = props.step.config as RunCommandConfig
  const update = (patch: Partial<RunCommandConfig>): void => {
    props.onConfigChange({ ...config, ...patch })
  }

  const changeSource = (source: RunCommandConfig['source']): void => {
    if (source === config.source) {
      return
    }
    if (source === 'custom') {
      update({ source, commandId: undefined })
    } else {
      update({ source, customCommand: undefined, commandId: undefined })
    }
  }

  const commandOptions: SidebarPromptCommand[] =
    config.source === 'review'
      ? props.reviewCommands
      : config.source === 'create-pr'
        ? props.createPrCommands
        : []

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
        value={config.worktreeRef}
        onChange={(v) => update({ worktreeRef: v })}
        placeholder="{{steps.<id>.worktreeId}}"
        available={props.available}
        ariaLabel="Worktree ref"
      />

      <div
        role="group"
        aria-label="Command source"
        className="inline-flex overflow-hidden rounded-md border border-input"
      >
        {SOURCE_CHOICES.map((choice, i) => (
          <button
            key={choice.value}
            type="button"
            aria-pressed={config.source === choice.value}
            onClick={() => changeSource(choice.value)}
            className={cn(
              'px-2 py-1 text-xs',
              i > 0 && 'border-l border-input',
              config.source === choice.value
                ? 'bg-accent text-foreground'
                : 'bg-background text-muted-foreground hover:text-foreground'
            )}
          >
            {choice.label}
          </button>
        ))}
      </div>

      {config.source === 'custom' ? (
        <TemplateInput
          value={config.customCommand ?? ''}
          onChange={(v) => update({ customCommand: v })}
          placeholder="Custom command"
          available={props.available}
          ariaLabel="Custom command"
        />
      ) : (
        <label className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Command</span>
          <select
            aria-label="Command"
            value={config.commandId ?? ''}
            onChange={(e) => update({ commandId: e.target.value || undefined })}
            className="rounded-md border border-input bg-background px-2 py-1 text-xs outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50"
          >
            <option value="">(none)</option>
            {commandOptions.map((cmd) => (
              <option key={cmd.id} value={cmd.id}>
                {cmd.label}
              </option>
            ))}
          </select>
        </label>
      )}
    </StepCardChrome>
  )
}
