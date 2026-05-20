import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect, vi } from 'vitest'
import { ChainEditorModal } from './ChainEditorModal'
import type { Automation, Step } from '../../../../../shared/automations-types'

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  const steps: Step[] = [
    {
      id: 'cw-1',
      kind: 'create-worktree',
      config: {
        baseBranch: 'main',
        branchName: 'feature/x',
        displayName: 'My Display',
        linkLinearIssue: false
      },
      onFailure: 'halt',
      timeoutSeconds: 60
    },
    {
      id: 'rp-1',
      kind: 'run-prompt',
      config: {
        worktreeRef: '{{steps.cw-1.worktreeId}}',
        agentId: 'claude',
        prompt: 'do the thing',
        doneDebounceSeconds: 5
      },
      onFailure: 'halt',
      timeoutSeconds: 600
    }
  ]
  return {
    id: 'auto-1',
    name: 'Test Automation',
    prompt: '',
    agentId: 'claude',
    projectId: 'proj-1',
    executionTargetType: 'local',
    executionTargetId: '',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'existing',
    workspaceId: null,
    baseBranch: null,
    timezone: 'UTC',
    rrule: '',
    dtstart: 0,
    enabled: true,
    nextRunAt: 0,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 0,
    createdAt: 0,
    updatedAt: 0,
    trigger: { kind: 'manual' },
    steps,
    ...overrides
  }
}

describe('ChainEditorModal', () => {
  it('renders nothing when open=false', () => {
    const markup = renderToStaticMarkup(
      <ChainEditorModal
        open={false}
        automation={null}
        reviewCommands={[]}
        createPrCommands={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )
    expect(markup).toBe('')
  })

  it('renders a blank chain when automation=null', () => {
    const markup = renderToStaticMarkup(
      <ChainEditorModal
        open={true}
        automation={null}
        reviewCommands={[]}
        createPrCommands={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )
    expect(markup).toMatch(/Trigger.*Manual/i)
    expect(markup).toMatch(/Cancel/i)
    expect(markup).toMatch(/Save/i)
  })

  it('renders the existing automation name in the title input', () => {
    const markup = renderToStaticMarkup(
      <ChainEditorModal
        open={true}
        automation={makeAutomation()}
        reviewCommands={[]}
        createPrCommands={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )
    expect(markup).toMatch(/value=["']Test Automation["']/)
  })

  it('renders the right number of step cards', () => {
    const markup = renderToStaticMarkup(
      <ChainEditorModal
        open={true}
        automation={makeAutomation()}
        reviewCommands={[]}
        createPrCommands={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )
    // Each step kind renders its kind label via StepCardChrome.
    expect(markup).toContain('Create worktree')
    expect(markup).toContain('Run prompt')
  })

  it('renders the AvailableVariablesPanel', () => {
    const markup = renderToStaticMarkup(
      <ChainEditorModal
        open={true}
        automation={makeAutomation()}
        reviewCommands={[]}
        createPrCommands={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )
    expect(markup).toMatch(/Available variables/i)
  })

  it('renders an enabled checkbox bound to draft.enabled', () => {
    const markup = renderToStaticMarkup(
      <ChainEditorModal
        open={true}
        automation={makeAutomation({ enabled: true })}
        reviewCommands={[]}
        createPrCommands={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )
    expect(markup).toMatch(/aria-label=["']Enabled["'][^>]*checked/)
  })

  it('renders a Run Now button that is disabled when the row is unsaved', () => {
    const markup = renderToStaticMarkup(
      <ChainEditorModal
        open={true}
        automation={null}
        reviewCommands={[]}
        createPrCommands={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onRunNow={vi.fn()}
      />
    )
    // Run Now button is present but disabled in the New flow.
    expect(markup).toMatch(/Run Now/)
    expect(markup).toMatch(/aria-label=["']Run Now["'][^>]*disabled/)
  })

  it('renders an issue count in the footer for a chain with no errors', () => {
    const markup = renderToStaticMarkup(
      <ChainEditorModal
        open={true}
        automation={makeAutomation()}
        reviewCommands={[]}
        createPrCommands={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )
    expect(markup).toMatch(/0 issues/i)
  })

  it('renders an add-step button', () => {
    const markup = renderToStaticMarkup(
      <ChainEditorModal
        open={true}
        automation={makeAutomation()}
        reviewCommands={[]}
        createPrCommands={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )
    expect(markup).toMatch(/aria-label=["']Add step["']/)
  })
})
