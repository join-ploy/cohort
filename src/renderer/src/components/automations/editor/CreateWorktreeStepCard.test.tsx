import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import { CreateWorktreeStepCard } from './CreateWorktreeStepCard'
import type { Step } from '../../../../../shared/automations-types'
import type { AvailableVariables } from '../../../lib/template-dry-run'

const EMPTY_AVAIL: AvailableVariables = { automation: {}, trigger: {}, steps: {} }

function makeStep(): Step {
  return {
    id: 'cw-1',
    kind: 'create-worktree',
    config: {
      baseBranch: 'main',
      branchName: 'feature/x',
      displayName: 'My Display',
      linkLinearIssue: true
    },
    onFailure: 'halt',
    timeoutSeconds: 60
  }
}

describe('CreateWorktreeStepCard', () => {
  const markup = renderToStaticMarkup(
    <CreateWorktreeStepCard
      step={makeStep()}
      stepIndex={0}
      available={EMPTY_AVAIL}
      onIdChange={() => {}}
      onConfigChange={() => {}}
      onOnFailureChange={() => {}}
      onTimeoutChange={() => {}}
      onDelete={() => {}}
    />
  )

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
})
