import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import { WaitForSetupStepCard } from './WaitForSetupStepCard'
import type { Step } from '../../../../../shared/automations-types'
import type { AvailableVariables } from '../../../lib/template-dry-run'

const EMPTY_AVAIL: AvailableVariables = { automation: {}, trigger: {}, steps: {} }

function makeStep(): Step {
  return {
    id: 'wfs-1',
    kind: 'wait-for-setup',
    config: {
      worktreeRef: '{{steps.cw-1.worktreeId}}',
      requireSuccess: true
    },
    onFailure: 'halt',
    timeoutSeconds: 120
  }
}

describe('WaitForSetupStepCard', () => {
  const markup = renderToStaticMarkup(
    <WaitForSetupStepCard
      step={makeStep()}
      stepIndex={1}
      available={EMPTY_AVAIL}
      onIdChange={() => {}}
      onConfigChange={() => {}}
      onOnFailureChange={() => {}}
      onTimeoutChange={() => {}}
      onDelete={() => {}}
    />
  )

  it('renders the worktree ref input with the current value', () => {
    expect(markup).toMatch(/aria-label=["']Worktree ref["']/)
    expect(markup).toContain('steps.cw-1.worktreeId')
  })

  it('renders the placeholder for worktree ref', () => {
    const empty = renderToStaticMarkup(
      <WaitForSetupStepCard
        step={{ ...makeStep(), config: { worktreeRef: '', requireSuccess: false } }}
        stepIndex={1}
        available={EMPTY_AVAIL}
        onIdChange={() => {}}
        onConfigChange={() => {}}
        onOnFailureChange={() => {}}
        onTimeoutChange={() => {}}
        onDelete={() => {}}
      />
    )
    expect(empty).toContain('steps.&lt;id&gt;.worktreeId')
  })

  it('renders the Require success checkbox in its current state', () => {
    expect(markup).toMatch(/aria-label=["']Require success["'][^>]*checked/)
    expect(markup).toContain('Require success')
  })

  it('renders the kind badge from StepCardChrome', () => {
    expect(markup).toContain('Wait for setup')
  })
})
