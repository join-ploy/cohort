import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Repo } from '../../shared/types'
import type { Step } from '../../shared/automations-types'
import { AutomationService } from './service'

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

describe('AutomationService', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-automations-test-'))
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('dispatches an enabled automation when its next run is due', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:59:00'))
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Morning check',
      prompt: 'Check the repo',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-12T00:00:00').getTime()
    })

    vi.setSystemTime(new Date('2026-05-13T09:01:00'))
    const send = vi.fn()
    const service = new AutomationService(store, { tickMs: 60_000 })
    service.setWebContents({
      isDestroyed: () => false,
      send
    } as never)

    service.start()
    service.setRendererReady()
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith('automations:dispatchRequested', expect.any(Object))
    )
    service.stop()

    const [, payload] = send.mock.calls[0]
    expect(payload.automation.id).toBe(automation.id)
    expect(payload.run.scheduledFor).toBe(new Date('2026-05-13T09:00:00').getTime())
    expect(store.listAutomationRuns(automation.id)[0]?.status).toBe('dispatching')
    expect(store.listAutomations().find((entry) => entry.id === automation.id)?.nextRunAt).toBe(
      new Date('2026-05-14T09:00:00').getTime()
    )
  })

  it('marks a running run failed and finalizes its trailing step when the chain executor throws', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:59:00'))
    const store = await createStore()
    store.addRepo(makeRepo())
    // dtstart in the future so evaluateAutomation() does not try to dispatch
    // a fresh legacy-path run — we only want tickRunningChains() to act on
    // the run we seed below.
    const automation = store.createAutomation({
      name: 'Chain auto',
      prompt: 'Do the thing',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2030-01-01T00:00:00').getTime()
    })

    // Mutate in place to attach trigger+steps. The Store API doesn't expose a
    // chain-shape setter yet (it lands in a later Phase 1 task), and
    // listAutomations() returns the entries by reference inside a shallow
    // copy, so the chain executor will see this when it tick()s.
    const unknownKindStep: Step = {
      id: 's1',
      // Cast through unknown so we can stage a kind that has no registered
      // runner — that's exactly what makes ChainExecutor.tick throw, which
      // is what this test is exercising.
      kind: 'definitely-not-a-real-kind' as unknown as Step['kind'],
      config: { worktreeRef: 'wt1', agentId: 'claude', prompt: 'go', doneDebounceSeconds: 15 },
      onFailure: 'halt',
      timeoutSeconds: null
    }
    const stored = store.listAutomations().find((entry) => entry.id === automation.id)!
    stored.trigger = { kind: 'manual' }
    stored.steps = [unknownKindStep]

    // Seed a `running` run with a non-terminal step state so we can assert
    // the catch-block finalizer cleans up the trailing step as well as the
    // run itself.
    const run = store.createAutomationRun(stored, Date.now(), 'manual')
    run.status = 'running'
    run.stepStates = [
      {
        stepId: 's1',
        status: 'running',
        startedAt: Date.now(),
        finishedAt: null,
        output: null,
        error: null
      }
    ]
    store.replaceAutomationRun(run)

    const service = new AutomationService(store, { tickMs: 60_000 })
    service.setWebContents({ isDestroyed: () => false, send: vi.fn() } as never)
    service.setRendererReady()
    // setRendererReady triggers evaluateDueRuns(), which runs
    // tickRunningChains() at the end. Wait for the persisted state to land.
    await vi.waitFor(() => {
      const after = store.listAutomationRuns(stored.id)[0]
      expect(after?.status).toBe('failed')
    })

    const after = store.listAutomationRuns(stored.id)[0]
    expect(after?.status).toBe('failed')
    expect(after?.error).toMatch(/no runner registered/i)
    expect(after?.finishedAt).toBeTypeOf('number')
    // Trailing step must be finalized — no indefinitely-running step under a
    // failed run.
    expect(after?.stepStates?.[0].status).toBe('failed')
    expect(after?.stepStates?.[0].finishedAt).toBeTypeOf('number')
    expect(after?.stepStates?.[0].error).toMatch(/no runner registered/i)
  })
})
