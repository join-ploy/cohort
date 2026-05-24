// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { Step, UpdateLinearIssueConfig } from '../../../../../shared/automations-types'
import type { AvailableVariables } from '../../../lib/template-dry-run'
import type { LinearMember, LinearTeam, LinearWorkflowState } from '../../../../../shared/types'

// Why: the step card calls `useTeamMembers(teamId)` / `useTeamStates(teamId)`
// which under the hood request-dedup against `window.api.linear.*`. We mock
// the hooks so tests render synchronously with fixed fixtures, without
// having to stand up the metadata-request cache.
const memberFixtures: LinearMember[] = [
  { id: 'user-alice', displayName: 'Alice' },
  { id: 'user-bob', displayName: 'Bob' }
]
const stateFixtures: LinearWorkflowState[] = [
  { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#aaa', position: 0 },
  { id: 'state-doing', name: 'In Progress', type: 'started', color: '#bbb', position: 1 }
]

const useTeamMembersMock = vi.fn((teamId: string | null) => ({
  data: teamId ? memberFixtures : [],
  loading: false,
  error: null
}))
const useTeamStatesMock = vi.fn((teamId: string | null) => ({
  data: teamId ? stateFixtures : [],
  loading: false,
  error: null
}))

vi.mock('@/hooks/useIssueMetadata', () => ({
  useTeamMembers: (teamId: string | null) => useTeamMembersMock(teamId),
  useTeamStates: (teamId: string | null) => useTeamStatesMock(teamId)
}))

// Why: TemplateInput renders a VariablePickerPopover that uses Radix portals
// and would noisy-warn under renderToStaticMarkup; the actual <input> is what
// we care about for the toggle behaviour, so a stub keeps tests focused.
vi.mock('./TemplateInput', () => ({
  TemplateInput: (props: {
    value: string
    onChange: (v: string) => void
    placeholder?: string
    ariaLabel?: string
  }) => (
    <input
      type="text"
      aria-label={props.ariaLabel}
      placeholder={props.placeholder}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    />
  )
}))

import {
  UpdateLinearIssueStepCard,
  __resetUpdateLinearIssueTeamsCacheForTest
} from './UpdateLinearIssueStepCard'

afterEach(() => {
  cleanup()
  useTeamMembersMock.mockClear()
  useTeamStatesMock.mockClear()
  __resetUpdateLinearIssueTeamsCacheForTest()
})

const EMPTY_AVAIL: AvailableVariables = { automation: {}, trigger: {}, steps: {} }

const teamFixtures: LinearTeam[] = [
  { id: 'team-1', name: 'Engineering', key: 'ENG' },
  { id: 'team-2', name: 'Design', key: 'DSN' }
]

function makeStep(overrides: Partial<UpdateLinearIssueConfig> = {}): Step {
  return {
    id: 'uli-1',
    kind: 'update-linear-issue',
    config: {
      issueRef: '{{trigger.linear.issue.id}}',
      teamId: 'team-1',
      assigneeRef: 'user-alice',
      stateRef: 'state-todo',
      ...overrides
    },
    onFailure: 'halt',
    timeoutSeconds: null
  }
}

beforeEach(() => {
  // Stub the preload Linear bindings the team picker calls on mount. We only
  // need listTeams; useTeamMembers/useTeamStates are mocked above so the
  // other Linear bindings are unreachable in this test. Assigning to
  // `window.api` directly (vs `vi.stubGlobal('window', …)`) preserves the
  // jsdom document that testing-library uses to query elements.
  ;(globalThis.window as unknown as { api: unknown }).api = {
    linear: {
      listTeams: vi.fn().mockResolvedValue(teamFixtures)
    }
  }
})

function renderCard(
  overrides: {
    config?: Partial<UpdateLinearIssueConfig>
    onConfigChange?: (c: UpdateLinearIssueConfig) => void
  } = {}
): ReturnType<typeof render> {
  return render(
    <UpdateLinearIssueStepCard
      step={makeStep(overrides.config)}
      stepIndex={0}
      available={EMPTY_AVAIL}
      onIdChange={() => {}}
      onConfigChange={overrides.onConfigChange ?? (() => {})}
      onOnFailureChange={() => {}}
      onTimeoutChange={() => {}}
      onDelete={() => {}}
    />
  )
}

describe('UpdateLinearIssueStepCard', () => {
  it('renders the kind badge from StepCardChrome', () => {
    const markup = renderToStaticMarkup(
      <UpdateLinearIssueStepCard
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
    expect(markup).toContain('Update Linear issue')
  })

  it('renders the issue-ref TemplateInput', () => {
    const { getByLabelText } = renderCard()
    expect(getByLabelText('Issue ref')).toBeTruthy()
  })

  it('shows the at-least-one hint', () => {
    const markup = renderToStaticMarkup(
      <UpdateLinearIssueStepCard
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
    expect(markup).toMatch(/at least one of assignee or state is required/i)
  })

  describe('team picker', () => {
    it('renders a team picker and loads teams from window.api.linear.listTeams', async () => {
      const { findByLabelText } = renderCard({ config: { teamId: '' } })
      const select = (await findByLabelText('Linear team')) as HTMLSelectElement
      // wait for listTeams() to resolve and options to render
      await waitFor(() => {
        expect(select.querySelectorAll('option').length).toBeGreaterThan(1)
      })
      const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent)
      expect(options.some((o) => o?.includes('Engineering'))).toBe(true)
      expect(options.some((o) => o?.includes('ENG'))).toBe(true)
    })

    it('updates config.teamId when the team picker changes', async () => {
      const onConfigChange = vi.fn()
      const { findByLabelText } = renderCard({ config: { teamId: '' }, onConfigChange })
      const select = (await findByLabelText('Linear team')) as HTMLSelectElement
      await waitFor(() => {
        expect(select.querySelectorAll('option').length).toBeGreaterThan(1)
      })
      fireEvent.change(select, { target: { value: 'team-2' } })
      expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'team-2' }))
    })
  })

  describe('assignee picker', () => {
    it('renders a Select listing members when teamId is set', async () => {
      const { findByLabelText } = renderCard()
      const select = (await findByLabelText('Assignee')) as HTMLSelectElement
      const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent)
      expect(options.some((o) => o?.includes('Alice'))).toBe(true)
      expect(options.some((o) => o?.includes('Bob'))).toBe(true)
    })

    it('includes a "(no change)" option that emits empty string', async () => {
      const onConfigChange = vi.fn()
      const { findByLabelText } = renderCard({ onConfigChange })
      const select = (await findByLabelText('Assignee')) as HTMLSelectElement
      const noChange = Array.from(select.querySelectorAll('option')).find((o) =>
        /no change/i.test(o.textContent ?? '')
      )
      expect(noChange).toBeTruthy()
      fireEvent.change(select, { target: { value: '' } })
      expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({ assigneeRef: '' }))
    })

    it('emits the selected user id when a member is picked', async () => {
      const onConfigChange = vi.fn()
      const { findByLabelText } = renderCard({ onConfigChange })
      const select = (await findByLabelText('Assignee')) as HTMLSelectElement
      fireEvent.change(select, { target: { value: 'user-bob' } })
      expect(onConfigChange).toHaveBeenCalledWith(
        expect.objectContaining({ assigneeRef: 'user-bob' })
      )
    })

    it('toggles to template mode when "Use template" is clicked', async () => {
      const onConfigChange = vi.fn()
      const { findByLabelText, getByRole, queryByLabelText } = renderCard({
        onConfigChange
      })
      // start in picker mode
      expect(await findByLabelText('Assignee')).toBeTruthy()
      const toggle = getByRole('button', { name: /assignee template mode/i })
      fireEvent.click(toggle)
      // picker gone, template input present
      expect(queryByLabelText('Assignee')).toBeNull()
      expect(queryByLabelText('Assignee ref')).toBeTruthy()
    })

    it('auto-detects template mode when the saved value contains {{', async () => {
      const { findByLabelText, queryByLabelText } = renderCard({
        config: { assigneeRef: '{{trigger.linear.issue.assigneeId}}' }
      })
      expect(await findByLabelText('Assignee ref')).toBeTruthy()
      expect(queryByLabelText('Assignee')).toBeNull()
    })

    it('renders an "Unknown" sentinel option when the saved value does not match any known member', async () => {
      const { findByLabelText } = renderCard({
        config: { assigneeRef: 'user-stale-xyz' }
      })
      const select = (await findByLabelText('Assignee')) as HTMLSelectElement
      const unknown = Array.from(select.querySelectorAll('option')).find((o) =>
        /unknown/i.test(o.textContent ?? '')
      )
      expect(unknown).toBeTruthy()
    })
  })

  describe('state picker', () => {
    it('renders a Select listing workflow states when teamId is set', async () => {
      const { findByLabelText } = renderCard()
      const select = (await findByLabelText('State')) as HTMLSelectElement
      const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent)
      expect(options.some((o) => o?.includes('Todo'))).toBe(true)
      expect(options.some((o) => o?.includes('In Progress'))).toBe(true)
    })

    it('emits the selected state id when a state is picked', async () => {
      const onConfigChange = vi.fn()
      const { findByLabelText } = renderCard({ onConfigChange })
      const select = (await findByLabelText('State')) as HTMLSelectElement
      fireEvent.change(select, { target: { value: 'state-doing' } })
      expect(onConfigChange).toHaveBeenCalledWith(
        expect.objectContaining({ stateRef: 'state-doing' })
      )
    })

    it('toggles to template mode when "Use template" is clicked', async () => {
      const { findByLabelText, getByRole, queryByLabelText } = renderCard()
      expect(await findByLabelText('State')).toBeTruthy()
      const toggle = getByRole('button', { name: /state template mode/i })
      fireEvent.click(toggle)
      expect(queryByLabelText('State')).toBeNull()
      expect(queryByLabelText('State ref')).toBeTruthy()
    })

    it('auto-detects template mode when the saved value contains a template token', async () => {
      const { findByLabelText, queryByLabelText } = renderCard({
        config: { stateRef: '{{steps.s1.stateId}}' }
      })
      expect(await findByLabelText('State ref')).toBeTruthy()
      expect(queryByLabelText('State')).toBeNull()
    })
  })

  describe('without teamId', () => {
    it('forces template mode for assignee/state when no team is selected', async () => {
      const { findByLabelText, queryByLabelText } = renderCard({
        config: { teamId: '', assigneeRef: '', stateRef: '' }
      })
      expect(await findByLabelText('Assignee ref')).toBeTruthy()
      expect(await findByLabelText('State ref')).toBeTruthy()
      expect(queryByLabelText('Assignee')).toBeNull()
      expect(queryByLabelText('State')).toBeNull()
    })
  })

  it('calls onConfigChange when the issue ref input changes', () => {
    const onConfigChange = vi.fn()
    const { getByLabelText } = renderCard({ onConfigChange })
    fireEvent.change(getByLabelText('Issue ref'), { target: { value: 'new-issue-id' } })
    expect(onConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({ issueRef: 'new-issue-id' })
    )
  })
})
