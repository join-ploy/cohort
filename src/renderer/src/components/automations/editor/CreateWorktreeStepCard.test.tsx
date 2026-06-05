// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CreateWorktreeStepCard } from './CreateWorktreeStepCard'
import type { CreateWorktreeConfig, Step } from '../../../../../shared/automations-types'
import type { AvailableVariables } from '../../../lib/template-dry-run'

const EMPTY_AVAIL: AvailableVariables = { automation: {}, trigger: {}, steps: {} }

function makeStep(configOverrides: Partial<CreateWorktreeConfig> = {}): Step {
  return {
    id: 'cw-1',
    kind: 'create-worktree',
    config: {
      baseBranch: 'main',
      branchName: 'feature/x',
      displayName: 'My Display',
      linkLinearIssue: true,
      ...configOverrides
    },
    onFailure: 'halt',
    timeoutSeconds: 60
  }
}

function staticMarkup(
  step: Step,
  onConfigChange: (config: CreateWorktreeConfig) => void = () => {}
): string {
  return renderToStaticMarkup(
    <CreateWorktreeStepCard
      step={step}
      stepIndex={0}
      available={EMPTY_AVAIL}
      onIdChange={() => {}}
      onConfigChange={onConfigChange}
      onOnFailureChange={() => {}}
      onTimeoutChange={() => {}}
      onDelete={() => {}}
    />
  )
}

afterEach(() => {
  cleanup()
})

describe('CreateWorktreeStepCard', () => {
  const markup = staticMarkup(makeStep())

  it('renders the base branch input with the current value', () => {
    expect(markup).toMatch(/aria-label=["']Base branch["']/)
    expect(markup).toMatch(/value=["']main["']/)
  })

  it('renders the branch name input with the current value', () => {
    expect(markup).toMatch(/aria-label=["']Branch name["']/)
    expect(markup).toMatch(/value=["']feature\/x["']/)
  })

  it('renders the display name input with the current value', () => {
    expect(markup).toMatch(/aria-label=["']Display name["']/)
    expect(markup).toMatch(/value=["']My Display["']/)
  })

  it('renders the Link Linear issue checkbox in its current state', () => {
    expect(markup).toMatch(/aria-label=["']Link Linear issue["'][^>]*checked/)
    expect(markup).toContain('Link Linear issue')
  })

  it('renders the kind badge from StepCardChrome', () => {
    expect(markup).toContain('Create worktree')
  })

  it('new-branch mode (default) shows baseBranch/branchName and the Linear-link checkbox', () => {
    // mode is undefined here, which must behave exactly like 'new-branch'.
    expect(markup).toMatch(/aria-label=["']Base branch["']/)
    expect(markup).toMatch(/aria-label=["']Branch name["']/)
    expect(markup).toMatch(/aria-label=["']Link Linear issue["']/)
    expect(markup).not.toMatch(/aria-label=["']Pull request["']/)
  })

  it('pull-request mode shows the pullRequestRef field and hides baseBranch/branchName and the Linear-link checkbox', () => {
    const prMarkup = staticMarkup(
      makeStep({ mode: 'pull-request', pullRequestRef: '{{trigger.github.pr.number}}' })
    )
    expect(prMarkup).toMatch(/aria-label=["']Pull request["']/)
    expect(prMarkup).toContain('trigger.github.pr.number')
    // displayName is still used as the worktree label in PR mode.
    expect(prMarkup).toMatch(/aria-label=["']Display name["']/)
    expect(prMarkup).not.toMatch(/aria-label=["']Base branch["']/)
    expect(prMarkup).not.toMatch(/aria-label=["']Branch name["']/)
    expect(prMarkup).not.toMatch(/aria-label=["']Link Linear issue["']/)
  })

  it('marks the active mode as pressed in the segmented control', () => {
    expect(markup).toMatch(/aria-label=["']Worktree source["']/)
    // Default (undefined) renders as New branch pressed.
    expect(markup).toMatch(/aria-pressed=["']true["'][^>]*>New branch/)
    expect(markup).toMatch(/aria-pressed=["']false["'][^>]*>From pull request/)
  })

  it("selecting From pull request updates config.mode to 'pull-request'", () => {
    const onConfigChange = vi.fn()
    render(
      <CreateWorktreeStepCard
        step={makeStep()}
        stepIndex={0}
        available={EMPTY_AVAIL}
        onIdChange={() => {}}
        onConfigChange={onConfigChange}
        onOnFailureChange={() => {}}
        onTimeoutChange={() => {}}
        onDelete={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'From pull request' }))
    expect(onConfigChange).toHaveBeenCalledTimes(1)
    const next = onConfigChange.mock.calls[0][0] as CreateWorktreeConfig
    expect(next.mode).toBe('pull-request')
  })

  it('updates pullRequestRef via onConfigChange when the field is edited', () => {
    const onConfigChange = vi.fn()
    render(
      <CreateWorktreeStepCard
        step={makeStep({ mode: 'pull-request', pullRequestRef: '' })}
        stepIndex={0}
        available={EMPTY_AVAIL}
        onIdChange={() => {}}
        onConfigChange={onConfigChange}
        onOnFailureChange={() => {}}
        onTimeoutChange={() => {}}
        onDelete={() => {}}
      />
    )
    const input = screen.getByLabelText('Pull request') as HTMLInputElement
    fireEvent.change(input, { target: { value: '42' } })
    expect(onConfigChange).toHaveBeenCalledTimes(1)
    const next = onConfigChange.mock.calls[0][0] as CreateWorktreeConfig
    expect(next.pullRequestRef).toBe('42')
  })
})
