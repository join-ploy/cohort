// @vitest-environment jsdom

import * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { Automation } from '../../../../shared/automations-types'
import type { Repo } from '../../../../shared/types'

// Why: AutomationsPage pulls in tooltip + the ChainEditorModal subtree. We
// only care about the row-level context-menu Duplicate flow here; mock those
// boundaries so the test stays light and the duplicate action is the sole
// observable side-effect.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children
}))

vi.mock('./editor/ChainEditorModal', () => ({
  ChainEditorModal: () => null
}))

vi.mock('./editor/RunNowConfirmModal', () => ({
  RunNowConfirmModal: () => null
}))

vi.mock('./AutomationDetail', () => ({
  AutomationDetail: () => null
}))

// Why: sonner is jsdom-hostile (raf-driven animations); the page only calls
// toast.success / toast.error fire-and-forget, so a no-op stub is safe.
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn()
  }
}))

type StoreState = Record<string, unknown>

let mockState: StoreState = {}

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector?: (state: StoreState) => unknown) => (selector ? selector(mockState) : mockState),
    { getState: () => mockState }
  )
}))

// Why: useRepoMap / useWorktreeMap are thin selectors over the store; the
// page passes their output to RepoDotLabel which we stub below.
vi.mock('@/store/selectors', () => ({
  useRepoMap: () => new Map<string, Repo>(),
  useWorktreeMap: () => new Map()
}))

vi.mock('@/components/repo/RepoDotLabel', () => ({
  default: () => null
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-source',
    name: 'My Automation',
    prompt: 'do the thing',
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
    steps: [],
    ...overrides
  }
}

const automation = makeAutomation()

const listMock = vi.fn()
const listRunsMock = vi.fn()
const createMock = vi.fn()
const duplicateMock = vi.fn()

beforeEach(() => {
  listMock.mockReset().mockResolvedValue([automation])
  listRunsMock.mockReset().mockResolvedValue([])
  createMock.mockReset().mockImplementation(async (input: unknown) => ({
    ...automation,
    id: 'auto-new',
    ...(typeof input === 'object' && input !== null ? input : {})
  }))
  duplicateMock.mockReset().mockImplementation(async (id: string) => {
    const source = (await listMock()).find((entry: Automation) => entry.id === id)
    if (!source) {
      throw new Error('not found')
    }
    return createMock({ name: `${source.name} (copy)`, enabled: false })
  })

  mockState = {
    repos: [] as Repo[],
    selectedAutomationId: null,
    setSelectedAutomationId: vi.fn(),
    duplicateAutomation: duplicateMock,
    fetchAllWorktrees: vi.fn().mockResolvedValue(undefined),
    updateSettings: vi.fn(),
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn(),
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    settings: { skipDeleteAutomationConfirm: false, reviewCommands: [], createPrCommands: [] }
  }

  ;(globalThis as unknown as { window: Window }).window = Object.assign(window, {
    api: {
      automations: {
        list: listMock,
        listRuns: listRunsMock,
        create: createMock,
        onChanged: () => () => {}
      }
    }
  }) as Window
})

describe('AutomationsPage — right-click Duplicate', () => {
  it('opens the context menu and fires duplicateAutomation when Duplicate is clicked', async () => {
    const { default: AutomationsPage } = await import('./AutomationsPage')
    render(<AutomationsPage />)

    // Wait for the initial list() to populate the row.
    const row = await screen.findByRole('button', { name: /My Automation/i })
    // Why: Radix ContextMenu opens on `contextmenu`, which RTL's userEvent
    // doesn't simulate ergonomically. fireEvent.contextMenu is the documented
    // path.
    fireEvent.contextMenu(row)

    const duplicateItem = await screen.findByRole('menuitem', { name: /Duplicate/i })
    fireEvent.click(duplicateItem)

    await waitFor(() => {
      expect(duplicateMock).toHaveBeenCalledWith('auto-source')
    })
  })
})
