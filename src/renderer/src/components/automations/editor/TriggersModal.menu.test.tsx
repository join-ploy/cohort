// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TriggersModal } from './TriggersModal'
import type {
  AutoTrigger,
  TriggerConfig,
  SerializableTriggerSource
} from '../../../../../shared/automations-types'

// Why: the "Add trigger" menu is driven by the source registry fetched via
// `window.api.triggerSources.list()`. Mock it to return the registered sources
// so we can assert every source is offered in the menu.
const SOURCES: SerializableTriggerSource[] = [
  { id: 'linear-issue', displayName: 'Linear issue', fieldCatalog: [] },
  { id: 'github-pr', displayName: 'GitHub PR', fieldCatalog: [] },
  { id: 'http-endpoint', displayName: 'HTTP endpoint', fieldCatalog: [] }
]

// Why: useAppStore reads repos; stub it so the modal renders without the real
// store wiring. We only care about the Add-trigger menu here.
vi.mock('@/store', () => ({
  useAppStore: (selector: (s: { repos: unknown[] }) => unknown) => selector({ repos: [] })
}))

beforeEach(() => {
  ;(globalThis.window as unknown as { api: unknown }).api = {
    triggerSources: {
      list: vi.fn().mockResolvedValue(SOURCES),
      fetchOptions: vi.fn().mockResolvedValue([])
    }
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const baseTrigger: TriggerConfig = { kind: 'manual' }

describe('TriggersModal — Add trigger menu', () => {
  it('offers every registered source (Linear issue + GitHub PR)', async () => {
    const user = userEvent.setup()
    render(
      <TriggersModal
        open={true}
        automationId=""
        trigger={baseTrigger}
        autoTriggers={[]}
        onSave={() => {}}
        onCancel={() => {}}
      />
    )

    // Wait for the registry IPC to resolve before opening the menu.
    await waitFor(() =>
      expect(
        (window.api.triggerSources.list as ReturnType<typeof vi.fn>).mock.calls.length
      ).toBeGreaterThan(0)
    )

    await user.click(screen.getByRole('button', { name: 'Add automatic trigger' }))

    expect(screen.getByRole('menuitem', { name: 'Linear issue' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'GitHub PR' })).toBeTruthy()
  })

  it('adds a github-pr auto trigger when GitHub PR is chosen', async () => {
    const user = userEvent.setup()
    render(
      <TriggersModal
        open={true}
        automationId=""
        trigger={baseTrigger}
        autoTriggers={[]}
        onSave={() => {}}
        onCancel={() => {}}
      />
    )

    await waitFor(() =>
      expect(
        (window.api.triggerSources.list as ReturnType<typeof vi.fn>).mock.calls.length
      ).toBeGreaterThan(0)
    )

    await user.click(screen.getByRole('button', { name: 'Add automatic trigger' }))
    await user.click(screen.getByRole('menuitem', { name: 'GitHub PR' }))

    // The placeholder empty-state disappears once a trigger is added, proving
    // the github-pr source produced a real AutoTrigger.
    expect(screen.queryByText('No automatic triggers configured.')).toBeNull()
  })

  it('seeds a default http config + pollingEnabled when HTTP endpoint is chosen', async () => {
    const user = userEvent.setup()
    let saved: AutoTrigger[] | undefined
    render(
      <TriggersModal
        open={true}
        automationId=""
        trigger={baseTrigger}
        autoTriggers={[]}
        onSave={(next) => {
          saved = next.autoTriggers
        }}
        onCancel={() => {}}
      />
    )

    await waitFor(() =>
      expect(
        (window.api.triggerSources.list as ReturnType<typeof vi.fn>).mock.calls.length
      ).toBeGreaterThan(0)
    )

    await user.click(screen.getByRole('button', { name: 'Add automatic trigger' }))
    await user.click(screen.getByRole('menuitem', { name: 'HTTP endpoint' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(saved).toHaveLength(1)
    const trigger = saved![0]
    expect(trigger.source).toBe('http-endpoint')
    expect(trigger.pollingEnabled).toBe(true)
    expect(trigger.manualEnabled).toBe(false)
    expect(trigger.http).toEqual({
      request: { method: 'GET', url: '', headers: [], query: [] },
      itemsPath: null,
      fields: [],
      dedupeFields: [],
      dateGateField: null
    })
  })
})
