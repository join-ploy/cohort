import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Repo } from '../../shared/types'
import type { Step } from '../../shared/automations-types'
import type { AgentStatusEntry } from '../agent-status/registry'
import { AutomationService } from './service'

// Mock the same surface service.test.ts mocks — Electron + git repo — so the
// real Store can construct against a tmp userData dir without booting Electron.
const testState = { dir: '' }

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

vi.mock('../git/repo', () => ({
  getGitUsername: vi.fn().mockReturnValue('testuser')
}))

async function createStore() {
  vi.resetModules()
  const { Store, initDataPath } = await import('../persistence')
  initDataPath()
  return new Store()
}

const makeRepo = (overrides: Partial<Repo> = {}): Repo => ({
  id: 'r1',
  path: '/repo',
  displayName: 'test',
  badgeColor: '#fff',
  addedAt: 1,
  ...overrides
})

/**
 * Build a minimal fake IpcMain that the real `openPromptPane()` helper can
 * register a `once` listener on. The test drives the reply by holding a
 * reference to the registered handler and invoking it synchronously when the
 * renderer's `send('automations:openPromptPane', ...)` is observed.
 */
function makeFakeIpc(): {
  ipc: { once: ReturnType<typeof vi.fn>; removeAllListeners: ReturnType<typeof vi.fn> }
  listeners: Map<string, (event: unknown, payload: unknown) => void>
} {
  const listeners = new Map<string, (event: unknown, payload: unknown) => void>()
  const ipc = {
    once: vi.fn((channel: string, handler: (event: unknown, payload: unknown) => void) => {
      listeners.set(channel, handler)
    }),
    removeAllListeners: vi.fn((channel: string) => {
      listeners.delete(channel)
    })
  }
  return { ipc, listeners }
}

describe('runNow drives chain-shape automations end-to-end', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-run-now-chain-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('seeds the run as running and ticks the chain executor immediately', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Chain auto',
      prompt: '(legacy prompt — chain-shape overrides this)',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      // dtstart in the future so scheduled evaluation does not race the
      // manual runNow path during this test.
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2030-01-01T00:00:00').getTime()
    })

    const step: Step = {
      id: 's1',
      kind: 'run-prompt',
      config: {
        worktreeRef: '{{automation.workspaceId}}',
        agentId: 'claude',
        prompt: 'do the thing',
        doneDebounceSeconds: 15
      },
      onFailure: 'halt',
      timeoutSeconds: null
    }
    const stored = store.listAutomations().find((entry) => entry.id === automation.id)!
    stored.trigger = { kind: 'manual' }
    stored.steps = [step]

    const { ipc, listeners } = makeFakeIpc()
    // `send` from openPromptPane fires AFTER ipc.once registers the reply
    // listener, so we can resolve the reply synchronously here by invoking
    // the registered handler with a synthetic { ok, paneKey } payload.
    const send = vi.fn((_channel: string, payload: { requestId: string }) => {
      const replyChannel = `automations:openPromptPane:reply:${payload.requestId}`
      const handler = listeners.get(replyChannel)
      handler?.({}, { ok: true, paneKey: 'tab-1:1' })
    })

    const service = new AutomationService(store, {
      tickMs: 60_000,
      getAgentStatus: () => undefined,
      getIpcMain: () => ipc as never
    })
    service.setWebContents({ isDestroyed: () => false, send } as never)
    service.setRendererReady()

    const result = await service.runNow(automation.id)

    // Immediate-tick ran the runner once: openPromptPane was invoked, the
    // tracker was created, and the runner returned needs-more-time so the
    // run is still `running` with one stepState appended.
    expect(send).toHaveBeenCalledWith(
      'automations:openPromptPane',
      expect.objectContaining({
        worktreeId: 'wt1', // resolved from {{automation.workspaceId}}
        agentId: 'claude',
        prompt: 'do the thing'
      })
    )
    expect(result.status).toBe('running')
    expect(result.stepStates).toHaveLength(1)
    expect(result.stepStates?.[0]).toMatchObject({ stepId: 's1', status: 'running' })

    // Verify the run is persisted in the store and the chain executor will
    // pick it up on the next tick (this is what the 60s cadence relies on).
    const persisted = store.listAutomationRuns(stored.id)[0]
    expect(persisted.status).toBe('running')
    expect(persisted.stepStates).toHaveLength(1)
  })

  it('drives a run-prompt step from running to succeeded across multiple ticks', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Chain auto',
      prompt: '(ignored)',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2030-01-01T00:00:00').getTime()
    })

    const step: Step = {
      id: 's1',
      kind: 'run-prompt',
      config: {
        worktreeRef: 'wt1',
        agentId: 'claude',
        prompt: 'go',
        // 1s debounce so a couple of fake ticks satisfy it.
        doneDebounceSeconds: 1
      },
      onFailure: 'halt',
      timeoutSeconds: null
    }
    const stored = store.listAutomations().find((entry) => entry.id === automation.id)!
    stored.trigger = { kind: 'manual' }
    stored.steps = [step]

    const { ipc, listeners } = makeFakeIpc()
    const send = vi.fn((_channel: string, payload: { requestId: string }) => {
      const replyChannel = `automations:openPromptPane:reply:${payload.requestId}`
      listeners.get(replyChannel)?.({}, { ok: true, paneKey: 'tab-1:1' })
    })

    // Drive the agent-status timeline: working on the immediate tick, then
    // done thereafter. Each tick wall-clock advances 2s so the 1s debounce
    // gate flips between tick 2 (firstDoneAt set) and tick 3 (window closed).
    let agentTickCount = 0
    const getAgentStatus = (_paneKey: string): AgentStatusEntry | undefined => {
      agentTickCount++
      if (agentTickCount === 1) {
        return undefined // pane just opened
      }
      if (agentTickCount === 2) {
        return { state: 'working', updatedAt: Date.now() }
      }
      return { state: 'done', updatedAt: Date.now() }
    }

    const service = new AutomationService(store, {
      tickMs: 60_000,
      getAgentStatus,
      getIpcMain: () => ipc as never
    })
    service.setWebContents({ isDestroyed: () => false, send } as never)
    service.setRendererReady()

    // Tick 1 (immediate) — opens the pane, returns needs-more-time.
    const afterImmediate = await service.runNow(automation.id)
    expect(afterImmediate.status).toBe('running')
    expect(send).toHaveBeenCalledTimes(1) // openPromptPane fired exactly once

    // Subsequent ticks happen on the 60s cadence; for the test we tickle the
    // chain executor directly via the same private path (start() + a fake
    // setRendererReady cycle would also work, but exercising tickRunningChains
    // via the public start()/timer would race with vi.useFakeTimers and the
    // store's async flush). Easiest: use the public runNow() entry by
    // simulating subsequent ticks through the executor in series.
    //
    // Because the executor is encapsulated, the cleanest harness is to drive
    // it through the same 60s loop the production code uses. We expose that
    // here by manually invoking start() with a small tickMs and a vi waitFor.
    service.stop()
    const fastService = new AutomationService(store, {
      tickMs: 10,
      getAgentStatus,
      getIpcMain: () => ipc as never
    })
    fastService.setWebContents({ isDestroyed: () => false, send } as never)
    fastService.setRendererReady()
    fastService.start()

    await vi.waitFor(
      () => {
        const persisted = store.listAutomationRuns(stored.id)[0]
        expect(persisted.status).toBe('completed')
      },
      { timeout: 5_000, interval: 50 }
    )
    fastService.stop()

    const final = store.listAutomationRuns(stored.id)[0]
    expect(final.status).toBe('completed')
    expect(final.stepStates).toHaveLength(1)
    expect(final.stepStates?.[0].status).toBe('succeeded')
    expect(final.stepStates?.[0].finishedAt).toBeTypeOf('number')
  })

  it('uses the legacy dispatch path for automations without trigger+steps', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Legacy auto',
      prompt: 'Check the repo',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2030-01-01T00:00:00').getTime()
    })

    const send = vi.fn()
    const service = new AutomationService(store, { tickMs: 60_000 })
    service.setWebContents({ isDestroyed: () => false, send } as never)
    service.setRendererReady()

    const run = await service.runNow(automation.id)

    // Legacy path: the service issues `automations:dispatchRequested`
    // exactly once and never fires the chain-runner's
    // `automations:openPromptPane` channel.
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBe('automations:dispatchRequested')
    const dispatched = store.listAutomationRuns(automation.id).find((r) => r.id === run.id)
    expect(dispatched?.status).toBe('dispatching')
    // No chain artefacts on a legacy run.
    expect(dispatched?.stepStates).toBeUndefined()
  })
})
