import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Repo } from '../../shared/types'
import type { AutoTrigger, Rule, Step } from '../../shared/automations-types'
import type { CandidateEvent } from './trigger-sources/types'
import { AutomationService } from './service'
import { HttpRequestRunner } from './runners/http-request-runner'

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

  it('continues ticking a waiting chain run', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:59:00'))
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Waiting chain',
      prompt: 'Do the thing',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2030-01-01T00:00:00').getTime()
    })
    const unknownKindStep: Step = {
      id: 's1',
      kind: 'definitely-not-a-real-kind' as unknown as Step['kind'],
      config: { worktreeRef: 'wt1', agentId: 'claude', prompt: 'go', doneDebounceSeconds: 15 },
      onFailure: 'halt',
      timeoutSeconds: null
    }
    const stored = store.listAutomations().find((entry) => entry.id === automation.id)!
    stored.trigger = { kind: 'manual' }
    stored.steps = [unknownKindStep]

    const run = store.createAutomationRun(stored, Date.now(), 'manual')
    run.status = 'waiting'
    run.stepStates = [
      {
        stepId: 's1',
        status: 'waiting',
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
    await vi.waitFor(() => {
      const after = store.listAutomationRuns(stored.id)[0]
      expect(after?.status).toBe('failed')
    })

    const after = store.listAutomationRuns(stored.id)[0]
    expect(after?.error).toMatch(/no runner registered/i)
    expect(after?.stepStates?.[0].status).toBe('failed')
  })

  it('runNow accepts an automation with empty projectId (group-target chain)', async () => {
    // Why: chains that respond by creating a workspace group derive their
    // repo context from the group's members, not the upfront automation
    // projectId. The dispatcher must not refuse to run them.
    vi.setSystemTime(new Date('2026-05-13T09:00:00'))
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'r1' }))
    store.addRepo(makeRepo({ id: 'r2', path: '/repo2' }))
    const automation = store.createAutomation({
      name: 'Group chain',
      prompt: '',
      agentId: 'claude',
      projectId: '',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: '',
      dtstart: 0,
      trigger: { kind: 'manual' },
      steps: [
        // Use a fake-kind step so the chain dispatch path itself executes
        // and we can assert the run was created with the correct context;
        // the trailing failure (no runner) is incidental to what we're
        // verifying.
        {
          id: 's1',
          kind: 'definitely-not-a-real-kind' as unknown as Step['kind'],
          config: {} as never,
          onFailure: 'halt',
          timeoutSeconds: null
        }
      ]
    })
    const stored = store.listAutomations().find((entry) => entry.id === automation.id)!
    expect(stored.projectId).toBe('')
    const service = new AutomationService(store, { tickMs: 60_000 })
    // dispatchRun must not throw on empty projectId at the boundary.
    const run = await service.runNow(automation.id)
    expect(run).toBeDefined()
    const ctx = run.context as { automation?: { projectId?: string } } | undefined
    expect(ctx?.automation?.projectId).toBe('')
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

  it('github-pr: sets projectId from event.repoId and injects trigger.github.pr', async () => {
    const store = await createStore()
    // The PR's own repo (r1, from event.repoId) is the run target. rule.projectId
    // is some OTHER repo to prove the github-pr path ignores it.
    store.addRepo(makeRepo({ id: 'r1' }))
    store.addRepo(makeRepo({ id: 'other', path: '/other' }))
    const automation = store.createAutomation({
      name: 'Auto chain',
      prompt: '',
      agentId: 'claude',
      projectId: 'other',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: '',
      dtstart: 0,
      trigger: { kind: 'manual' },
      steps: [makeChainStep()]
    })
    const stored = store.listAutomations().find((entry) => entry.id === automation.id)!

    const service = new AutomationService(store, { tickMs: 60_000 })
    const prTrigger: AutoTrigger = {
      id: 'at1',
      source: 'github-pr',
      enabled: true,
      enabledAt: 0,
      rules: [],
      repoIds: ['r1']
    }
    const rule: Rule = { id: 'rl1', projectId: 'other', conditions: [] }
    await service.dispatchAutoRun({
      automation: stored,
      trigger: prTrigger,
      rule,
      event: {
        entityId: 'r1#7',
        updatedAt: 100,
        fields: {},
        repoId: 'r1',
        payload: {
          pr: {
            number: 7,
            title: 'T',
            url: 'u',
            headRef: 'h',
            baseRef: 'b',
            author: 'a',
            isCrossRepository: false,
            repoId: 'r1'
          }
        }
      }
    })

    const runs = store.listAutomationRuns(automation.id)
    expect(runs).toHaveLength(1)
    const [run] = runs
    const automationCtx = run.context?.automation as { projectId: string }
    expect(automationCtx.projectId).toBe('r1')
    const trigCtx = run.context?.trigger as { github?: { pr: { number: number } } }
    expect(trigCtx.github?.pr.number).toBe(7)
  })

  it('http-endpoint: targets rule.projectId and seeds trigger.http from event.payload', async () => {
    const store = await createStore()
    // rule.projectId (p2) differs from automation.projectId (p1) to prove the
    // http-endpoint path targets the rule's project.
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
    const httpTrigger: AutoTrigger = {
      id: 'at1',
      source: 'http-endpoint',
      enabled: true,
      enabledAt: 0,
      rules: []
    }
    const rule: Rule = { id: 'rl1', projectId: 'p2', conditions: [] }
    await service.dispatchAutoRun({
      automation: stored,
      trigger: httpTrigger,
      rule,
      // event.payload is the mapped-variables object → becomes trigger.http.
      event: {
        entityId: '7',
        updatedAt: 100,
        fields: { id: 7, title: 'Widget' },
        payload: { id: 7, title: 'Widget' }
      }
    })

    const runs = store.listAutomationRuns(automation.id)
    expect(runs).toHaveLength(1)
    const [run] = runs
    expect(run.triggerSource).toBe('http-endpoint')
    expect(run.triggerEntityId).toBe('7')
    const automationCtx = run.context?.automation as { projectId: string }
    expect(automationCtx.projectId).toBe('p2')
    const trigCtx = run.context?.trigger as { http?: Record<string, unknown> }
    expect(trigCtx.http).toEqual({ id: 7, title: 'Widget' })
  })

  it('schedule: targets the automation project and seeds trigger.schedule from the fire event', async () => {
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
    const scheduleTrigger: AutoTrigger = {
      id: 'at1',
      source: 'schedule',
      enabled: true,
      enabledAt: 0,
      rules: [],
      schedule: { cron: '0 9 * * *', timezone: 'UTC' }
    }
    // The implicit rule carries automation.projectId — schedule has no external
    // entity, so the run targets the automation's project.
    const rule: Rule = { id: 'implicit', conditions: [], projectId: 'p1' }
    const scheduledFor = Date.UTC(2026, 5, 7, 9, 0, 0)
    const event: CandidateEvent = {
      entityId: new Date(scheduledFor).toISOString(),
      updatedAt: scheduledFor,
      payload: {
        schedule: { firedAt: scheduledFor + 500, scheduledFor, cron: '0 9 * * *', timezone: 'UTC' }
      },
      fields: {}
    }
    await service.dispatchAutoRun({ automation: stored, trigger: scheduleTrigger, rule, event })

    const runs = store.listAutomationRuns(automation.id)
    expect(runs).toHaveLength(1)
    const [run] = runs
    expect(run.triggerSource).toBe('schedule')
    expect(run.triggerEntityId).toBe(event.entityId)
    const automationCtx = run.context?.automation as { projectId: string }
    expect(automationCtx.projectId).toBe('p1')
    const trigCtx = run.context?.trigger as {
      schedule?: { firedAt: number; scheduledFor: number; cron: string; timezone: string }
    }
    expect(trigCtx.schedule).toEqual(event.payload.schedule)
  })
})

describe('AutomationService.restartRun', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-automations-test-'))
    // Why: fake timers let us advance the clock between the prior run's
    // creation and the restart, so `createAutomationRun`'s
    // (automationId, scheduledFor) dedup gate doesn't return the prior row
    // when both are created within the same millisecond.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-13T08:59:00'))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  const makeChainStep = (): Step => ({
    id: 's1',
    kind: 'wait-for-setup',
    config: { worktreeRef: 'wt-stub', requireSuccess: false },
    onFailure: 'halt',
    timeoutSeconds: null
  })

  const linearIssue = (overrides: Partial<{ id: string; identifier: string }> = {}) => ({
    id: 'iss-1',
    identifier: 'ORC-1',
    title: 'A title',
    description: 'desc',
    url: 'https://linear.app/x/ORC-1',
    assigneeEmail: 'me@example.com',
    stateName: 'Todo',
    priority: 2,
    ...overrides
  })

  async function seedAutomationWithFailedAutoRun(): Promise<{
    store: Awaited<ReturnType<typeof createStore>>
    service: AutomationService
    automationId: string
    priorId: string
  }> {
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
    const prior = store.createAutomationRun(stored, Date.now(), 'auto', {
      triggerSource: 'linear-issue',
      triggerAutoTriggerId: 'at1',
      triggerRuleId: 'rl1',
      triggerEntityId: 'iss-1'
    })
    prior.status = 'failed'
    prior.context = {
      automation: { workspaceId: null, projectId: stored.projectId },
      trigger: { linear: { issue: linearIssue() } }
    }
    store.replaceAutomationRun(prior)
    return { store, service, automationId: automation.id, priorId: prior.id }
  }

  it('happy path: creates a new run with inherited trigger metadata + restartedFromRunId', async () => {
    const { store, service, priorId } = await seedAutomationWithFailedAutoRun()
    // Advance the clock so the new run's `scheduledFor` differs from the
    // prior's — otherwise `createAutomationRun` would dedup back to prior.
    vi.advanceTimersByTime(1000)
    const restarted = await service.restartRun(priorId)
    expect(restarted.id).not.toBe(priorId)
    expect(restarted.trigger).toBe('auto')
    expect(restarted.triggerSource).toBe('linear-issue')
    expect(restarted.triggerAutoTriggerId).toBe('at1')
    expect(restarted.triggerRuleId).toBe('rl1')
    expect(restarted.triggerEntityId).toBe('iss-1')
    expect(restarted.restartedFromRunId).toBe(priorId)
    // Linear issue payload carried over into the new run's context.
    const trigCtx = restarted.context?.trigger as { linear?: { issue: { identifier: string } } }
    expect(trigCtx.linear?.issue.identifier).toBe('ORC-1')
    // The original run is unchanged.
    const reloaded = store.getAutomationRun(priorId)
    expect(reloaded?.status).toBe('failed')
  })

  it('does NOT insert a dedup row on restart', async () => {
    const { store, service, automationId, priorId } = await seedAutomationWithFailedAutoRun()
    vi.advanceTimersByTime(1000)
    await service.restartRun(priorId)
    expect(store.listAutomationAutoDedup(automationId, 'at1')).toEqual([])
  })

  it('throws on non-restartable status', async () => {
    const { store, service, priorId } = await seedAutomationWithFailedAutoRun()
    const prior = store.getAutomationRun(priorId)!
    prior.status = 'completed'
    store.replaceAutomationRun(prior)
    await expect(service.restartRun(priorId)).rejects.toThrow(/not restartable/)
  })

  it('throws when run does not exist', async () => {
    const store = await createStore()
    const service = new AutomationService(store, { tickMs: 60_000 })
    await expect(service.restartRun('nonexistent-id')).rejects.toThrow(/not found/)
  })

  it('throws when automation has been deleted', async () => {
    const { store, service, automationId, priorId } = await seedAutomationWithFailedAutoRun()
    // Why: deleteAutomation cascades to runs, but here we need the run row to
    // survive so restartRun reaches the "automation no longer exists" branch
    // — exercise the lookup-failure path by orphaning the run instead.
    const prior = store.getAutomationRun(priorId)!
    prior.automationId = 'deleted-automation-id'
    store.replaceAutomationRun(prior)
    expect(store.listAutomations().find((a) => a.id === automationId)).toBeTruthy()
    await expect(service.restartRun(priorId)).rejects.toThrow(/no longer exists/)
  })

  it('restart of a manual run preserves manual payload', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'p1' }))
    const automation = store.createAutomation({
      name: 'Manual chain',
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
    const prior = store.createAutomationRun(stored, Date.now(), 'manual')
    prior.status = 'failed'
    prior.context = {
      automation: { workspaceId: null, projectId: stored.projectId },
      trigger: { linear: { issue: linearIssue({ id: 'iss-2', identifier: 'ORC-2' }) } }
    }
    store.replaceAutomationRun(prior)
    vi.advanceTimersByTime(1000)
    const restarted = await service.restartRun(prior.id)
    expect(restarted.trigger).toBe('manual')
    expect(restarted.triggerSource).toBeUndefined()
    expect(restarted.triggerAutoTriggerId).toBeUndefined()
    expect(restarted.restartedFromRunId).toBe(prior.id)
    const trigCtx = restarted.context?.trigger as { linear?: { issue: { identifier: string } } }
    expect(trigCtx.linear?.issue.identifier).toBe('ORC-2')
  })
})

describe('AutomationService retry persisted-pane cleanup', () => {
  // Why: regression for the "in-memory tracker map cleared by restart, retry
  // leaves old tabs alive" bug. The runner stamps state.openedPane on the
  // open-pane tick; the chain executor persists it. Retry must close those
  // panes via the IPC even when the runner has zero in-memory trackers
  // (simulated here by constructing a fresh service that never ticked).
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-automations-test-'))
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-13T09:00:00'))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  const parallelStep = (id: string): Step => ({
    id,
    kind: 'run-prompt',
    config: { worktreeRef: 'wt-1', agentId: 'claude', prompt: 'go', doneDebounceSeconds: 15 },
    onFailure: 'halt',
    timeoutSeconds: null
  })

  it('retryRunFromStep fires closePromptPane for every persisted self-opened pane', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'p1' }))
    const automation = store.createAutomation({
      name: 'Parallel chain',
      prompt: '',
      agentId: 'claude',
      projectId: 'p1',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: '',
      dtstart: 0,
      trigger: { kind: 'manual' },
      steps: [[parallelStep('a'), parallelStep('b'), parallelStep('c')]]
    })
    const stored = store.listAutomations().find((entry) => entry.id === automation.id)!
    const run = store.createAutomationRun(stored, Date.now(), 'manual')
    run.status = 'failed'
    run.stepStates = [
      {
        stepId: 'a',
        status: 'failed',
        startedAt: 0,
        finishedAt: 1,
        output: null,
        error: 'boom',
        openedPane: { paneKey: 'tab-A:pane-1', selfOpenedPane: true }
      },
      {
        stepId: 'b',
        status: 'succeeded',
        startedAt: 0,
        finishedAt: 1,
        output: { paneKey: 'tab-B:pane-1' },
        error: null,
        openedPane: { paneKey: 'tab-B:pane-1', selfOpenedPane: true }
      },
      {
        stepId: 'c',
        status: 'failed',
        startedAt: 0,
        finishedAt: 1,
        output: null,
        error: 'boom',
        // paneRef-attached pane — must NOT be closed (upstream owns it).
        openedPane: { paneKey: 'tab-UPSTREAM:pane-1', selfOpenedPane: false }
      }
    ]
    store.replaceAutomationRun(run)

    const send = vi.fn()
    const service = new AutomationService(store, { tickMs: 60_000 })
    service.setWebContents({ isDestroyed: () => false, send } as never)

    // Retry the entire parallel group (its first sibling sits at flat index 0).
    const result = service.retryRunFromStep(run.id, 0)
    expect(result).toBeTruthy()

    const closeCalls = send.mock.calls.filter((c) => c[0] === 'automations:closePromptPane')
    const closedPaneKeys = closeCalls.map((c) => (c[1] as { paneKey: string }).paneKey)
    expect(closedPaneKeys).toEqual(expect.arrayContaining(['tab-A:pane-1', 'tab-B:pane-1']))
    expect(closedPaneKeys).not.toContain('tab-UPSTREAM:pane-1')
  })

  it('retryParallelStep fires closePromptPane for the targeted sibling even after restart', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'p1' }))
    const automation = store.createAutomation({
      name: 'Parallel chain',
      prompt: '',
      agentId: 'claude',
      projectId: 'p1',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: '',
      dtstart: 0,
      trigger: { kind: 'manual' },
      steps: [[parallelStep('a'), parallelStep('b')]]
    })
    const stored = store.listAutomations().find((entry) => entry.id === automation.id)!
    const run = store.createAutomationRun(stored, Date.now(), 'manual')
    run.status = 'failed'
    run.stepStates = [
      {
        stepId: 'a',
        status: 'failed',
        startedAt: 0,
        finishedAt: 1,
        output: null,
        error: 'boom',
        openedPane: { paneKey: 'tab-A:pane-1', selfOpenedPane: true }
      },
      {
        stepId: 'b',
        status: 'succeeded',
        startedAt: 0,
        finishedAt: 1,
        output: { paneKey: 'tab-B:pane-1' },
        error: null,
        openedPane: { paneKey: 'tab-B:pane-1', selfOpenedPane: true }
      }
    ]
    store.replaceAutomationRun(run)

    const send = vi.fn()
    const service = new AutomationService(store, { tickMs: 60_000 })
    service.setWebContents({ isDestroyed: () => false, send } as never)

    service.retryParallelStep(run.id, 'a')
    const closeCalls = send.mock.calls.filter((c) => c[0] === 'automations:closePromptPane')
    const closedPaneKeys = closeCalls.map((c) => (c[1] as { paneKey: string }).paneKey)
    expect(closedPaneKeys).toContain('tab-A:pane-1')
    // Sibling 'b' is not being retried — its pane must stay alive.
    expect(closedPaneKeys).not.toContain('tab-B:pane-1')
  })

  it('resolves the http-request step kind to the HttpRequestRunner', async () => {
    const store = await createStore()
    const service = new AutomationService(store, { tickMs: 60_000 })
    const runner = (service as unknown as { resolveRunner(kind: string): unknown }).resolveRunner(
      'http-request'
    )
    expect(runner).toBeInstanceOf(HttpRequestRunner)
  })
})
