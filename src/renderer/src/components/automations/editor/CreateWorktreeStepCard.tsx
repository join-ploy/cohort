import * as React from 'react'
import { cn } from '@/lib/utils'
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
  disableDrag?: boolean
  onIdChange: (newId: string) => void
  onConfigChange: (config: CreateWorktreeConfig) => void
  onOnFailureChange: (val: 'halt' | 'continue') => void
  onTimeoutChange: (val: number | null) => void
  onDelete: () => void
}

type ModeChoice = { value: NonNullable<CreateWorktreeConfig['mode']>; label: string }
const MODE_CHOICES: ModeChoice[] = [
  { value: 'new-branch', label: 'New branch' },
  { value: 'pull-request', label: 'From pull request' }
]

/**
 * Body for a `create-worktree` step. All string fields are template inputs so
 * users can reference earlier outputs (`{{steps.foo.x}}`) inside their values.
 *
 * The mode segmented control switches between two layouts:
 *  - 'new-branch' (default; undefined persisted rows fall here): creates a
 *    fresh branch, so baseBranch/branchName and the Linear-link checkbox show.
 *  - 'pull-request': checks out an existing PR, so only the display label and a
 *    `pullRequestRef` template input show. The Linear-link checkbox is hidden
 *    because a PR-triggered worktree links the PR, not a Linear issue — leaving
 *    it would be a no-op control (flagged in runner code review).
 *
 * Linear-link is a plain checkbox; shadcn's Switch primitive isn't available in
 * this build, so we use a native input.
 */
export function CreateWorktreeStepCard(props: CreateWorktreeStepCardProps): React.JSX.Element {
  const config = props.step.config as CreateWorktreeConfig
  const update = (patch: Partial<CreateWorktreeConfig>): void => {
    props.onConfigChange({ ...config, ...patch })
  }

  // Undefined mode is legacy 'new-branch'; treat it as such everywhere.
  const mode = config.mode ?? 'new-branch'

  const changeMode = (next: NonNullable<CreateWorktreeConfig['mode']>): void => {
    if (next === mode) {
      return
    }
    // Leave the opposite mode's fields untouched so toggling back-and-forth
    // never wipes user data; the runner only reads the fields its mode needs.
    update({ mode: next })
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
      <div
        role="group"
        aria-label="Worktree source"
        className="inline-flex overflow-hidden rounded-md border border-input"
      >
        {MODE_CHOICES.map((choice, i) => (
          <button
            key={choice.value}
            type="button"
            aria-pressed={mode === choice.value}
            onClick={() => changeMode(choice.value)}
            className={cn(
              'px-2 py-1 text-xs',
              i > 0 && 'border-l border-input',
              mode === choice.value
                ? 'bg-accent text-foreground'
                : 'bg-background text-muted-foreground hover:text-foreground'
            )}
          >
            {choice.label}
          </button>
        ))}
      </div>

      {mode === 'new-branch' ? (
        <>
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
        </>
      ) : (
        <TemplateInput
          value={config.pullRequestRef ?? ''}
          onChange={(v) => update({ pullRequestRef: v })}
          placeholder="Pull request (e.g., {{trigger.github.pr.number}})"
          available={props.available}
          ariaLabel="Pull request"
        />
      )}

      <TemplateInput
        value={config.displayName}
        onChange={(v) => update({ displayName: v })}
        placeholder="Display name (leave blank to auto-generate)"
        available={props.available}
        ariaLabel="Display name"
      />

      {mode === 'new-branch' ? (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            aria-label="Link Linear issue"
            checked={config.linkLinearIssue}
            onChange={(e) => update({ linkLinearIssue: e.target.checked })}
          />
          Link Linear issue
        </label>
      ) : null}
    </StepCardChrome>
  )
}
