import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearIssue } from '../../../../../shared/types'

// Why: the picker reads connection state and search cache from the zustand
// store. Mock the store so renderToStaticMarkup can exercise the rendered
// branches without spinning up the full app context.

type StoreState = Record<string, unknown>

let mockState: StoreState = {}

vi.mock('@/store', () => ({
  useAppStore: (selector?: (state: StoreState) => unknown) =>
    selector ? selector(mockState) : mockState
}))

const issueA: LinearIssue = {
  id: 'issue-1',
  identifier: 'ENG-101',
  title: 'Fix login redirect',
  description: 'When the user logs in, redirect to /home',
  url: 'https://linear.app/team/issue/ENG-101',
  state: { name: 'In Progress', type: 'started', color: '#fff' },
  team: { id: 't1', name: 'Eng', key: 'ENG' },
  labels: [],
  labelIds: [],
  assignee: { id: 'u1', displayName: 'Alice' },
  priority: 2,
  updatedAt: '2026-01-01T00:00:00Z'
}

function disconnectedState(): StoreState {
  return {
    linearStatus: { connected: false, viewer: null },
    linearStatusChecked: true,
    linearSearchCache: {},
    checkLinearConnection: vi.fn(),
    searchLinearIssues: vi.fn(),
    listLinearIssues: vi.fn(),
    openSettingsTarget: vi.fn()
  }
}

function connectedState(
  cache: Record<string, { data: LinearIssue[]; fetchedAt: number }> = {}
): StoreState {
  return {
    linearStatus: {
      connected: true,
      viewer: { displayName: 'You', email: 'me@x', organizationName: 'Org' }
    },
    linearStatusChecked: true,
    linearSearchCache: cache,
    checkLinearConnection: vi.fn(),
    searchLinearIssues: vi.fn().mockResolvedValue([]),
    listLinearIssues: vi.fn().mockResolvedValue([]),
    openSettingsTarget: vi.fn()
  }
}

describe('LinearIssuePicker', () => {
  beforeEach(() => {
    mockState = disconnectedState()
  })

  it('renders the not-connected message when Linear is disconnected', async () => {
    mockState = disconnectedState()
    const { LinearIssuePicker } = await import('./LinearIssuePicker')
    const markup = renderToStaticMarkup(<LinearIssuePicker onSelect={() => {}} />)
    expect(markup).toMatch(/Linear is not connected/i)
    expect(markup).toMatch(/Connect Linear in Settings/i)
    // No search input when disconnected.
    expect(markup).not.toMatch(/aria-label=["']Search Linear issues["']/)
  })

  it('renders search input and the recent-issues list when connected', async () => {
    mockState = connectedState({
      'list::assigned::20': { data: [issueA], fetchedAt: Date.now() }
    })
    const { LinearIssuePicker } = await import('./LinearIssuePicker')
    const markup = renderToStaticMarkup(<LinearIssuePicker onSelect={() => {}} />)
    expect(markup).toMatch(/aria-label=["']Search Linear issues["']/)
    expect(markup).toContain('ENG-101')
    expect(markup).toContain('Fix login redirect')
    expect(markup).toContain('In Progress')
  })

  it('exposes each issue as a clickable result with the linear-issue-id data attribute', async () => {
    mockState = connectedState({
      'list::assigned::20': { data: [issueA], fetchedAt: Date.now() }
    })
    const { LinearIssuePicker } = await import('./LinearIssuePicker')
    const markup = renderToStaticMarkup(<LinearIssuePicker onSelect={() => {}} />)
    expect(markup).toMatch(/data-linear-issue-id=["']issue-1["']/)
  })

  it('exports a toLinearIssuePayload mapper that produces the LinearIssuePayload shape', async () => {
    const mod = await import('./LinearIssuePicker')
    const payload = mod.toLinearIssuePayload(issueA)
    expect(payload).toEqual({
      id: 'issue-1',
      identifier: 'ENG-101',
      title: 'Fix login redirect',
      description: 'When the user logs in, redirect to /home',
      url: 'https://linear.app/team/issue/ENG-101',
      assigneeEmail: '',
      stateName: 'In Progress',
      priority: 2
    })
  })
})
