import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Repo } from '../../shared/types'
import type { AutoTrigger, Rule, Step } from '../../shared/automations-types'
import type { CandidateEvent } from './trigger-sources/types'
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

describe('AutomationService auto-trigger engine wiring', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-automations-test-'))
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('start() starts the engine with the configured interval; stop() stops it', async () => {
    const store = await createStore()
    const calls: string[] = []
    const fakeEngine = {
      start: (ms: number) => {
        calls.push(`start:${ms}`)
      },
      stop: () => {
        calls.push('stop')
      }
    }
    const service = new AutomationService(store, {
      autoTriggerEngine: fakeEngine,
      getAutoTriggerPollIntervalSeconds: () => 30,
      tickMs: 60_000
    })
    service.start()
    expect(calls).toContain('start:30000')
    service.stop()
    expect(calls).toContain('stop')
  })

  it('defaults the engine interval to 60s when no getter is supplied', async () => {
    const store = await createStore()
    const calls: string[] = []
    const fakeEngine = {
      start: (ms: number) => {
        calls.push(`start:${ms}`)
      },
      stop: () => {
        calls.push('stop')
      }
    }
    const service = new AutomationService(store, {
      autoTriggerEngine: fakeEngine,
      tickMs: 60_000
    })
    service.start()
    expect(calls).toContain('start:60000')
    service.stop()
  })

  it('omitting the engine is a no-op (existing tests keep working)', async () => {
    const store = await createStore()
    const service = new AutomationService(store, { tickMs: 60_000 })
    expect(() => {
      service.start()
      service.stop()
    }).not.toThrow()
  })
})

describe('AutomationService.dispatchAutoRun', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-automations-test-'))
    // Why: do not fake timers here — the dispatch path fires the chain
    // executor's tick asynchronously and we want the real microtask queue to
    // drain so the test can read the final persisted run.
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  const makeChainStep = (): Step => ({
    id: 's1',
    kind: 'wait-for-setup',
    // Why: literal worktreeId (no template) so the runner resolves it without
    // needing any context wiring; with no setup-script registered the runner
    // returns `done` immediately so the run completes in the background.
    config: { worktreeRef: 'wt-stub', requireSuccess: false },
    onFailure: 'halt',
    timeoutSeconds: null
  })

  const makeEvent = (overrides: Partial<CandidateEvent> = {}): CandidateEvent => ({
    entityId: 'iss-1',
    entityIdentifier: 'ORC-1',
    updatedAt: 100,
    fields: {},
    payload: {
      issue: {
        id: 'iss-1',
        identifier: 'ORC-1',
        title: 'A title',
        description: 'desc',
        url: 'https://linear.app/x/ORC-1',
        assigneeEmail: 'me@example.com',
        stateName: 'Todo',
        priority: 2
      }
    },
    ...overrides
  })

  const trigger: AutoTrigger = {
    id: 'at1',
    source: 'linear-issue',
    enabled: true,
    enabledAt: 0,
    rules: []
  }

  it('creates a run with trigger=auto, rule projectId override, and full provenance metadata', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'p1' }))
    store.addRepo(makeRepo({ id: 'p2', path: '/repo2' }))
    const automation = store.createAutomation({
      name: 'Auto chain',
      prompt: '',
      agentId: 'claude',
      projectId: 'p1',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: '',
      dtstart: 0,
      trigger: { kind: 'manual' },
      steps: [makeChainStep()]
    })
    const stored = store.listAutomations().find((entry) => entry.id === automation.id)!

    const service = new AutomationService(store, { tickMs: 60_000 })
    const rule: Rule = { id: 'rl1', projectId: 'p2', conditions: [] }
    await service.dispatchAutoRun({ automation: stored, trigger, rule, event: makeEvent() })

    const runs = store.listAutomationRuns(automation.id)
    expect(runs).toHaveLength(1)
    const [run] = runs
    expect(run.trigger).toBe('auto')
    expect(run.triggerSource).toBe('linear-issue')
    expect(run.triggerAutoTriggerId).toBe('at1')
    expect(run.triggerRuleId).toBe('rl1')
    expect(run.triggerEntityId).toBe('iss-1')
    const automationCtx = run.context?.automation as { projectId: string; workspaceId: unknown }
    expect(automationCtx.projectId).toBe('p2')
    const trigCtx = run.context?.trigger as { linear?: { issue: { identifier: string } } }
    expect(trigCtx.linear?.issue.identifier).toBe('ORC-1')
  })

  it('throws when a linear-issue event has no payload.issue, persists no run', async () => {
    // Why: a linear-issue event without payload.issue is malformed; tolerating
    // it silently created a run with no trigger context that would fail later
    // at template-eval time. Fail fast at dispatch so the engine's per-event
    // catch logs it and the only artifact is the (clearable) dedup row.
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'p1' }))
    const automation = store.createAutomation({
      name: 'Auto chain',
      prompt: '',
      agentId: 'claude',
      projectId: 'p1',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: '',
      dtstart: 0,
      trigger: { kind: 'manual' },
      steps: [makeChainStep()]
    })
    const stored = store.listAutomations().find((entry) => entry.id === automation.id)!

    const service = new AutomationService(store, { tickMs: 60_000 })
    const rule: Rule = { id: 'rl1', projectId: 'p1', conditions: [] }
    await expect(
      service.dispatchAutoRun({
        automation: stored,
        trigger,
        rule,
        event: makeEvent({ payload: {} })
      })
    ).rejects.toThrow(/missing payload\.issue/)

    expect(store.listAutomationRuns(automation.id)).toHaveLength(0)
  })
})
