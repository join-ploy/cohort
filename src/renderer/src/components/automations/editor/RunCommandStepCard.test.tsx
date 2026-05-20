import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import { RunCommandStepCard } from './RunCommandStepCard'
import type { Step } from '../../../../../shared/automations-types'
import type { SidebarPromptCommand } from '../../../../../shared/types'
import type { AvailableVariables } from '../../../lib/template-dry-run'

const EMPTY_AVAIL: AvailableVariables = { automation: {}, trigger: {}, steps: {} }

const REVIEW_COMMANDS: SidebarPromptCommand[] = [
  { id: 'rev-a', label: 'Quick review', command: 'claude', prompt: 'review please' },
  { id: 'rev-b', label: 'Deep review', command: 'claude', prompt: 'deep review' }
]
const CREATE_PR_COMMANDS: SidebarPromptCommand[] = [
  { id: 'pr-a', label: 'Open PR', command: 'claude', prompt: 'open pr' }
]

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: 'rc-1',
    kind: 'run-command',
    config: {
      worktreeRef: '{{steps.cw-1.worktreeId}}',
      source: 'review',
      commandId: 'rev-b',
      captureStdout: false
    },
    onFailure: 'halt',
    timeoutSeconds: 60,
    ...overrides
  } as Step
}

function render(step: Step): string {
  return renderToStaticMarkup(
    <RunCommandStepCard
      step={step}
      stepIndex={3}
      available={EMPTY_AVAIL}
      reviewCommands={REVIEW_COMMANDS}
      createPrCommands={CREATE_PR_COMMANDS}
      onIdChange={() => {}}
      onConfigChange={() => {}}
      onOnFailureChange={() => {}}
      onTimeoutChange={() => {}}
      onDelete={() => {}}
    />
  )
}

describe('RunCommandStepCard', () => {
  it('renders the worktree ref input with the current value', () => {
    const markup = render(makeStep())
    expect(markup).toMatch(/aria-label=["']Worktree ref["']/)
    expect(markup).toContain('steps.cw-1.worktreeId')
  })

  it('renders the source segmented control with all three buttons', () => {
    const markup = render(makeStep())
    expect(markup).toMatch(/aria-label=["']Command source["']/)
    expect(markup).toContain('Review')
    expect(markup).toContain('Create PR')
    expect(markup).toContain('Custom')
  })

  it('marks the active source as pressed', () => {
    const markup = render(
      makeStep({ config: { worktreeRef: '', source: 'create-pr', captureStdout: false } })
    )
    expect(markup).toMatch(/aria-pressed=["']true["'][^>]*>Create PR/)
    expect(markup).toMatch(/aria-pressed=["']false["'][^>]*>Review/)
  })

  it('renders the command select populated from reviewCommands when source is review', () => {
    const markup = render(makeStep())
    expect(markup).toMatch(/aria-label=["']Command["']/)
    expect(markup).toContain('Quick review')
    expect(markup).toContain('Deep review')
    // selected option matches the configured commandId
    expect(markup).toMatch(/value=["']rev-b["'][^>]*selected/)
  })

  it('renders the command select populated from createPrCommands when source is create-pr', () => {
    const markup = render(
      makeStep({
        config: {
          worktreeRef: '',
          source: 'create-pr',
          commandId: 'pr-a',
          captureStdout: false
        }
      })
    )
    expect(markup).toContain('Open PR')
    expect(markup).not.toContain('Quick review')
  })

  it('renders the custom command TemplateInput when source is custom', () => {
    const markup = render(
      makeStep({
        config: {
          worktreeRef: '',
          source: 'custom',
          customCommand: 'pnpm test',
          captureStdout: false
        }
      })
    )
    expect(markup).toMatch(/aria-label=["']Custom command["']/)
    expect(markup).toContain('pnpm test')
    // No "Command" select when custom is selected.
    expect(markup).not.toMatch(/aria-label=["']Command["']/)
  })

  it('renders the kind badge from StepCardChrome', () => {
    const markup = render(makeStep())
    expect(markup).toContain('Run command')
  })
})
