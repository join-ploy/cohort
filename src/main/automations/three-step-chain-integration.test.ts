import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Repo } from '../../shared/types'
import type { Step } from '../../shared/automations-types'
import type { AgentStatusEntry } from '../agent-status/registry'
import type { SetupScriptEntry } from '../setup-script/registry'
import { AutomationService } from './service'

// Mirror run-now-chain-integration.test.ts: stub Electron + git so the real
// Store can build against a tmp userData dir without booting Electron, and
// drive the three-step chain through the public service surface.
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
 * register a `once` listener on. Replies are driven synchronously by invoking
 * the registered handler when the renderer's `send(...)` is observed.
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

describe('3-step chain integration (create-worktree → wait-for-setup → run-prompt)', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-3-step-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('drives create-worktree → wait-for-setup → run-prompt to completion', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    // Build the automation row, then mutate in place to attach the
    // chain-shape `trigger` + `steps` fields (the store's createAutomation
    // input shape predates the chain migration).
    const automation = store.createAutomation({
      name: '3-step chain',
      prompt: '(ignored — chain overrides)',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      // Why: dtstart far in the future so the scheduled-run path never fires
      // and races the manual runNow path under test.
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2030-01-01T00:00:00').getTime()
    })
    const stored = store.listAutomations().find((entry) => entry.id === automation.id)!
    stored.trigger = { kind: 'manual' }
    const steps: Step[] = [
      {
        id: 'cw1',
        kind: 'create-worktree',
        config: {
          baseBranch: 'main',
          branchName: 'feature/integration',
          displayName: 'Integration test',
          linkLinearIssue: false
        },
        onFailure: 'halt',
        timeoutSeconds: null
      },
      {
        id: 'wfs1',
        kind: 'wait-for-setup',
        config: {
          // Why: cw1 published worktreeId into ctx.steps.cw1; downstream steps
          // reference it via this template path.
          worktreeRef: '{{steps.cw1.worktreeId}}',
          requireSuccess: true
        },
        onFailure: 'halt',
        timeoutSeconds: null
      },
      {
        id: 'rp1',
        kind: 'run-prompt',
        config: {
          worktreeRef: '{{steps.cw1.worktreeId}}',
          agentId: 'claude',
          prompt: 'go',
          // Why: 0s debounce so a single `done` ping immediately satisfies
          // the gate — keeps the test deterministic without juggling clocks.
          doneDebounceSeconds: 0
        },
        onFailure: 'halt',
        timeoutSeconds: null
      }
    ]
    stored.steps = steps

    const { ipc, listeners } = makeFakeIpc()
    const send = vi.fn((channel: string, payload?: { requestId?: string }) => {
      // Why: the service also broadcasts `automations:changed` with no
      // payload — ignore non-pane channels so the mock doesn't crash.
      if (channel !== 'automations:openPromptPane' || !payload?.requestId) {
        return
      }
      const replyChannel = `automations:openPromptPane:reply:${payload.requestId}`
      listeners.get(replyChannel)?.({}, { ok: true, paneKey: 'tab-1:1' })
    })

    const createWorktree = vi.fn().mockResolvedValue({
      worktreeId: 'wt-created',
      path: '/repo/wt-created',
      branch: 'feature/integration'
    })

    // Why: return `exited-success` immediately. The runner's contract is to
    // short-circuit when state is `exited-success`, so a single-tick wait is
    // sufficient. (Returning undefined would also pass via the missing-entry
    // fast path, but emitting a real entry exercises the success branch.)
    const setupEntry: SetupScriptEntry = {
      state: 'exited-success',
      exitCode: 0,
      startedAt: 100,
      finishedAt: 300
    }
    const getSetupScript = vi.fn().mockReturnValue(setupEntry)

    // Why: agent-status timeline — first lookup after pane open returns
    // undefined (renderer hasn't yet pinged), then `done` so the run-prompt
    // step's 0s debounce satisfies on the following tick.
    let agentCalls = 0
    const getAgentStatus = (_paneKey: string): AgentStatusEntry | undefined => {
      agentCalls++
      if (agentCalls === 1) {
        return undefined
      }
      return { state: 'done', updatedAt: Date.now() }
    }

    const service = new AutomationService(store, {
      tickMs: 10,
      createWorktree,
      getSetupScript,
      getAgentStatus,
      // Unused in this test (no run-command step), but spelled out so the
      // service constructor sees a fully-wired dep set.
      getPtyExit: () => undefined,
      getIpcMain: () => ipc as never
    })
    service.setWebContents({ isDestroyed: () => false, send } as never)
    service.setRendererReady()

    const initial = await service.runNow(automation.id)
    expect(initial.status).toBe('running')

    service.start()
    try {
      await vi.waitFor(
        () => {
          const persisted = store.getAutomationRun(initial.id)
          expect(persisted?.status === 'completed' || persisted?.status === 'failed').toBe(true)
        },
        { timeout: 5_000, interval: 25 }
      )
    } finally {
      service.stop()
    }

    const final = store.getAutomationRun(initial.id)
    expect(final?.status).toBe('completed')
    expect(final?.stepStates).toHaveLength(3)
    expect(final?.stepStates?.[0]).toMatchObject({ stepId: 'cw1', status: 'succeeded' })
    expect(final?.stepStates?.[1]).toMatchObject({ stepId: 'wfs1', status: 'succeeded' })
    expect(final?.stepStates?.[2]).toMatchObject({ stepId: 'rp1', status: 'succeeded' })

    // create-worktree pushed its tracker into context.steps.cw1 — verify it
    // landed verbatim so downstream template resolutions worked off real data.
    const cw1Output = (final?.context as { steps?: { cw1?: unknown } } | undefined)?.steps?.cw1
    expect(cw1Output).toMatchObject({
      worktreeId: 'wt-created',
      path: '/repo/wt-created',
      branch: 'feature/integration'
    })

    // External side effects fired exactly once each.
    expect(createWorktree).toHaveBeenCalledTimes(1)
    expect(createWorktree).toHaveBeenCalledWith({
      repoId: 'r1',
      baseBranch: 'main',
      branchName: 'feature/integration',
      displayName: 'Integration test',
      linkedIssue: null,
      createdByAutomationRunId: initial.id
    })
    // openPromptPane fired exactly once (the run-prompt step), addressed at
    // the worktreeId published by create-worktree.
    const promptCalls = send.mock.calls.filter((c) => c[0] === 'automations:openPromptPane')
    expect(promptCalls).toHaveLength(1)
    expect(promptCalls[0][1]).toMatchObject({
      worktreeId: 'wt-created',
      agentId: 'claude',
      prompt: 'go'
    })
    // wait-for-setup polled the registry against the resolved worktreeId.
    expect(getSetupScript).toHaveBeenCalledWith('wt-created')
  })
})
