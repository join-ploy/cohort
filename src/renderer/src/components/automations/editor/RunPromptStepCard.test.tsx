import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import { RunPromptStepCard } from './RunPromptStepCard'
import type { Step } from '../../../../../shared/automations-types'
import type { AvailableVariables } from '../../../lib/template-dry-run'

const EMPTY_AVAIL: AvailableVariables = { automation: {}, trigger: {}, steps: {} }

function makeStep(): Step {
  return {
    id: 'rp-1',
    kind: 'run-prompt',
    config: {
      worktreeRef: '{{steps.cw-1.worktreeId}}',
      agentId: 'codex',
      prompt: 'do the thing',
      doneDebounceSeconds: 7
    },
    onFailure: 'continue',
    timeoutSeconds: null
  }
}

describe('RunPromptStepCard', () => {
  const markup = renderToStaticMarkup(
    <RunPromptStepCard
      step={makeStep()}
      stepIndex={2}
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

  it('renders the agent select with Claude, Codex, and Droid options', () => {
    expect(markup).toMatch(/aria-label=["']Agent["']/)
    expect(markup).toContain('Claude')
    expect(markup).toContain('Codex')
    expect(markup).toContain('Droid')
  })

  it('marks the current agent option as selected', () => {
    // React renders <select value=...> by emitting `selected` on the matching <option>.
    expect(markup).toMatch(/value=["']codex["'][^>]*selected/)
  })

  it('renders the prompt textarea (multiline) with the current value', () => {
    expect(markup).toMatch(/aria-label=["']Prompt["']/)
    expect(markup).toMatch(/<textarea[^>]*aria-label=["']Prompt["']/)
    expect(markup).toContain('do the thing')
  })

  it('renders the done-debounce number input with the current value', () => {
    expect(markup).toMatch(/aria-label=["']Done debounce seconds["']/)
    expect(markup).toMatch(/value=["']7["']/)
    expect(markup).toContain('Done debounce (seconds)')
  })

  it('renders the kind badge from StepCardChrome', () => {
    expect(markup).toContain('Run prompt')
  })
})
