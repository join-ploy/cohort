// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  CreateWorkspaceGroupArgs,
  CreateWorkspaceGroupResult,
  Repo,
  WorkspaceGroup,
  Worktree
} from '../../../shared/types'
import type * as SelectorsModule from '@/store/selectors'

// Why: Radix Popover internals reach for ResizeObserver in jsdom — install a
// minimal no-op polyfill so the popover-backed RepoMultiCombobox can render
// during tests without crashing.
type ROCallback = () => void
class TestResizeObserver {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_cb: ROCallback) {
    /* no-op */
  }
  observe(): void {
    /* no-op */
  }
  unobserve(): void {
    /* no-op */
  }
  disconnect(): void {
    /* no-op */
  }
}
;(globalThis as unknown as { ResizeObserver: typeof TestResizeObserver }).ResizeObserver =
  TestResizeObserver

// Why: jsdom doesn't implement hasPointerCapture / scrollIntoView either —
// Radix's PopoverContent calls both during open. Stub them onto Element so
// they exist for tests but stay inert.
if (
  typeof Element !== 'undefined' &&
  typeof (Element.prototype as unknown as { hasPointerCapture?: unknown }).hasPointerCapture !==
    'function'
) {
  ;(Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture = () =>
    false
}
if (
  typeof Element !== 'undefined' &&
  typeof (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView !==
    'function'
) {
  ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
}

type StoreState = {
  repos: Repo[]
  workspaceGroups: WorkspaceGroup[]
  createGroup: ReturnType<typeof vi.fn>
  setActiveWorktree: ReturnType<typeof vi.fn>
  settings: { defaultTuiAgent: string | null; agentCmdOverrides: Record<string, string> } | null
  updateSettings: ReturnType<typeof vi.fn>
  detectedAgentIds: string[]
  ensureDetectedAgents: ReturnType<typeof vi.fn>
  closeModal: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => {
  return {
    state: {
      repos: [],
      workspaceGroups: [],
      createGroup: vi.fn(),
      setActiveWorktree: vi.fn(),
      settings: { defaultTuiAgent: null, agentCmdOverrides: {} },
      updateSettings: vi.fn(),
      detectedAgentIds: [],
      ensureDetectedAgents: vi.fn().mockResolvedValue(undefined),
      closeModal: vi.fn()
    } as StoreState,
    activateAndRevealWorktree: vi.fn().mockReturnValue({ primaryTabId: 'tab-1' })
  }
})

vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: StoreState) => T): T => selector(mocks.state)
}))

vi.mock('@/store/selectors', async () => {
  const actual = await vi.importActual<typeof SelectorsModule>('@/store/selectors')
  return {
    ...actual,
    useRepos: () => mocks.state.repos,
    useWorkspaceGroups: () => mocks.state.workspaceGroups
  }
})

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: (
    ...args: Parameters<typeof mocks.activateAndRevealWorktree>
  ): ReturnType<typeof mocks.activateAndRevealWorktree> => mocks.activateAndRevealWorktree(...args)
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

// Why: workspace-name-generator picks a random adjective_noun on each call.
// Pin Math.random so the initial name is deterministic for tests that assert
// on submit-arg shape.
const ORIGINAL_RANDOM = Math.random

import GroupedComposerForm from './GroupedComposerForm'

function makeRepo(overrides: Partial<Repo> & { id: string; displayName: string }): Repo {
  return {
    path: `/tmp/${overrides.id}`,
    badgeColor: '#111',
    addedAt: 0,
    ...overrides
  } as Repo
}

function makeWorktree(id: string, repoId: string): Worktree {
  return {
    id,
    repoId,
    path: `/tmp/${id}`,
    head: 'abc',
    branch: 'refs/heads/x',
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    workspaceName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    archivedAt: null,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

function renderForm(props?: { onCreated?: (result: CreateWorkspaceGroupResult) => void }) {
  const onCreated = props?.onCreated ?? ((): void => {})
  const onCancel = vi.fn()
  return {
    onCancel,
    onCreated,
    ...render(
      <TooltipProvider>
        <GroupedComposerForm onCancel={onCancel} onCreated={onCreated} />
      </TooltipProvider>
    )
  }
}

function getGroupNameInput(): HTMLInputElement {
  return screen.getByLabelText('Group name') as HTMLInputElement
}

function getBranchInput(): HTMLInputElement {
  return screen.getByLabelText('Branch name') as HTMLInputElement
}

function getSubmitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Create Group' }) as HTMLButtonElement
}

describe('<GroupedComposerForm />', () => {
  beforeEach(() => {
    cleanup()
    mocks.state.repos = [
      makeRepo({ id: 'repo-a', displayName: 'alpha', path: '/tmp/alpha' }),
      makeRepo({ id: 'repo-b', displayName: 'beta', path: '/tmp/beta' }),
      makeRepo({ id: 'repo-c', displayName: 'gamma', path: '/tmp/gamma' })
    ]
    mocks.state.workspaceGroups = []
    mocks.state.createGroup.mockReset()
    mocks.state.setActiveWorktree.mockReset()
    mocks.state.ensureDetectedAgents.mockClear()
    mocks.state.updateSettings.mockClear()
    mocks.state.closeModal.mockClear()
    mocks.activateAndRevealWorktree.mockClear()
    // Why: stable picks for generateUniqueWorkspaceName so the initial group
    // name doesn't drift between runs.
    Math.random = () => 0
  })

  afterEach(() => {
    Math.random = ORIGINAL_RANDOM
  })

  it('disables submit when fewer than 2 repos are selected', () => {
    renderForm()
    const submit = getSubmitButton()
    expect(submit.disabled).toBe(true)
    expect(screen.getByText(/select at least 2 repos/i)).toBeTruthy()
  })

  it('disables submit when the group name fails validation', async () => {
    const user = userEvent.setup()
    renderForm()

    // Open the repo multi-combobox and pick two repos to clear the < 2 gate.
    // Why: both RepoMultiCombobox and AgentCombobox expose role="combobox";
    // the first one in document order is the repo picker.
    await user.click(screen.getAllByRole('combobox')[0])
    await user.click(await screen.findByRole('option', { name: /alpha/i }))
    await user.click(await screen.findByRole('option', { name: /beta/i }))
    await user.keyboard('{Escape}')

    // With two repos and the generated name, submit must be enabled first so
    // we know the only thing flipping it back to disabled is the bad name.
    expect(getSubmitButton().disabled).toBe(false)

    // "alpha" collides with the repo folder basename of /tmp/alpha.
    const nameInput = getGroupNameInput()
    await user.clear(nameInput)
    await user.type(nameInput, 'alpha')

    expect(screen.getByText(/repo already uses this folder name/i)).toBeTruthy()
    expect(getSubmitButton().disabled).toBe(true)
  })

  it('branch name auto-syncs to group name until the user edits the branch field', async () => {
    const user = userEvent.setup()
    renderForm()
    const nameInput = getGroupNameInput()
    const branchInput = getBranchInput()

    // Both start at the same generated value.
    expect(branchInput.value).toBe(nameInput.value)

    // Edit the group name → branch follows.
    await user.clear(nameInput)
    await user.type(nameInput, 'fresh_otter')
    expect(branchInput.value).toBe('fresh_otter')

    // Edit the branch field directly → latch on.
    await user.clear(branchInput)
    await user.type(branchInput, 'custom-branch')
    expect(branchInput.value).toBe('custom-branch')

    // Subsequent group-name edits no longer overwrite branch.
    await user.clear(nameInput)
    await user.type(nameInput, 'other_name')
    expect(branchInput.value).toBe('custom-branch')
  })

  it('submit calls createGroup with the expected args shape', async () => {
    const user = userEvent.setup()
    const memberWorktree = makeWorktree('repo-a::/tmp/alpha/x', 'repo-a')
    mocks.state.createGroup.mockResolvedValue({
      group: {
        id: 'group:new',
        workspaceName: 'team_build',
        displayName: 'team_build',
        parentPath: '/tmp/team_build',
        memberWorktreeIds: [memberWorktree.id],
        branchName: 'team_build',
        isArchived: false,
        archivedAt: null,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        isUnread: false,
        comment: '',
        createdAt: 0,
        linkedIssue: null,
        linkedLinearIssue: null
      } as WorkspaceGroup,
      memberWorktrees: [memberWorktree]
    })
    const onCreated = vi.fn()
    renderForm({ onCreated })

    // Why: both RepoMultiCombobox and AgentCombobox expose role="combobox";
    // the first one in document order is the repo picker.
    await user.click(screen.getAllByRole('combobox')[0])
    await user.click(await screen.findByRole('option', { name: /alpha/i }))
    await user.click(await screen.findByRole('option', { name: /beta/i }))
    await user.keyboard('{Escape}')

    // Use a deterministic group name so the createGroup arg assertion is
    // stable regardless of the seeded suggestion.
    const nameInput = getGroupNameInput()
    await user.clear(nameInput)
    await user.type(nameInput, 'team_build')

    const submit = getSubmitButton()
    expect(submit.disabled).toBe(false)
    await act(async () => {
      await user.click(submit)
    })

    expect(mocks.state.createGroup).toHaveBeenCalledTimes(1)
    const args = mocks.state.createGroup.mock.calls[0][0] as CreateWorkspaceGroupArgs
    expect(args.workspaceName).toBe('team_build')
    expect(args.branchName).toBe('team_build')
    expect(args.telemetrySource).toBe('composer')
    expect(args.members).toHaveLength(2)
    const repoIds = args.members.map((m) => m.repoId).sort()
    expect(repoIds).toEqual(['repo-a', 'repo-b'])
    for (const member of args.members) {
      expect(member.setupDecision).toBe('inherit')
    }
    // Why: post-create activation now routes through activateAndRevealWorktree
    // so the first member's terminal opens with the agent startup plan.
    // setActiveWorktree is no longer called from this surface.
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(memberWorktree.id, undefined)
    expect(mocks.state.setActiveWorktree).not.toHaveBeenCalled()
    expect(onCreated).toHaveBeenCalledTimes(1)
  })

  it('stamps createdWithAgent on each member and seeds the startup command for the first member', async () => {
    const user = userEvent.setup()
    mocks.state.detectedAgentIds = ['claude', 'codex']
    mocks.state.settings = { defaultTuiAgent: 'claude', agentCmdOverrides: {} }
    const memberA = makeWorktree('repo-a::/tmp/alpha/x', 'repo-a')
    const memberB = makeWorktree('repo-b::/tmp/beta/x', 'repo-b')
    mocks.state.createGroup.mockResolvedValue({
      group: {
        id: 'group:new',
        workspaceName: 'team_build',
        displayName: 'team_build',
        parentPath: '/tmp/team_build',
        memberWorktreeIds: [memberA.id, memberB.id],
        branchName: 'team_build',
        isArchived: false,
        archivedAt: null,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        isUnread: false,
        comment: '',
        createdAt: 0,
        linkedIssue: null,
        linkedLinearIssue: null
      } as WorkspaceGroup,
      memberWorktrees: [memberA, memberB]
    })

    renderForm()

    // Why: both RepoMultiCombobox and AgentCombobox expose role="combobox";
    // the first one in document order is the repo picker.
    await user.click(screen.getAllByRole('combobox')[0])
    await user.click(await screen.findByRole('option', { name: /alpha/i }))
    await user.click(await screen.findByRole('option', { name: /beta/i }))
    await user.keyboard('{Escape}')

    const nameInput = getGroupNameInput()
    await user.clear(nameInput)
    await user.type(nameInput, 'team_build')

    await act(async () => {
      await user.click(getSubmitButton())
    })

    const args = mocks.state.createGroup.mock.calls[0][0] as CreateWorkspaceGroupArgs
    for (const member of args.members) {
      expect(member.createdWithAgent).toBe('claude')
    }
    // activateAndRevealWorktree got a startup plan with a non-empty command.
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    const [targetWorktreeId, opts] = mocks.activateAndRevealWorktree.mock.calls[0] as [
      string,
      { startup?: { command: string } } | undefined
    ]
    expect(targetWorktreeId).toBe(memberA.id)
    expect(opts?.startup?.command).toBeTruthy()
  })
})
