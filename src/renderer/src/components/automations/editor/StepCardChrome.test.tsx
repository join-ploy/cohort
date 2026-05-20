import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import { StepCardChrome } from './StepCardChrome'
import type { Step } from '../../../../../shared/automations-types'
import type { AvailableVariables } from '../../../lib/template-dry-run'

const EMPTY_AVAIL: AvailableVariables = { automation: {}, trigger: {}, steps: {} }

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: 'cw-1',
    kind: 'create-worktree',
    config: {
      baseBranch: 'main',
      branchName: 'feature/x',
      displayName: 'Display',
      linkLinearIssue: false
    },
    onFailure: 'halt',
    timeoutSeconds: 60,
    ...overrides
  } as Step
}

describe('StepCardChrome', () => {
  it('renders the step ID in the inline editor', () => {
    const markup = renderToStaticMarkup(
      <StepCardChrome
        step={makeStep({ id: 'my-step' })}
        stepIndex={0}
        available={EMPTY_AVAIL}
        onIdChange={() => {}}
        onConfigChange={() => {}}
        onOnFailureChange={() => {}}
        onTimeoutChange={() => {}}
        onDelete={() => {}}
      >
        <div data-testid="child">child body</div>
      </StepCardChrome>
    )
    expect(markup).toMatch(/value=["']my-step["']/)
  })

  it('renders the kind badge label and icon', () => {
    const markup = renderToStaticMarkup(
      <StepCardChrome
        step={makeStep({
          kind: 'run-prompt',
          config: { worktreeRef: '', agentId: 'claude', prompt: '', doneDebounceSeconds: 5 }
        })}
        stepIndex={1}
        available={EMPTY_AVAIL}
        onIdChange={() => {}}
        onConfigChange={() => {}}
        onOnFailureChange={() => {}}
        onTimeoutChange={() => {}}
        onDelete={() => {}}
      >
        <div />
      </StepCardChrome>
    )
    expect(markup).toMatch(/Run prompt/)
  })

  it('renders the children body slot', () => {
    const markup = renderToStaticMarkup(
      <StepCardChrome
        step={makeStep()}
        stepIndex={0}
        available={EMPTY_AVAIL}
        onIdChange={() => {}}
        onConfigChange={() => {}}
        onOnFailureChange={() => {}}
        onTimeoutChange={() => {}}
        onDelete={() => {}}
      >
        <div>BODY_MARKER_TEXT</div>
      </StepCardChrome>
    )
    expect(markup).toContain('BODY_MARKER_TEXT')
  })

  it('highlights the active onFailure choice via aria-pressed', () => {
    const haltMarkup = renderToStaticMarkup(
      <StepCardChrome
        step={makeStep({ onFailure: 'halt' })}
        stepIndex={0}
        available={EMPTY_AVAIL}
        onIdChange={() => {}}
        onConfigChange={() => {}}
        onOnFailureChange={() => {}}
        onTimeoutChange={() => {}}
        onDelete={() => {}}
      >
        <div />
      </StepCardChrome>
    )
    // Halt is pressed, Continue is not.
    expect(haltMarkup).toMatch(/aria-pressed=["']true["'][^>]*>Halt/)
    expect(haltMarkup).toMatch(/aria-pressed=["']false["'][^>]*>Continue/)

    const continueMarkup = renderToStaticMarkup(
      <StepCardChrome
        step={makeStep({ onFailure: 'continue' })}
        stepIndex={0}
        available={EMPTY_AVAIL}
        onIdChange={() => {}}
        onConfigChange={() => {}}
        onOnFailureChange={() => {}}
        onTimeoutChange={() => {}}
        onDelete={() => {}}
      >
        <div />
      </StepCardChrome>
    )
    expect(continueMarkup).toMatch(/aria-pressed=["']true["'][^>]*>Continue/)
    expect(continueMarkup).toMatch(/aria-pressed=["']false["'][^>]*>Halt/)
  })

  it('renders the timeout input with the current value when timeoutSeconds is set', () => {
    const markup = renderToStaticMarkup(
      <StepCardChrome
        step={makeStep({ timeoutSeconds: 120 })}
        stepIndex={0}
        available={EMPTY_AVAIL}
        onIdChange={() => {}}
        onConfigChange={() => {}}
        onOnFailureChange={() => {}}
        onTimeoutChange={() => {}}
        onDelete={() => {}}
      >
        <div />
      </StepCardChrome>
    )
    expect(markup).toMatch(/value=["']120["']/)
  })

  it('shows the "No limit" checkbox checked when timeoutSeconds is null', () => {
    const markup = renderToStaticMarkup(
      <StepCardChrome
        step={makeStep({ timeoutSeconds: null })}
        stepIndex={0}
        available={EMPTY_AVAIL}
        onIdChange={() => {}}
        onConfigChange={() => {}}
        onOnFailureChange={() => {}}
        onTimeoutChange={() => {}}
        onDelete={() => {}}
      >
        <div />
      </StepCardChrome>
    )
    // The no-limit checkbox is the one with aria-label="No timeout".
    expect(markup).toMatch(/aria-label=["']No timeout["'][^>]*checked/)
  })
})
