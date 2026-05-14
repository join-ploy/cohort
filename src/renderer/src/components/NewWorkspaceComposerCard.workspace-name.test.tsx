import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'

// Why: NewWorkspaceComposerCard is heavy (combobox, agent picker, sparse,
// drag handlers). Mock its sub-components so the test can focus on the new
// workspaceName field markup. Mirrors WorktreeCardAgents.test.tsx.

vi.mock('@/store', () => ({
  useAppStore: (selector?: (state: Record<string, unknown>) => unknown) =>
    selector
      ? selector({
          openModal: vi.fn(),
          settings: { defaultTuiAgent: null },
          updateSettings: vi.fn()
        })
      : {}
}))

vi.mock('@/components/repo/RepoCombobox', () => ({ default: () => null }))
vi.mock('@/components/agent/AgentCombobox', () => ({ default: () => null }))
vi.mock('@/components/sparse/SparseCheckoutPresetSelect', () => ({ default: () => null }))
vi.mock('@/components/new-workspace/SmartWorkspaceNameField', () => ({
  default: () => null,
  type: undefined
}))
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  )
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: unknown }) => children as never,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: unknown }) => children as never
}))

const baseProps = {
  containerClassName: undefined,
  composerRef: undefined,
  nameInputRef: undefined,
  quickAgent: null,
  onQuickAgentChange: vi.fn(),
  eligibleRepos: [],
  repoId: '',
  onRepoChange: vi.fn(),
  name: '',
  onNameValueChange: vi.fn(),
  onSmartGitHubItemSelect: vi.fn(),
  onSmartBranchSelect: vi.fn(),
  onSmartLinearIssueSelect: vi.fn(),
  smartNameSelection: null,
  onClearSmartNameSelection: vi.fn(),
  detectedAgentIds: null,
  onOpenAgentSettings: vi.fn(),
  advancedOpen: false,
  onToggleAdvanced: vi.fn(),
  createDisabled: false,
  creating: false,
  onCreate: vi.fn(),
  note: '',
  onNoteChange: vi.fn(),
  setupConfig: null,
  requiresExplicitSetupChoice: false,
  setupDecision: null,
  onSetupDecisionChange: vi.fn(),
  shouldWaitForSetupCheck: false,
  resolvedSetupDecision: null,
  createError: null,
  canUseSparseCheckout: true,
  sparsePresets: [],
  sparseSelectedPresetId: null,
  onSparseSelectPreset: vi.fn()
}

describe('NewWorkspaceComposerCard workspace name field', () => {
  it('renders an editable workspace name input prefilled with the suggestion', async () => {
    const { default: NewWorkspaceComposerCard } = await import('./NewWorkspaceComposerCard')
    const markup = renderToStaticMarkup(
      <NewWorkspaceComposerCard
        {...baseProps}
        workspaceName="wise_panther"
        onWorkspaceNameChange={vi.fn()}
        workspaceNameError={null}
        onRerollWorkspaceName={vi.fn()}
      />
    )
    expect(markup).toContain('value="wise_panther"')
    expect(markup).toContain('id="workspace-name-input"')
    expect(markup).toContain('aria-label="Generate new workspace name"')
  })

  it('renders the validation error when workspaceNameError is set', async () => {
    const { default: NewWorkspaceComposerCard } = await import('./NewWorkspaceComposerCard')
    const markup = renderToStaticMarkup(
      <NewWorkspaceComposerCard
        {...baseProps}
        workspaceName="Bad-Name"
        onWorkspaceNameChange={vi.fn()}
        workspaceNameError="Use lowercase letters."
        onRerollWorkspaceName={vi.fn()}
      />
    )
    expect(markup).toContain('Use lowercase letters.')
    expect(markup).toContain('aria-invalid="true"')
    expect(markup).toContain('id="workspace-name-error"')
  })
})
