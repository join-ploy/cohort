import { randomUUID } from 'crypto'
import type { IpcMain, WebContents } from 'electron'
import type { Store } from '../persistence'
import type {
  Automation,
  AutomationDispatchRequest,
  AutomationDispatchResult,
  AutomationRun
} from '../../shared/automations-types'
import type { AgentStatusEntry } from '../agent-status/registry'
import type { SetupScriptEntry } from '../setup-script/registry'
import type { PtyExitEntry } from '../pty/exit-registry'
import { ChainExecutor } from './chain-executor'
import { openPromptPane } from './open-prompt-pane'
import { sendPromptToPane } from './send-prompt-to-pane'
import { openCommandPane } from './open-command-pane'
import { RunPromptRunner } from './runners/run-prompt-runner'
import { WaitForSetupRunner } from './runners/wait-for-setup-runner'
import { RunCommandRunner } from './runners/run-command-runner'
import { CreateWorktreeRunner, type CreateWorktreeDeps } from './runners/create-worktree-runner'
import type { StepRunner } from './step-runner'

const DEFAULT_TICK_MS = 60 * 1000

export type AutomationServiceOpts = {
  tickMs?: number
  /** Reads the main-process agent-status registry by paneKey. Wired in
   *  src/main/index.ts from the singleton AgentStatusRegistry so the chain
   *  executor's RunPromptRunner can poll agent state without an IPC roundtrip. */
  getAgentStatus?: (paneKey: string) => AgentStatusEntry | undefined
  /** Reads the main-process setup-script registry by worktreeId. Wired in
   *  src/main/index.ts from the singleton SetupScriptRegistry so the chain
   *  executor's WaitForSetupRunner (P2.5) can poll setup state without an IPC
   *  roundtrip. */
  getSetupScript?: (worktreeId: string) => SetupScriptEntry | undefined
  /** Reads the main-process PTY exit registry by ptyId. Wired in
   *  src/main/index.ts from the singleton PtyExitRegistry so the chain
   *  executor's RunCommandRunner can detect command completion without an
   *  IPC roundtrip. */
  getPtyExit?: (ptyId: string) => PtyExitEntry | undefined
  /** Subscribe to the main-process PTY data stream. Wired in
   *  src/main/index.ts from `subscribePtyData` in `./ipc/pty` so the chain
   *  executor's RunCommandRunner can capture command `outputTail` directly,
   *  without going through the renderer round-trip. Returns an unsubscribe
   *  function the runner calls on terminal outcomes. */
  subscribePtyData?: (listener: (ptyId: string, data: string) => void) => () => void
  /** Bridge from the chain executor's `create-worktree` step to the OrcaRuntime
   *  managed-worktree create flow. Wired in src/main/index.ts to translate
   *  the runner's narrow shape onto OrcaRuntimeService.createManagedWorktree.
   *  Omitting it makes the runner throw a clear error if a chain tries to
   *  invoke it (unit tests that never exercise `create-worktree` can skip it). */
  createWorktree?: CreateWorktreeDeps['createWorktree']
  /** Lazy accessor for the renderer process. Resolved at call-time on every
   *  runner tick because the BrowserWindow lifecycle is independent of this
   *  service — capturing a WebContents reference eagerly would let the service
   *  hold onto a destroyed window across reload. */
  getWebContents?: () => WebContents | null
  /** Lazy accessor for ipcMain. Wrapped in a factory only so tests can stub
   *  it; in production this returns the singleton from `electron`. */
  getIpcMain?: () => IpcMain
}

export class AutomationService {
  private readonly store: Store
  private readonly tickMs: number
  private readonly getAgentStatus: (paneKey: string) => AgentStatusEntry | undefined
  private readonly getSetupScript: (worktreeId: string) => SetupScriptEntry | undefined
  private readonly getPtyExit: (ptyId: string) => PtyExitEntry | undefined
  private readonly subscribePtyData: (listener: (ptyId: string, data: string) => void) => () => void
  private readonly getWebContents: () => WebContents | null
  private readonly getIpcMain: (() => IpcMain) | null
  private timer: ReturnType<typeof setInterval> | null = null
  private webContents: WebContents | null = null
  private rendererReady = false
  private evaluating = false
  private readonly runPromptRunner: RunPromptRunner
  private readonly waitForSetupRunner: WaitForSetupRunner
  private readonly runCommandRunner: RunCommandRunner
  private readonly createWorktreeRunner: CreateWorktreeRunner
  private readonly chainExecutor: ChainExecutor

  constructor(store: Store, opts: AutomationServiceOpts = {}) {
    this.store = store
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS
    this.getAgentStatus = opts.getAgentStatus ?? (() => undefined)
    this.getSetupScript = opts.getSetupScript ?? (() => undefined)
    this.getPtyExit = opts.getPtyExit ?? (() => undefined)
    // Why: default subscribePtyData to a no-op subscription so service.test.ts
    // harnesses that never exercise run-command steps don't need to wire it.
    // The returned unsubscribe must still be a fn so cleanup() doesn't throw.
    this.subscribePtyData = opts.subscribePtyData ?? (() => () => {})
    // Default getWebContents to the service's own setWebContents-tracked
    // reference so tests that don't supply a factory still get the WebContents
    // through the existing setWebContents() path.
    this.getWebContents = opts.getWebContents ?? (() => this.webContents)
    this.getIpcMain = opts.getIpcMain ?? null

    this.runPromptRunner = new RunPromptRunner({
      openPromptPane: async (params) => {
        const webContents = this.getWebContents()
        if (!webContents || webContents.isDestroyed()) {
          throw new Error('No renderer available to open prompt pane.')
        }
        if (!this.getIpcMain) {
          throw new Error('AutomationService missing getIpcMain wiring.')
        }
        return openPromptPane(params, {
          webContents,
          ipc: this.getIpcMain(),
          requestId: randomUUID()
        })
      },
      // Why: closure mirrors openPromptPane — resolve renderer/ipc lazily so
      // a reload swap is picked up on the next tick. A destroyed/null
      // webContents throws a plain Error (transient) which the runner lets
      // bubble for retry, while deterministic renderer rejections come back
      // as SendPromptToPaneError and fail-fast inside the runner.
      sendPromptToPane: async (params) => {
        const webContents = this.getWebContents()
        if (!webContents || webContents.isDestroyed()) {
          throw new Error('No renderer available to send prompt to pane.')
        }
        if (!this.getIpcMain) {
          throw new Error('AutomationService missing getIpcMain wiring.')
        }
        return sendPromptToPane(params, {
          webContents,
          ipc: this.getIpcMain(),
          requestId: randomUUID()
        })
      },
      getAgentStatus: this.getAgentStatus,
      now: () => Date.now()
    })

    this.waitForSetupRunner = new WaitForSetupRunner({
      getSetupScript: this.getSetupScript,
      now: () => Date.now()
    })

    this.runCommandRunner = new RunCommandRunner({
      openCommandPane: async (params) => {
        const webContents = this.getWebContents()
        if (!webContents || webContents.isDestroyed()) {
          throw new Error('No renderer available to open command pane.')
        }
        if (!this.getIpcMain) {
          throw new Error('AutomationService missing getIpcMain wiring.')
        }
        return openCommandPane(params, {
          webContents,
          ipc: this.getIpcMain(),
          requestId: randomUUID()
        })
      },
      getPtyExit: this.getPtyExit,
      subscribePtyData: this.subscribePtyData,
      now: () => Date.now()
    })

    // Why: when `createWorktree` isn't wired (e.g. service.test.ts harnesses
    // that never exercise create-worktree steps), surface a clear error if a
    // chain ever invokes the runner instead of silently passing `undefined`
    // down to the runtime and producing a confusing TypeError mid-tick.
    const createWorktreeDep: CreateWorktreeDeps['createWorktree'] =
      opts.createWorktree ??
      (() => {
        throw new Error(
          'AutomationService: createWorktree dep not wired (cannot run create-worktree steps).'
        )
      })
    this.createWorktreeRunner = new CreateWorktreeRunner({
      createWorktree: createWorktreeDep,
      now: () => Date.now()
    })

    this.chainExecutor = new ChainExecutor({
      getRunner: (kind) => this.resolveRunner(kind),
      persistRun: (run) => {
        this.store.replaceAutomationRun(run)
      },
      now: () => Date.now()
    })
  }

  setWebContents(webContents: WebContents | null): void {
    this.webContents = webContents
    this.rendererReady = false
  }

  setRendererReady(): void {
    this.rendererReady = true
    void this.evaluateDueRuns()
  }

  start(): void {
    if (this.timer) {
      return
    }
    this.timer = setInterval(() => {
      void this.evaluateDueRuns()
    }, this.tickMs)
    if (this.rendererReady) {
      void this.evaluateDueRuns()
    }
  }

  stop(): void {
    if (!this.timer) {
      return
    }
    clearInterval(this.timer)
    this.timer = null
  }

  async runNow(automationId: string): Promise<AutomationRun> {
    const automation = this.store.listAutomations().find((entry) => entry.id === automationId)
    if (!automation) {
      throw new Error('Automation not found.')
    }
    // Chain-shape automation: seed the run as `running` with an empty
    // stepStates array and tick the executor once immediately so the UI sees
    // progress without waiting a full tick cadence. Subsequent ticks fall
    // through the normal 60s evaluateDueRuns() loop.
    if (automation.trigger && automation.steps && automation.steps.length > 0) {
      const run = this.store.createAutomationRun(automation, Date.now(), 'manual')
      run.status = 'running'
      // Seed the chain context with automation metadata so templates like
      // `{{automation.workspaceId}}` resolve on the very first tick, and so
      // CreateWorktreeRunner can pick up the target repo from
      // `context.automation.projectId` (it's the only path it knows to look at).
      run.context = {
        automation: {
          workspaceId: automation.workspaceId,
          projectId: automation.projectId
        }
      }
      run.stepStates = []
      this.store.replaceAutomationRun(run)
      try {
        await this.chainExecutor.tick(automation, run)
      } catch (e) {
        // Why: a synchronous tick failure on the manual-run path must not
        // bubble up as an unhandled IPC rejection. Finalize the run the same
        // way tickRunningChains() does so the operator sees a `failed` row
        // with a real error message instead of a phantom `running` row.
        this.finalizeFailedRun(run, e)
      }
      return this.store.getAutomationRun(run.id) ?? run
    }
    // Legacy automation: same dispatch flow as scheduled runs.
    const run = this.store.createAutomationRun(automation, Date.now(), 'manual')
    await this.requestDispatch(automation, run)
    return run
  }

  markDispatchResult(result: AutomationDispatchResult): AutomationRun {
    return this.store.updateAutomationRun(result)
  }

  private resolveRunner(kind: string): StepRunner | undefined {
    if (kind === 'run-prompt') {
      return this.runPromptRunner
    }
    if (kind === 'wait-for-setup') {
      return this.waitForSetupRunner
    }
    if (kind === 'run-command') {
      return this.runCommandRunner
    }
    if (kind === 'create-worktree') {
      return this.createWorktreeRunner
    }
    return undefined
  }

  private async evaluateDueRuns(): Promise<void> {
    if (this.evaluating) {
      return
    }
    this.evaluating = true
    try {
      const now = Date.now()
      for (const automation of this.store.listAutomations()) {
        if (!automation.enabled || automation.nextRunAt > now) {
          continue
        }
        await this.evaluateAutomation(automation, now)
      }
      await this.tickRunningChains()
    } finally {
      this.evaluating = false
    }
  }

  /** Drive every in-progress chain run forward by one runner tick. Runs in
   *  series so a buggy runner can't pile up concurrent ticks against the
   *  same registry/renderer; chain execution is inherently low-volume
   *  (one tick per ~minute per run). */
  private async tickRunningChains(): Promise<void> {
    const automations = new Map(this.store.listAutomations().map((a) => [a.id, a]))
    for (const run of this.store.listAutomationRuns()) {
      if (run.status !== 'running') {
        continue
      }
      const automation = automations.get(run.automationId)
      if (!automation) {
        continue
      }
      try {
        await this.chainExecutor.tick(automation, run)
      } catch (e) {
        // Why: an unhandled runner error must not poison the tick loop for
        // every other run. Mark this run failed and persist so the operator
        // sees the error instead of an indefinite `running` row.
        this.finalizeFailedRun(run, e)
      }
    }
  }

  /** Mark a run failed in response to a tick-time error and finalize any
   *  trailing non-terminal step states so the UI never shows an indefinitely
   *  "running" step under a failed run. Shared between the manual `runNow`
   *  path and the scheduled `tickRunningChains` loop so both follow the same
   *  cleanup contract. */
  private finalizeFailedRun(run: AutomationRun, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const now = Date.now()
    if (run.stepStates) {
      for (const state of run.stepStates) {
        if (state.status === 'running' || state.status === 'pending') {
          state.status = 'failed'
          state.finishedAt = now
          state.error = state.error ?? errorMessage
        }
      }
    }
    run.status = 'failed'
    run.error = errorMessage
    run.finishedAt = now
    this.store.replaceAutomationRun(run)
  }

  private async evaluateAutomation(automation: Automation, now: number): Promise<void> {
    const scheduledFor = this.store.getLatestAutomationOccurrence(automation, now)
    if (scheduledFor === null) {
      this.store.advanceAutomationNextRun(automation.id, now)
      return
    }
    const run = this.store.createAutomationRun(automation, scheduledFor)
    const graceMs = automation.missedRunGraceMinutes * 60 * 1000
    if (now - scheduledFor > graceMs) {
      this.store.updateAutomationRun({
        runId: run.id,
        status: 'skipped_missed',
        workspaceId: automation.workspaceId,
        error: 'Orca was unavailable during the missed-run grace window.'
      })
      this.store.advanceAutomationNextRun(automation.id, now)
      return
    }

    await this.requestDispatch(automation, run)
    this.store.advanceAutomationNextRun(automation.id, now)
  }

  private async requestDispatch(automation: Automation, run: AutomationRun): Promise<void> {
    const webContents = this.webContents
    if (!webContents || webContents.isDestroyed() || !this.rendererReady) {
      this.store.updateAutomationRun({
        runId: run.id,
        status: 'skipped_unavailable',
        workspaceId: automation.workspaceId,
        error: 'No Orca window was available to launch the automation.'
      })
      return
    }
    this.store.updateAutomationRun({
      runId: run.id,
      status: 'dispatching',
      workspaceId: automation.workspaceId,
      error: null
    })
    const payload: AutomationDispatchRequest = { automation, run }
    webContents.send('automations:dispatchRequested', payload)
  }
}
