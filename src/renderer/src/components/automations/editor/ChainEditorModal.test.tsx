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
        repos={[]}
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
        repos={[]}
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
        repos={[]}
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
        repos={[]}
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
        repos={[]}
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
        repos={[]}
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
        repos={[]}
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
        repos={[]}
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
        repos={[]}
        reviewCommands={[]}
        createPrCommands={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )
    expect(markup).toMatch(/aria-label=["']Add step["']/)
  })

  it('shows a Project select with all repos', () => {
    const repos = [
      {
        id: 'proj-1',
        path: '/tmp/proj-1',
        displayName: 'Project One',
        badgeColor: '#abc',
        addedAt: 0
      },
      {
        id: 'proj-2',
        path: '/tmp/proj-2',
        displayName: 'Project Two',
        badgeColor: '#def',
        addedAt: 0
      }
    ]
    const markup = renderToStaticMarkup(
      <ChainEditorModal
        open={true}
        automation={null}
        repos={repos}
        reviewCommands={[]}
        createPrCommands={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )
    expect(markup).toMatch(/aria-label=["']Project["']/)
    expect(markup).toContain('Project One')
    expect(markup).toContain('Project Two')
  })

  it('renders the trigger pill with the Manual label by default', () => {
    const markup = renderToStaticMarkup(
      <ChainEditorModal
        open={true}
        automation={makeAutomation()}
        repos={[]}
        reviewCommands={[]}
        createPrCommands={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )
    expect(markup).toMatch(/aria-label=["']Trigger["']/)
    expect(markup).toMatch(/Trigger:\s*Manual\b(?!\s*\+)/)
  })

  it('renders the trigger pill label "Manual + Linear" when only acceptsLinearTicket is true', () => {
    const markup = renderToStaticMarkup(
      <ChainEditorModal
        open={true}
        automation={makeAutomation({ trigger: { kind: 'manual', acceptsLinearTicket: true } })}
        repos={[]}
        reviewCommands={[]}
        createPrCommands={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )
    expect(markup).toContain('Manual + Linear')
  })

  it('renders the trigger pill label "Manual + Project" when only acceptsProjectSelection is true', () => {
    const markup = renderToStaticMarkup(
      <ChainEditorModal
        open={true}
        automation={makeAutomation({
          trigger: { kind: 'manual', acceptsProjectSelection: true }
        })}
        repos={[]}
        reviewCommands={[]}
        createPrCommands={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )
    expect(markup).toContain('Manual + Project')
  })

  it('renders the trigger pill label "Manual (2 prompts)" when both flags are true', () => {
    const markup = renderToStaticMarkup(
      <ChainEditorModal
        open={true}
        automation={makeAutomation({
          trigger: {
            kind: 'manual',
            acceptsLinearTicket: true,
            acceptsProjectSelection: true
          }
        })}
        repos={[]}
        reviewCommands={[]}
        createPrCommands={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )
    expect(markup).toContain('Manual (2 prompts)')
  })

  it('hides the upfront Project select when acceptsProjectSelection is true', () => {
    const repos = [
      {
        id: 'proj-1',
        path: '/tmp/proj-1',
        displayName: 'Project One',
        badgeColor: '#abc',
        addedAt: 0
      }
    ]
    const markup = renderToStaticMarkup(
      <ChainEditorModal
        open={true}
        automation={makeAutomation({
          projectId: '',
          trigger: { kind: 'manual', acceptsProjectSelection: true }
        })}
        repos={repos}
        reviewCommands={[]}
        createPrCommands={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )
    expect(markup).not.toMatch(/aria-label=["']Project["']/)
  })

  it('renders the trigger pill as a plain button (no embedded popover)', () => {
    // Why: Phase 11.2 — clicking the pill opens the separate TriggersModal
    // instead of an embedded popover. The pill itself is just a button.
    const markup = renderToStaticMarkup(
      <ChainEditorModal
        open={true}
        automation={makeAutomation()}
        repos={[]}
        reviewCommands={[]}
        createPrCommands={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )
    expect(markup).toMatch(/<button[^>]*aria-label=["']Trigger["']/)
    // The TriggersModal is rendered but closed by default, so its
    // role="dialog" body should not appear in static markup.
    expect(markup).not.toMatch(/aria-label=["']Triggers["']/)
  })

  it('disables save when projectId is empty AND a step needs it (create-worktree)', () => {
    // Why: project-required is now driven by chain shape — a chain with a
    // create-worktree step needs the upfront projectId, but a blank chain or
    // a group-only chain doesn't. Construct a single-step create-worktree
    // automation with no project to assert the gate.
    const markup = renderToStaticMarkup(
      <ChainEditorModal
        open={true}
        automation={makeAutomation({ projectId: '' })}
        repos={[]}
        reviewCommands={[]}
        createPrCommands={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>\s*Save\s*<\/button>/)
    expect(markup).toMatch(/1 issue/i)
  })

  it('does NOT require a project for a blank chain (no steps)', () => {
    const markup = renderToStaticMarkup(
      <ChainEditorModal
        open={true}
        automation={null}
        repos={[]}
        reviewCommands={[]}
        createPrCommands={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )
    // No steps → no consumer of automation.projectId → no error.
    expect(markup).toMatch(/0 issues/i)
  })
})
