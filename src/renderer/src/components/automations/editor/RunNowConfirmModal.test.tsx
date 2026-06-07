import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Automation, AutoTrigger } from '../../../../../shared/automations-types'
import type { LinearIssue, Repo } from '../../../../../shared/types'

// Why: RunNowConfirmModal mounts the real LinearIssuePicker + ProjectPicker
// subcomponents, which both read from the zustand store. Mock the store so
// renderToStaticMarkup can exercise the modal without standing up the full app
// context. The pickers expose enough markers (aria-label/data-* attrs) that we
// can assert on them inline without mocking the subcomponents themselves.

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

const repoA: Repo = {
  id: 'repo-1',
  path: '/tmp/repo-1',
  displayName: 'Repo One',
  badgeColor: '#abc',
  addedAt: 0
}

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
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
    trigger: { kind: 'manual' },
    steps: [],
    ...overrides
  }
}

function baseStoreState(): StoreState {
  return {
    // Linear picker dependencies — connected with one issue in the cache.
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
    // Project picker dependencies.
    repos: [repoA]
  }
}

describe('RunNowConfirmModal', () => {
  beforeEach(() => {
    mockState = baseStoreState()
  })

  it('renders nothing when open is false', async () => {
    const { RunNowConfirmModal } = await import('./RunNowConfirmModal')
    const markup = renderToStaticMarkup(
      <RunNowConfirmModal
        open={false}
        automation={makeAutomation({
          trigger: { kind: 'manual', acceptsLinearTicket: true }
        })}
        onClose={() => {}}
        onRun={async () => {}}
      />
    )
    expect(markup).toBe('')
  })

  it('renders only the Linear picker when only acceptsLinearTicket is set', async () => {
    const { RunNowConfirmModal } = await import('./RunNowConfirmModal')
    const markup = renderToStaticMarkup(
      <RunNowConfirmModal
        open={true}
        automation={makeAutomation({
          trigger: { kind: 'manual', acceptsLinearTicket: true }
        })}
        onClose={() => {}}
        onRun={async () => {}}
      />
    )
    // LinearIssuePicker's search input identifies it.
    expect(markup).toMatch(/aria-label=["']Search Linear issues["']/)
    // ProjectPicker would surface the repo's displayName; absent here.
    expect(markup).not.toContain('Repo One')
  })

  it('renders the automation name in the title', async () => {
    const { RunNowConfirmModal } = await import('./RunNowConfirmModal')
    const markup = renderToStaticMarkup(
      <RunNowConfirmModal
        open={true}
        automation={makeAutomation({
          name: 'My Cool Automation',
          trigger: { kind: 'manual', acceptsLinearTicket: true }
        })}
        onClose={() => {}}
        onRun={async () => {}}
      />
    )
    expect(markup).toContain('My Cool Automation')
  })

  it('renders Cancel and Run buttons in the footer', async () => {
    const { RunNowConfirmModal } = await import('./RunNowConfirmModal')
    const markup = renderToStaticMarkup(
      <RunNowConfirmModal
        open={true}
        automation={makeAutomation({
          trigger: { kind: 'manual', acceptsLinearTicket: true }
        })}
        onClose={() => {}}
        onRun={async () => {}}
      />
    )
    expect(markup).toMatch(/aria-label=["']Cancel run["']/)
    expect(markup).toMatch(/aria-label=["']Run["']/)
  })

  it('disables the Run button when neither picker has a value', async () => {
    const { RunNowConfirmModal } = await import('./RunNowConfirmModal')
    const markup = renderToStaticMarkup(
      <RunNowConfirmModal
        open={true}
        automation={makeAutomation({
          trigger: {
            kind: 'manual',
            acceptsLinearTicket: true,
            acceptsProjectSelection: true
          }
        })}
        onClose={() => {}}
        onRun={async () => {}}
      />
    )
    expect(markup).toMatch(/<button[^>]*aria-label=["']Run["'][^>]*disabled/)
  })

  it('renders the HTTP item picker and gates Run for a manual http trigger', async () => {
    const httpTrigger: AutoTrigger = {
      id: 'http-1',
      source: 'http-endpoint',
      enabled: true,
      enabledAt: 0,
      rules: [],
      manualEnabled: true,
      http: {
        request: { method: 'GET', url: 'https://api.test/items', headers: [], query: [] },
        itemsPath: null,
        fields: [],
        dedupeFields: [],
        dateGateField: null
      }
    }
    const { RunNowConfirmModal } = await import('./RunNowConfirmModal')
    const markup = renderToStaticMarkup(
      <RunNowConfirmModal
        open={true}
        automation={makeAutomation({ trigger: { kind: 'manual' }, autoTriggers: [httpTrigger] })}
        onClose={() => {}}
        onRun={async () => {}}
      />
    )
    // The picker's filter input identifies it.
    expect(markup).toMatch(/aria-label=["']Filter endpoint items["']/)
    // Run is gated until an item is picked.
    expect(markup).toMatch(/<button[^>]*aria-label=["']Run["'][^>]*disabled/)
  })

  it('renders both pickers when both trigger flags are set', async () => {
    const { RunNowConfirmModal } = await import('./RunNowConfirmModal')
    const markup = renderToStaticMarkup(
      <RunNowConfirmModal
        open={true}
        automation={makeAutomation({
          trigger: {
            kind: 'manual',
            acceptsLinearTicket: true,
            acceptsProjectSelection: true
          }
        })}
        onClose={() => {}}
        onRun={async () => {}}
      />
    )
    // Linear picker marker.
    expect(markup).toMatch(/aria-label=["']Search Linear issues["']/)
    // Project picker marker — the seeded repo's displayName.
    expect(markup).toContain('Repo One')
  })
})
