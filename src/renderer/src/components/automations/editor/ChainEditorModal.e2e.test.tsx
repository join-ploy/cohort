// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChainEditorModal } from './ChainEditorModal'
import type { Repo, SidebarPromptCommand } from '../../../../../shared/types'
import type { Automation, Step } from '../../../../../shared/automations-types'

const REPOS: Repo[] = [
  {
    id: 'repo-1',
    displayName: 'My Repo',
    path: '/r',
    addedAt: 0,
    badgeColor: '#000'
  }
]

const REVIEW_COMMANDS: SidebarPromptCommand[] = []
const CREATE_PR_COMMANDS: SidebarPromptCommand[] = []

describe('ChainEditorModal — end-to-end composition', () => {
  beforeEach(() => {
    // Stub window.confirm so cancel/discard flows don't bomb on null-jsdom.
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true)
    )
  })

  it('composes a 2-step chain (create-worktree → wait-for-setup) and saves the right shape', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    const onRunNow = vi.fn()

    render(
      <ChainEditorModal
        open={true}
        automation={null}
        repos={REPOS}
        reviewCommands={REVIEW_COMMANDS}
        createPrCommands={CREATE_PR_COMMANDS}
        httpConnections={[]}
        onClose={onClose}
        onSave={onSave}
        onRunNow={onRunNow}
      />
    )

    // 1. Pick a project. The header select is labelled "Project".
    const projectSelect = screen.getByLabelText('Project') as HTMLSelectElement
    await user.selectOptions(projectSelect, 'repo-1')

    // 2. Set the name. Match the exact label to avoid colliding with the
    //    "Branch name" / "Display name" step fields that appear later.
    const nameInput = screen.getByLabelText('Automation name') as HTMLInputElement
    await user.type(nameInput, 'My chain')

    // 3. Add a create-worktree step. The button is labelled "Add step".
    await user.click(screen.getByRole('button', { name: 'Add step' }))
    // Picker menu shows step kinds by their human label.
    await user.click(screen.getByRole('menuitem', { name: 'Create worktree' }))

    // 4. Fill the create-worktree fields.
    await user.type(screen.getByLabelText('Base branch'), 'main')
    await user.type(screen.getByLabelText('Branch name'), 'feature/test')
    await user.type(screen.getByLabelText('Display name'), 'Test chain')

    // 5. Add a wait-for-setup step.
    await user.click(screen.getByRole('button', { name: 'Add step' }))
    await user.click(screen.getByRole('menuitem', { name: 'Wait for setup' }))

    // Worktree ref is a template input. userEvent.type treats '{{' as a special
    // escape ('{Open}'), so use fireEvent.change for the raw string instead.
    const wfsRefInput = screen.getByLabelText('Worktree ref') as HTMLInputElement
    fireEvent.change(wfsRefInput, {
      target: { value: '{{steps.create-worktree-1.worktreeId}}' }
    })

    // 6. Click Save. Save lives in the footer; match by accessible name.
    const saveButton = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    await waitFor(() => expect(saveButton.disabled).toBe(false))
    await user.click(saveButton)

    await waitFor(() => expect(onSave).toHaveBeenCalled())

    const savedAutomation = onSave.mock.calls[0][0] as Automation
    expect(savedAutomation.name).toBe('My chain')
    expect(savedAutomation.projectId).toBe('repo-1')
    expect(savedAutomation.trigger).toEqual({ kind: 'manual' })
    expect(savedAutomation.steps).toHaveLength(2)
    expect((savedAutomation.steps![0] as Step).kind).toBe('create-worktree')
    expect((savedAutomation.steps![1] as Step).kind).toBe('wait-for-setup')
    expect((savedAutomation.steps![0] as Step).id).toMatch(/^create-worktree-/)
    expect((savedAutomation.steps![1] as Step).id).toMatch(/^wait-for-setup-/)
  })
})

describe('ChainEditorModal — step picker', () => {
  beforeEach(() => {
    cleanup()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows the Create workspace group option in the step picker', async () => {
    const user = userEvent.setup()
    render(
      <ChainEditorModal
        open={true}
        automation={null}
        repos={REPOS}
        reviewCommands={REVIEW_COMMANDS}
        createPrCommands={CREATE_PR_COMMANDS}
        httpConnections={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Add step' }))
    expect(screen.getByRole('menuitem', { name: 'Create workspace group' })).toBeTruthy()
  })
})
