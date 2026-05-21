// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { Automation, RunNowPayload } from '../../../../../shared/automations-types'
import type { LinearIssue, Repo } from '../../../../../shared/types'

// Why: the pickers mounted inside RunNowConfirmModal read from the zustand
// store. Mock it the same way the static-markup picker tests do so this jsdom
// test can drive the full click flow without standing up the app context.
type StoreState = Record<string, unknown>

let mockState: StoreState = {}

vi.mock('@/store', () => ({
  useAppStore: (selector?: (state: StoreState) => unknown) =>
    selector ? selector(mockState) : mockState
}))

const issueA: LinearIssue = {
  id: 'lin-1',
  identifier: 'ORC-1',
  title: 'My ticket',
  description: 'do the thing',
  url: 'https://linear.app/team/issue/ORC-1',
  state: { name: 'In Progress', type: 'started', color: '#fff' },
  team: { id: 't1', name: 'Eng', key: 'ENG' },
  labels: [],
  labelIds: [],
  assignee: { id: 'u1', displayName: 'Alice' },
  priority: 2,
  updatedAt: '2026-01-01T00:00:00Z'
}

const repoA: Repo = {
  id: 'repo-1',
  path: '/tmp/repo-1',
  displayName: 'Repo One',
  badgeColor: '#abc',
  addedAt: 0
}

function makeAutomation(): Automation {
  return {
    id: 'auto-1',
    name: 'My Automation',
    prompt: '',
    agentId: 'claude',
    projectId: 'repo-1',
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
    // Both trigger flags on so both pickers render.
    trigger: { kind: 'manual', acceptsLinearTicket: true, acceptsProjectSelection: true },
    steps: []
  }
}

function baseStoreState(): StoreState {
  return {
    linearStatus: {
      connected: true,
      viewer: { displayName: 'You', email: 'me@x', organizationName: 'Org' }
    },
    linearStatusChecked: true,
    linearSearchCache: {
      'list::assigned::20': { data: [issueA], fetchedAt: Date.now() }
    },
    checkLinearConnection: vi.fn(),
    searchLinearIssues: vi.fn().mockResolvedValue([]),
    listLinearIssues: vi.fn().mockResolvedValue([]),
    openSettingsTarget: vi.fn(),
    repos: [repoA]
  }
}

describe('RunNowConfirmModal — end-to-end payload assembly', () => {
  beforeEach(() => {
    mockState = baseStoreState()
  })

  it('assembles a payload from Linear + project picker selections', async () => {
    const onRun = vi.fn<(payload: RunNowPayload) => Promise<void>>().mockResolvedValue(undefined)
    const onClose = vi.fn()
    const { RunNowConfirmModal } = await import('./RunNowConfirmModal')

    render(
      <RunNowConfirmModal
        open={true}
        automation={makeAutomation()}
        onClose={onClose}
        onRun={onRun}
      />
    )

    // Why: the Linear row exposes its issue id via data-linear-issue-id; query
    // the DOM node directly so the test mirrors the picker contract (MP.6) and
    // doesn't depend on the row's visible text.
    const linearButton = document.querySelector(
      '[data-linear-issue-id="lin-1"]'
    ) as HTMLButtonElement | null
    expect(linearButton).not.toBeNull()
    fireEvent.click(linearButton!)

    // Same shape for the project row.
    const projectButton = document.querySelector(
      '[data-project-id="repo-1"]'
    ) as HTMLButtonElement | null
    expect(projectButton).not.toBeNull()
    fireEvent.click(projectButton!)

    // Run is gated on both pickers — both have a value now, so it should enable.
    const runButton = screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement
    await waitFor(() => expect(runButton.disabled).toBe(false))
    fireEvent.click(runButton)

    await waitFor(() => expect(onRun).toHaveBeenCalled())
    const payload = onRun.mock.calls[0][0]
    expect(payload).toMatchObject({
      linear: {
        issue: {
          id: 'lin-1',
          identifier: 'ORC-1',
          title: 'My ticket'
        }
      },
      projectId: 'repo-1'
    })
    // Modal closes itself after a successful run.
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
