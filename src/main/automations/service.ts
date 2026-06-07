import { randomUUID } from 'crypto'
import type { IpcMain, WebContents } from 'electron'
import type { Store } from '../persistence'
import type {
  Automation,
  AutomationDispatchRequest,
  AutomationDispatchResult,
  AutomationRun,
  AutomationRunStatus,
  AutomationRunTrigger,
  AutoTrigger,
  GithubPrPayload,
  LinearIssuePayload,
  Rule,
  RunNowPayload,
  Step,
  StepOrGroup,
  StepRunState,
  TriggerSourceId
} from '../../shared/automations-types'
import type { TuiAgent } from '../../shared/types'
import type { CandidateEvent } from './trigger-sources/types'
import type { AgentStatusEntry } from '../agent-status/registry'
import type { SetupScriptEntry } from '../setup-script/registry'
import type { PtyExitEntry } from '../pty/exit-registry'
import { ChainExecutor } from './chain-executor'
import { openPromptPane } from './open-prompt-pane'
import { closePromptPane } from './close-prompt-pane'
import { sendPromptToPane } from './send-prompt-to-pane'
import { openCommandPane } from './open-command-pane'
import { sendCommandToPane } from './send-command-to-pane'
import { RunPromptRunner } from './runners/run-prompt-runner'
import { WaitForSetupRunner } from './runners/wait-for-setup-runner'
import { RunCommandRunner } from './runners/run-command-runner'
import { CreateWorktreeRunner, type CreateWorktreeDeps } from './runners/create-worktree-runner'
import {
  CreateWorkspaceGroupRunner,
  type CreateWorkspaceGroupDeps
} from './runners/create-workspace-group-runner'
import { UpdateLinearIssueRunner } from './runners/update-linear-issue-runner'
import { CollectCiResultsRunner } from './runners/collect-ci-results-runner'
import { HttpRequestRunner } from './runners/http-request-runner'
import { updateIssue as linearUpdateIssue } from '../linear/issues'
import { getPRChecks, getPRComments, getPRForBranch } from '../github/client'
import { gitExecFileAsync } from '../github/gh-utils'
import type { StepRunner } from './step-runner'
import { splitWorktreeId } from '../../shared/worktree-id'
import { hasPromptTargetChangesFromMain } from './prompt-target-main-changes'
import { inferSidebarPromptAgent } from '../../shared/sidebar-prompt-agent'
import { getEffectiveHooks } from '../hooks'
import { maskAutoTriggers } from './http-endpoint-secrets'

// Why: duplicated from renderer's chain-editor-state because that module is
// renderer-only. Kept inline to avoid a new shared runtime file for a one-liner.
function flattenSteps(steps: StepOrGroup[]): Step[] {
  const result: Step[] = []
  for (const item of steps) {
    if (Array.isArray(item)) {
      result.push(...item)
    } else {
      result.push(item)
    }
  }
  return result
}

const DEFAULT_TICK_MS = 60 * 1000
const DEFAULT_AUTO_TRIGGER_POLL_SECONDS = 60

function isActiveChainRunStatus(status: AutomationRunStatus): boolean {
  return status === 'running' || status === 'waiting'
}

// Why: structural type lets service.test.ts pass a tiny stub without depending
// on the concrete AutoTriggerEngine class, keeping the engine an optional dep.
type AutoTriggerEngineLike = {
  start: (intervalMs: number) => void
  stop: () => void
  getPollStatus?: () => Map<TriggerSourceId, { lastPollAt: number; intervalMs: number }>
}

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
  /** Resolve a paneKey to its current ptyId. Wired from
   *  `getPtyIdForPaneKey` in `./ipc/pty` so RunPromptRunner can subscribe to
   *  the prompt pane's data stream and capture the agent's last-turn output
   *  for templating downstream. */
  getPtyIdForPaneKey?: (paneKey: string) => string | undefined
  /** Bridge from the chain executor's `create-worktree` step to the OrcaRuntime
   *  managed-worktree create flow. Wired in src/main/index.ts to translate
   *  the runner's narrow shape onto OrcaRuntimeService.createManagedWorktree.
   *  Omitting it makes the runner throw a clear error if a chain tries to
   *  invoke it (unit tests that never exercise `create-worktree` can skip it). */
  createWorktree?: CreateWorktreeDeps['createWorktree']
  /** Bridge from a pull-request-mode `create-worktree` step to the Start-from-PR
   *  (fork-aware) checkout flow. Wired in src/main/index.ts. Omitting it makes
   *  the runner throw if a chain hits a PR-mode step — same shape as
   *  `createWorktree` above. */
  createWorktreeFromPr?: CreateWorktreeDeps['createWorktreeFromPr']
  /** Bridge from the chain executor's `create-workspace-group` step to the
   *  workspace-groups:create flow. Wired in src/main/index.ts. Omitting it
   *  makes the runner throw if a chain ever tries to invoke it — same shape
   *  as `createWorktree` above. */
  createWorkspaceGroup?: CreateWorkspaceGroupDeps['createWorkspaceGroup']
  /** Lazy accessor for the renderer process. Resolved at call-time on every
   *  runner tick because the BrowserWindow lifecycle is independent of this
   *  service — capturing a WebContents reference eagerly would let the service
   *  hold onto a destroyed window across reload. */
  getWebContents?: () => WebContents | null
  /** Lazy accessor for ipcMain. Wrapped in a factory only so tests can stub
   *  it; in production this returns the singleton from `electron`. */
  getIpcMain?: () => IpcMain
  /** Optional AutoTriggerEngine that polls for event-based triggers (e.g.
   *  Linear-issue auto). Started/stopped by start()/stop() alongside the
   *  rrule scheduler. Service tests that don't exercise auto triggers can
   *  omit it. */
  autoTriggerEngine?: AutoTriggerEngineLike
  /** Optional getter for the user-configured auto-trigger poll interval in
   *  seconds. Defaults to 60s when omitted. Read at service.start() time. */
  getAutoTriggerPollIntervalSeconds?: () => number
}

export class AutomationService {
  // Why: design doc allows operators to restart any terminal-non-success run,
  // including the four `skipped_*` variants. Excludes `running`/`pending`/
  // `dispatching`/`dispatched` (in-flight) and `completed` (no reason to
  // re-run a successful run).
  private static readonly RESTARTABLE_STATUSES = new Set<AutomationRunStatus>([
    'failed',
    'dispatch_failed',
    'cancelled',
    'skipped_missed',
    'skipped_unavailable',
    'skipped_needs_interactive_auth'
  ])

  private readonly store: Store
  private readonly tickMs: number
  private readonly getAgentStatus: (paneKey: string) => AgentStatusEntry | undefined
  private readonly getSetupScript: (worktreeId: string) => SetupScriptEntry | undefined
  private readonly getPtyExit: (ptyId: string) => PtyExitEntry | undefined
  private readonly subscribePtyData: (listener: (ptyId: string, data: string) => void) => () => void
  private readonly getPtyIdForPaneKey: (paneKey: string) => string | undefined
  private readonly getWebContents: () => WebContents | null
  private readonly getIpcMain: (() => IpcMain) | null
  private readonly autoTriggerEngine: AutoTriggerEngineLike | null
  private readonly getAutoTriggerPollIntervalSeconds: () => number
  private timer: ReturnType<typeof setInterval> | null = null
  private webContents: WebContents | null = null
  private rendererReady = false
  private evaluating = false
  /** Runs whose chain executor tick is currently in flight. The scheduler
   *  loop skips them so a fire-and-forget tick from `runNow` can't race with
   *  `tickRunningChains` and double-fire a step's IPC side effects. */
  private readonly inFlightRunIds = new Set<string>()
  /** Fast re-tick timer scheduled after a tickRunningChains() pass that left
   *  at least one chain in `running` state. Cleared on stop() and reset each
   *  time we schedule a new one so concurrent runs don't pile up timers. */
  private fastTickTimer: ReturnType<typeof setTimeout> | null = null
  private readonly runPromptRunner: RunPromptRunner
  private readonly waitForSetupRunner: WaitForSetupRunner
  private readonly runCommandRunner: RunCommandRunner
  private readonly createWorktreeRunner: CreateWorktreeRunner
  private readonly createWorkspaceGroupRunner: CreateWorkspaceGroupRunner
  private readonly updateLinearIssueRunner: UpdateLinearIssueRunner
  private readonly collectCiResultsRunner: CollectCiResultsRunner
  private readonly httpRequestRunner: HttpRequestRunner
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
    this.getPtyIdForPaneKey = opts.getPtyIdForPaneKey ?? (() => undefined)
    // Default getWebContents to the service's own setWebContents-tracked
    // reference so tests that don't supply a factory still get the WebContents
    // through the existing setWebContents() path.
    this.getWebContents = opts.getWebContents ?? (() => this.webContents)
    this.getIpcMain = opts.getIpcMain ?? null
    this.autoTriggerEngine = opts.autoTriggerEngine ?? null
    this.getAutoTriggerPollIntervalSeconds =
      opts.getAutoTriggerPollIntervalSeconds ?? (() => DEFAULT_AUTO_TRIGGER_POLL_SECONDS)

    // Why: resolve renderer/ipc lazily so a reload swap is picked up on the
    // next tick. A destroyed/null webContents throws a plain Error (transient)
    // which runners let bubble for retry; deterministic renderer rejections
    // come back as typed errors and fail-fast inside the runner.
    const requirePaneCtx = (
      what: 'prompt' | 'command'
    ): { webContents: WebContents; ipc: IpcMain; requestId: string } => {
      const webContents = this.getWebContents()
      if (!webContents || webContents.isDestroyed()) {
        throw new Error(`No renderer available to open ${what} pane.`)
      }
      if (!this.getIpcMain) {
        throw new Error('AutomationService missing getIpcMain wiring.')
      }
      return { webContents, ipc: this.getIpcMain(), requestId: randomUUID() }
    }

    this.runPromptRunner = new RunPromptRunner({
      openPromptPane: async (params) => openPromptPane(params, requirePaneCtx('prompt')),
      sendPromptToPane: async (params) => sendPromptToPane(params, requirePaneCtx('prompt')),
      closePane: (paneKey: string) => {
        // Why: fire-and-forget. A destroyed webContents or missing renderer is
        // a no-op (no retry needed) since the runner is already discarding the
        // tracker for this step.
        const webContents = this.getWebContents()
        if (!webContents || webContents.isDestroyed()) {
          return
        }
        closePromptPane({ paneKey }, { webContents })
      },
      getAgentStatus: this.getAgentStatus,
      // Why: a chain run hits this milliseconds after createManagedWorktree
      // returns; the renderer's worktrees:changed broadcast may not have
      // settled. Hand the path + connectionId straight from main's store so
      // the renderer doesn't depend on its cache to find the worktree.
      getWorktreeSummary: (worktreeId) => {
        const parsed = splitWorktreeId(worktreeId)
        if (!parsed) {
          return null
        }
        const repo = this.store.getRepo(parsed.repoId)
        return { path: parsed.worktreePath, connectionId: repo?.connectionId ?? null }
      },
      // Why (grouped-workspaces L3): when a run-prompt step's worktreeRef
      // resolves to a `group:<uuid>` (the output shape of
      // create-workspace-group), the runner needs the group's parentPath as
      // the agent CWD and a representative member worktreeId for the UI
      // binding. Resolve both straight from main's store so the renderer can't
      // race the worktrees:changed broadcast.
      getGroupSummary: (groupId) => {
        const group = this.store.getWorkspaceGroups().find((g) => g.id === groupId)
        if (!group || group.memberWorktreeIds.length === 0) {
          return null
        }
        const firstMemberWorktreeId = group.memberWorktreeIds[0]
        const parsed = splitWorktreeId(firstMemberWorktreeId)
        const repo = parsed ? this.store.getRepo(parsed.repoId) : null
        return {
          parentPath: group.parentPath,
          firstMemberWorktreeId,
          connectionId: repo?.connectionId ?? null
        }
      },
      getGroupMemberWorktreeIds: (groupId) => {
        return (
          this.store.getWorkspaceGroups().find((g) => g.id === groupId)?.memberWorktreeIds ?? null
        )
      },
      hasChangesFromMain: hasPromptTargetChangesFromMain,
      resolvePresetPrompt: async ({
        source,
        commandId,
        promptOverride,
        fallbackAgentId,
        worktreeId
      }) => {
        const settings = this.store.getSettings()
        const commands = source === 'review' ? settings.reviewCommands : settings.createPrCommands
        const cmd = commands.find((entry) => entry.id === commandId)
        if (!cmd) {
          throw new Error(
            `No ${source === 'review' ? 'Review' : 'Create PR'} prompt with id "${commandId ?? ''}" is configured.`
          )
        }
        const parsed = splitWorktreeId(worktreeId)
        const repo = parsed ? this.store.getRepo(parsed.repoId) : null
        const hooks = repo ? getEffectiveHooks(repo, parsed?.worktreePath) : null
        const preferences =
          source === 'review' ? hooks?.reviewPreferences : hooks?.createPrPreferences
        const basePrompt =
          promptOverride != null && promptOverride.trim().length > 0 ? promptOverride : cmd.prompt
        const prompt = preferences ? `${basePrompt}\n\n${preferences}` : basePrompt
        return {
          agentId: inferSidebarPromptAgent(cmd.command) ?? (fallbackAgentId as TuiAgent),
          prompt
        }
      },
      // Why: scope outputTail capture to the agent's current turn so the
      // step's `outputTail` surfaces the last assistant reply rather than
      // the full pane history.
      getPtyIdForPaneKey: this.getPtyIdForPaneKey,
      subscribePtyData: this.subscribePtyData,
      now: () => Date.now()
    })

    this.waitForSetupRunner = new WaitForSetupRunner({
      getSetupScript: this.getSetupScript,
      // Why (grouped-workspaces): hand the runner a fresh snapshot per tick so
      // it can fan out a `group:<uuid>` worktreeRef into the group's member
      // worktreeIds. Without this, a group-id ref hit the registry empty-handed
      // and the runner silently resolved as success without ever waiting for
      // member setup scripts.
      getWorkspaceGroups: () => this.store.getWorkspaceGroups(),
      now: () => Date.now()
    })

    this.runCommandRunner = new RunCommandRunner({
      openCommandPane: async (params) => openCommandPane(params, requirePaneCtx('command')),
      getPtyExit: this.getPtyExit,
      subscribePtyData: this.subscribePtyData,
      // Why: when paneRef is set, delegate to the renderer to resolve the
      // command (review/create-pr need settings + hooks lookup) and write it
      // with Enter into the existing pane's PTY.
      sendCommandToPane: async (params) => sendCommandToPane(params, requirePaneCtx('command')),
      // Why: review/create-pr launch interactive agents (Claude, Codex, …)
      // whose PTY stays open after the turn finishes — so PTY exit alone
      // would never resolve the step. Reuse the same agent-status registry
      // run-prompt polls.
      getAgentStatus: this.getAgentStatus,
      // Why: same group-ref resolution run-prompt-runner uses (parity fix).
      // Without this, a `group:<uuid>` worktreeRef hits openCommandPane with
      // an id no worktree carries → "Worktree is no longer available". Phase
      // J1's pty:spawn override then lifts the CWD to the group parent for us.
      getGroupSummary: (groupId) => {
        const group = this.store.getWorkspaceGroups().find((g) => g.id === groupId)
        if (!group || group.memberWorktreeIds.length === 0) {
          return undefined
        }
        const firstMemberWorktreeId = group.memberWorktreeIds[0]
        const parsed = splitWorktreeId(firstMemberWorktreeId)
        const repo = parsed ? this.store.getRepo(parsed.repoId) : null
        return {
          firstMemberWorktreeId,
          parentPath: group.parentPath,
          connectionId: repo?.connectionId ?? null
        }
      },
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
    // Why: same fail-loud default as createWorktree — a chain that hits a
    // pull-request-mode create-worktree step without the dep wired surfaces a
    // clear error instead of a confusing TypeError mid-tick.
    const createWorktreeFromPrDep: CreateWorktreeDeps['createWorktreeFromPr'] =
      opts.createWorktreeFromPr ??
      (() => {
        throw new Error(
          'AutomationService: createWorktreeFromPr dep not wired (cannot run pull-request create-worktree steps).'
        )
      })
    this.createWorktreeRunner = new CreateWorktreeRunner({
      createWorktree: createWorktreeDep,
      createWorktreeFromPr: createWorktreeFromPrDep,
      now: () => Date.now()
    })

    // Why: same fail-loud default as createWorktree — a chain that hits
    // create-workspace-group without the dep wired surfaces a clear error
    // instead of a confusing TypeError mid-tick. Service tests that never
    // exercise group steps can skip the wiring.
    const createWorkspaceGroupDep: CreateWorkspaceGroupDeps['createWorkspaceGroup'] =
      opts.createWorkspaceGroup ??
      (() => {
        throw new Error(
          'AutomationService: createWorkspaceGroup dep not wired (cannot run create-workspace-group steps).'
        )
      })
    this.createWorkspaceGroupRunner = new CreateWorkspaceGroupRunner({
      createWorkspaceGroup: createWorkspaceGroupDep,
      // Why: exposes Repo.description to the group templating context
      // (`group.members.<repo>.description`) so chain authors can hand repo
      // context to agents without an extra IPC roundtrip. Closure over
      // `this.store` rather than the snapshot value so a description edit
      // between service construction and the chain tick is visible to the
      // runner.
      getRepoDescription: (repoId) => this.store.getRepo(repoId)?.description,
      now: () => Date.now()
    })

    this.updateLinearIssueRunner = new UpdateLinearIssueRunner({
      // Why: pass the bound Linear API call directly. The runner's narrow dep
      // shape lets tests stub without touching the Linear SDK; production
      // wiring uses the module-level singleton client managed in linear/client.
      updateIssue: (id, updates) => linearUpdateIssue(id, updates)
    })

    this.collectCiResultsRunner = new CollectCiResultsRunner({
      getWorktreeMeta: (worktreeId) => {
        const meta = this.store.getWorktreeMeta(worktreeId)
        if (!meta) {
          return undefined
        }
        const parsed = splitWorktreeId(worktreeId)
        const repo = parsed ? this.store.getRepo(parsed.repoId) : null
        return {
          linkedPR: meta.linkedPR,
          path: parsed?.worktreePath ?? worktreeId,
          repoPath: repo?.path ?? ''
        }
      },
      getWorkspaceGroups: () => this.store.getWorkspaceGroups(),
      hasChangesFromMain: async (worktreeId, path, connectionId) => {
        const result = await hasPromptTargetChangesFromMain([{ worktreeId, path, connectionId }])
        return result.hasChanges
      },
      getPRChecks: (repoPath, prNumber) => getPRChecks(repoPath, prNumber),
      getPRComments: (repoPath, prNumber) => getPRComments(repoPath, prNumber),
      getRepoPath: (repoId) => this.store.getRepo(repoId)?.path,
      getConnectionId: (repoId) => this.store.getRepo(repoId)?.connectionId ?? null,
      resolveLinkedPR: async (worktreePath, repoPath) => {
        try {
          const { stdout } = await gitExecFileAsync(['branch', '--show-current'], {
            cwd: worktreePath
          })
          const branch = stdout.trim()
          if (!branch) {
            return null
          }
          const ghCache = this.store.getGitHubCache()
          const cached = ghCache.pr[`${repoPath}::${branch}`]
          if (cached?.data?.number != null) {
            return cached.data.number
          }
          const pr = await getPRForBranch(repoPath, branch)
          return pr?.number ?? null
        } catch {
          return null
        }
      },
      now: () => Date.now()
    })

    this.httpRequestRunner = new HttpRequestRunner({
      // Why: resolve the referenced connection (sealed base URL + headers) from
      // settings at run time; execute defaults to the real guarded executor.
      getConnection: (id) => this.store.getSettings().httpConnections?.find((c) => c.id === id)
    })

    this.chainExecutor = new ChainExecutor({
      getRunner: (kind) => this.resolveRunner(kind),
      persistRun: (run) => {
        this.store.replaceAutomationRun(run)
        // Why: notify the renderer so AutomationsPage's run list and detail
        // panes update without the operator hitting refresh. Mirrors the
        // legacy dispatcher's `AUTOMATIONS_CHANGED_EVENT` flow but originates
        // in main so chain-shape progress (step transitions, status flips,
        // outputs) is surfaced live.
        this.broadcastAutomationsChanged()
      },
      now: () => Date.now()
    })
  }

  private broadcastAutomationsChanged(): void {
    const webContents = this.getWebContents()
    if (!webContents || webContents.isDestroyed()) {
      return
    }
    webContents.send('automations:changed')
  }

  setWebContents(webContents: WebContents | null): void {
    this.webContents = webContents
    this.rendererReady = false
  }

  setRendererReady(): void {
    this.rendererReady = true
    void this.evaluateDueRuns()
  }

  /** Nudge the chain executor to immediately drive any in-progress chain runs
   *  forward, bypassing the 60s scheduler cadence. Called by the agent-status
   *  listener when an agent flips to a state that can unblock a polling
   *  step (e.g. run-prompt waiting for `done`). Safe to call frequently —
   *  the `evaluating` guard short-circuits concurrent invocations. */
  wakeChains(): void {
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
    // Why: auto-trigger engine runs alongside the rrule scheduler; its cadence
    // is configured in seconds (user setting) but setInterval wants ms.
    if (this.autoTriggerEngine) {
      const intervalSec = this.getAutoTriggerPollIntervalSeconds()
      this.autoTriggerEngine.start(intervalSec * 1000)
    }
  }

  stop(): void {
    if (this.fastTickTimer) {
      clearTimeout(this.fastTickTimer)
      this.fastTickTimer = null
    }
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.autoTriggerEngine) {
      this.autoTriggerEngine.stop()
    }
  }

  async runNow(automationId: string, payload?: RunNowPayload): Promise<AutomationRun> {
    const automation = this.store.listAutomations().find((entry) => entry.id === automationId)
    if (!automation) {
      throw new Error('Automation not found.')
    }
    // Chain-shape automation: dispatch via the shared internal path so manual
    // and auto-triggered runs follow the same persistence + tick contract.
    if (automation.trigger && automation.steps && automation.steps.length > 0) {
      return this.dispatchRun({ automation, payload })
    }
    // Legacy automation: same dispatch flow as scheduled runs.
    const run = this.store.createAutomationRun(automation, Date.now(), 'manual')
    await this.requestDispatch(automation, run)
    return run
  }

  /** Shared chain-shape dispatch path. Builds the run row + context, persists
   *  it as `running`, broadcasts the change, then fires the first executor
   *  tick fire-and-forget. Reused by `runNow` (manual) and `dispatchAutoRun`
   *  (auto). Legacy automations stay on the `requestDispatch` flow. */
  private async dispatchRun(args: {
    automation: Automation
    payload?: RunNowPayload
    triggerOverrides?: {
      kind?: AutomationRunTrigger
      triggerSource?: TriggerSourceId
      triggerAutoTriggerId?: string
      triggerRuleId?: string
      triggerEntityId?: string
      restartedFromRunId?: string
    }
  }): Promise<AutomationRun> {
    const { automation, payload, triggerOverrides } = args
    if (!automation.trigger || !automation.steps || automation.steps.length === 0) {
      throw new Error('dispatchRun only supports chain-shape automations')
    }
    // Why: build the trigger context up-front (before persisting the run) so
    // a missing project fails fast — operators see a clear error instead of
    // a phantom `running` row with an unresolved template downstream.
    const triggerContext = this.buildTriggerContext(payload)
    // Why: when the trigger accepts a project at run time, the operator's
    // selection (or the auto-trigger rule's projectId) replaces
    // automation.projectId for this run so downstream create-worktree steps
    // target the picked repo.
    const runProjectId = payload?.projectId ?? automation.projectId
    const kind = triggerOverrides?.kind ?? 'manual'
    const run = this.store.createAutomationRun(automation, Date.now(), kind, {
      triggerSource: triggerOverrides?.triggerSource,
      triggerAutoTriggerId: triggerOverrides?.triggerAutoTriggerId,
      triggerRuleId: triggerOverrides?.triggerRuleId,
      triggerEntityId: triggerOverrides?.triggerEntityId,
      restartedFromRunId: triggerOverrides?.restartedFromRunId
    })
    run.status = 'running'
    // Seed the chain context with automation metadata so templates like
    // `{{automation.workspaceId}}` resolve on the very first tick, and so
    // CreateWorktreeRunner can pick up the target repo from
    // `context.automation.projectId` (it's the only path it knows to look at).
    run.context = {
      automation: {
        workspaceId: automation.workspaceId,
        projectId: runProjectId
      },
      trigger: triggerContext
    }
    run.stepStates = []
    this.store.replaceAutomationRun(run)
    this.broadcastAutomationsChanged()
    // Why: fire-and-forget the initial tick so the caller (Run Now modal or
    // auto-trigger engine) doesn't block on the full step chain. The run is
    // already persisted as `running`, so the UI sees progress on the next
    // refresh; tick failures route through `finalizeFailedRun`. Track the
    // run as in-flight so `tickRunningChains` can't double-fire its steps.
    this.inFlightRunIds.add(run.id)
    void this.chainExecutor
      .tick(automation, run)
      .catch((e) => {
        this.finalizeFailedRun(run, e)
      })
      .finally(() => {
        this.inFlightRunIds.delete(run.id)
      })
    return this.store.getAutomationRun(run.id) ?? run
  }

  /** Bridge from the AutoTriggerEngine into the chain dispatch path. Maps the
   *  engine's CandidateEvent into the same `RunNowPayload` shape manual runs
   *  use, then stamps the trigger provenance metadata on the run row. */
  async dispatchAutoRun(args: {
    automation: Automation
    trigger: AutoTrigger
    rule: Rule
    event: CandidateEvent
  }): Promise<AutomationRun> {
    const { automation, trigger, rule, event } = args
    let runPayload: RunNowPayload
    if (trigger.source === 'linear-issue') {
      // Why: a linear-issue source ALWAYS populates payload.issue; a missing
      // one is a malformed event. Refuse to dispatch so the engine's per-event
      // catch logs the error — the dedup row already written is the only
      // artifact, and the operator can clear it from the dedup-management UI
      // rather than chasing a phantom run with no trigger context.
      const linearPayload = (event.payload as { issue?: LinearIssuePayload }).issue
      if (!linearPayload) {
        throw new Error(
          `dispatchAutoRun: linear-issue event missing payload.issue (entityId=${event.entityId})`
        )
      }
      runPayload = {
        projectId: rule.projectId,
        linear: { issue: linearPayload }
      }
    } else if (trigger.source === 'github-pr') {
      const prPayload = (event.payload as { pr?: GithubPrPayload }).pr
      if (!prPayload) {
        throw new Error(
          `dispatchAutoRun: github-pr event missing payload.pr (entityId=${event.entityId})`
        )
      }
      // The PR's own repo is the run target — not rule.projectId (rules are pure
      // filters for github-pr; the watch-list/event determines the repo).
      runPayload = { projectId: event.repoId, github: { pr: prPayload } }
    } else if (trigger.source === 'http-endpoint') {
      // Why: event.payload already holds the mapped variables that become
      // run.context.trigger.http.*; the rule decides the target project.
      runPayload = { projectId: rule.projectId, http: event.payload }
    } else if (trigger.source === 'schedule') {
      // Why: schedule has no external entity — the run targets the automation's
      // project (carried by the implicit rule) and payload.schedule is the
      // fire-time context surfaced to chain steps.
      const schedulePayload = (event.payload as { schedule?: RunNowPayload['schedule'] }).schedule
      runPayload = { projectId: rule.projectId, schedule: schedulePayload }
    } else {
      runPayload = { projectId: rule.projectId }
    }
    return this.dispatchRun({
      automation,
      payload: runPayload,
      triggerOverrides: {
        kind: 'auto',
        triggerSource: trigger.source,
        triggerAutoTriggerId: trigger.id,
        triggerRuleId: rule.id,
        triggerEntityId: event.entityId
      }
    })
  }

  private buildTriggerContext(payload?: RunNowPayload): Record<string, unknown> {
    const triggerContext: Record<string, unknown> = {}
    if (payload?.linear) {
      triggerContext.linear = payload.linear
    }
    if (payload?.github) {
      triggerContext.github = payload.github
    }
    if (payload?.http) {
      triggerContext.http = payload.http
    }
    if (payload?.schedule) {
      triggerContext.schedule = payload.schedule
    }
    if (payload?.projectId) {
      // Why: validate the picked project up-front so the run fails fast with a
      // clear error rather than hitting an unresolved projectId downstream.
      const repo = this.store.getRepo(payload.projectId)
      if (!repo) {
        throw new Error(`Project ${payload.projectId} not found.`)
      }
    }
    return triggerContext
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
    if (kind === 'create-workspace-group') {
      return this.createWorkspaceGroupRunner
    }
    if (kind === 'update-linear-issue') {
      return this.updateLinearIssueRunner
    }
    if (kind === 'collect-ci-results') {
      return this.collectCiResultsRunner
    }
    if (kind === 'http-request') {
      return this.httpRequestRunner
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
        // Why: chain-shape automations are manual-only (empty rrule) — they
        // dispatch via runNow, never on a schedule. Skip them in the scheduler
        // loop so the rrule parser is never called against an empty string.
        if (!automation.enabled || !automation.rrule || automation.nextRunAt > now) {
          continue
        }
        await this.evaluateAutomation(automation, now)
      }
      await this.tickRunningChains()
    } finally {
      this.evaluating = false
    }
    this.scheduleFastTickIfRunsActive()
  }

  /** Schedule a sub-cadence re-tick when at least one chain run is still
   *  active. The default scheduler cadence is 60s; that's fine for idle
   *  automations but too coarse for active runs that are waiting on a
   *  short-debounce signal (e.g. run-prompt's 5s done-debounce). The fast
   *  timer is a single setTimeout (not setInterval) so it naturally stops
   *  once no run is active. */
  private scheduleFastTickIfRunsActive(): void {
    if (this.fastTickTimer) {
      return
    }
    const hasActiveRun = this.store
      .listAutomationRuns()
      .some((run) => isActiveChainRunStatus(run.status) && !this.inFlightRunIds.has(run.id))
    if (!hasActiveRun) {
      return
    }
    this.fastTickTimer = setTimeout(() => {
      this.fastTickTimer = null
      void this.evaluateDueRuns()
    }, 2000)
  }

  /** Drive every in-progress chain run forward by one runner tick. Runs in
   *  series so a buggy runner can't pile up concurrent ticks against the
   *  same registry/renderer; chain execution is inherently low-volume
   *  (one tick per ~minute per run). */
  private async tickRunningChains(): Promise<void> {
    const automations = new Map(this.store.listAutomations().map((a) => [a.id, a]))
    for (const run of this.store.listAutomationRuns()) {
      // Why: `waiting` is still live chain work. A waiting sibling in a
      // parallel group must keep getting ticks so other running siblings can
      // observe agent-status/PTY completion and the waiting step can resume.
      if (!isActiveChainRunStatus(run.status)) {
        continue
      }
      // Why: a fire-and-forget runNow tick may still be advancing this run.
      // Skip it here so two ticks don't drive the same chain concurrently and
      // double-fire IPC side effects (openPromptPane etc.).
      if (this.inFlightRunIds.has(run.id)) {
        continue
      }
      const automation = automations.get(run.automationId)
      if (!automation) {
        continue
      }
      this.inFlightRunIds.add(run.id)
      try {
        await this.chainExecutor.tick(automation, run)
      } catch (e) {
        // Why: an unhandled runner error must not poison the tick loop for
        // every other run. Mark this run failed and persist so the operator
        // sees the error instead of an indefinite `running` row.
        this.finalizeFailedRun(run, e)
      } finally {
        this.inFlightRunIds.delete(run.id)
      }
    }
  }

  /** Operator-initiated stop: mark the run cancelled, finalize any trailing
   *  non-terminal step states with a "Cancelled" error so the UI doesn't
   *  show a step indefinitely `running` under a stopped run, and drop every
   *  runner tracker for the run so a stray tick can't pick the pane back up.
   *  Returns the updated run or undefined when the id doesn't exist / the
   *  run is already in a terminal state. */
  cancelRun(runId: string): AutomationRun | undefined {
    const run = this.store.listAutomationRuns().find((entry) => entry.id === runId)
    if (!run) {
      return undefined
    }
    if (
      !isActiveChainRunStatus(run.status) &&
      run.status !== 'pending' &&
      run.status !== 'dispatching'
    ) {
      return run
    }
    const now = Date.now()
    if (run.stepStates) {
      for (const state of run.stepStates) {
        if (
          state.status === 'running' ||
          state.status === 'pending' ||
          state.status === 'waiting'
        ) {
          state.status = 'failed'
          state.finishedAt = now
          state.error = state.error ?? 'Cancelled by operator.'
        }
      }
    }
    run.status = 'cancelled'
    run.error = run.error ?? 'Cancelled by operator.'
    run.finishedAt = now
    this.store.replaceAutomationRun(run)
    // Drop every runner's tracker so a queued/in-flight tick doesn't try to
    // resume the cancelled pane. Cheap no-op when a runner never saw the run.
    for (const runner of this.allRunners()) {
      runner.dropRun?.(run.id)
    }
    this.broadcastAutomationsChanged()
    return run
  }

  /** Operator-initiated retry from a specific step. Truncates `stepStates`
   *  to before the target index, drops every dropped step's runner tracker
   *  so the retry starts fresh, flips the run back to `running`, and pokes
   *  the chain executor to immediately pick it up. Returns undefined when
   *  the run or step index can't be resolved. Why per-step: completed
   *  steps' downstream context (`steps.<id>.…`) is preserved, so a retry of
   *  step N can still template against steps 0…N-1. */
  retryRunFromStep(runId: string, stepIndex: number): AutomationRun | undefined {
    const run = this.store.listAutomationRuns().find((entry) => entry.id === runId)
    if (!run) {
      return undefined
    }
    const automation = this.store.listAutomations().find((entry) => entry.id === run.automationId)
    // Why: stepIndex is a flat index into stepStates (already flattened), so
    // the bounds check must compare against the flat step count, not the
    // StepOrGroup[] length which may be shorter when parallel groups exist.
    const flatSteps = flattenSteps(automation?.steps ?? [])
    if (!automation || !automation.steps || stepIndex < 0 || stepIndex >= flatSteps.length) {
      return undefined
    }
    const droppedStates = (run.stepStates ?? []).slice(stepIndex)
    run.stepStates = (run.stepStates ?? []).slice(0, stepIndex)
    run.status = 'running'
    run.error = null
    run.finishedAt = undefined
    this.store.replaceAutomationRun(run)
    for (const state of droppedStates) {
      for (const runner of this.allRunners()) {
        runner.dropStep?.(run.id, state.stepId)
      }
    }
    // Why: close any panes the prior steps opened. The runner-tracker path
    // above only fires when the runner still has an in-memory tracker, which
    // it loses across app restart. The persisted state.openedPane survives,
    // so this fallback fires closePane even after restart-then-retry.
    this.closePersistedStepPanes(droppedStates)
    this.broadcastAutomationsChanged()
    // Why: kick a tick immediately rather than wait for the next scheduler
    // cadence so the operator sees the retry start right away.
    this.wakeChains()
    return run
  }

  /** Fire closePane for every state with a persisted self-opened pane. Used
   *  on retry to tear down prior-attempt tabs whose runner-side tracker was
   *  lost across restart. paneRef-attached panes (`selfOpenedPane: false`)
   *  are owned by upstream steps and intentionally left alone. */
  private closePersistedStepPanes(states: StepRunState[]): void {
    const webContents = this.getWebContents()
    if (!webContents || webContents.isDestroyed()) {
      return
    }
    for (const state of states) {
      const opened = state.openedPane
      if (opened && opened.selfOpenedPane && opened.paneKey) {
        closePromptPane({ paneKey: opened.paneKey }, { webContents })
      }
    }
  }

  /** Operator-initiated retry of a single sibling inside a parallel group.
   *  Resets just the targeted step's state so the chain executor re-ticks
   *  that sibling on its next pass; sibling states are preserved (so an
   *  unrelated success or still-in-flight sibling isn't disturbed).
   *  Downstream stepStates after the group are dropped so the chain re-runs
   *  with fresh context once the retried sibling lands terminal. Falls back
   *  to {@link retryRunFromStep} when the step isn't a parallel-group
   *  member, so the renderer can route every sibling's retry button
   *  through this single method. */
  retryParallelStep(runId: string, stepId: string): AutomationRun | undefined {
    const run = this.store.listAutomationRuns().find((entry) => entry.id === runId)
    if (!run) {
      return undefined
    }
    const automation = this.store.listAutomations().find((entry) => entry.id === run.automationId)
    if (!automation || !automation.steps) {
      return undefined
    }
    // Walk the StepOrGroup[] array to locate the step. We need:
    //   - groupStart: flat index of the group's first sibling
    //   - groupEnd: flat index just past the group's last sibling
    //   - stepFlatIdx: flat index of the targeted step
    let consumed = 0
    let groupStart = -1
    let groupEnd = -1
    let stepFlatIdx = -1
    for (const item of automation.steps) {
      if (Array.isArray(item)) {
        const inGroup = item.findIndex((s) => s.id === stepId)
        if (inGroup >= 0) {
          groupStart = consumed
          groupEnd = consumed + item.length
          stepFlatIdx = consumed + inGroup
          break
        }
        consumed += item.length
      } else {
        if (item.id === stepId) {
          stepFlatIdx = consumed
          break
        }
        consumed += 1
      }
    }
    if (stepFlatIdx < 0) {
      return undefined
    }
    // Solo step → fall through to the existing per-step truncate semantics.
    if (groupStart < 0) {
      return this.retryRunFromStep(runId, stepFlatIdx)
    }
    const states = run.stepStates ?? []
    if (stepFlatIdx >= states.length) {
      // Step never ran — nothing to retry.
      return undefined
    }
    const now = Date.now()
    // Reset the targeted sibling's state in place so the parallel-group
    // executor sees it as non-terminal on the next tick. We don't push a
    // fresh state object because makeStepState lives in chain-executor; the
    // executor's tickParallelGroup re-ticks any non-terminal sibling, which
    // is what we want here.
    const targetState = states[stepFlatIdx]
    // Why: snapshot the prior openedPane BEFORE the in-place reset clears it,
    // so the persisted-pane cleanup below can still fire closePane for the
    // target sibling. We pair the snapshot back with this state's stepId by
    // cloning a minimal record for closePersistedStepPanes.
    const targetPriorOpened = targetState.openedPane ?? null
    targetState.status = 'running'
    targetState.statusMessage = null
    targetState.nextPollAt = null
    targetState.startedAt = now
    targetState.finishedAt = null
    targetState.output = null
    targetState.error = null
    targetState.openedPane = null
    // Drop every stepState after the group so downstream re-runs with the
    // retried sibling's fresh output. Capture the dropped states so the
    // persisted-pane cleanup below can iterate them.
    const droppedStates: StepRunState[] = []
    if (groupEnd < states.length) {
      droppedStates.push(...states.slice(groupEnd))
      run.stepStates = states.slice(0, groupEnd)
    } else {
      run.stepStates = states
    }
    run.status = 'running'
    run.error = null
    run.finishedAt = undefined
    this.store.replaceAutomationRun(run)
    // Drop runner trackers for the target step + every downstream stepState.
    for (const runner of this.allRunners()) {
      runner.dropStep?.(run.id, targetState.stepId)
    }
    for (const downstream of droppedStates) {
      for (const runner of this.allRunners()) {
        runner.dropStep?.(run.id, downstream.stepId)
      }
    }
    // Why: persistent fallback — same rationale as retryRunFromStep. Includes
    // the target's pre-reset snapshot plus every downstream state so the
    // session-restart case can still tear down the prior attempt's tabs.
    this.closePersistedStepPanes([
      { ...targetState, openedPane: targetPriorOpened },
      ...droppedStates
    ])
    this.broadcastAutomationsChanged()
    this.wakeChains()
    return run
  }

  /** Operator-initiated restart of a terminal non-success run. Looks up the
   *  prior run, validates its status is restartable, and dispatches a fresh
   *  run via `dispatchRun` carrying over the prior trigger metadata + a
   *  `restartedFromRunId` lineage pointer. Crucially does NOT touch the
   *  dedup table: the original auto-trigger event's dedup row stays in place
   *  so we don't re-burn it, and restart bypasses the dedup gate entirely. */
  async restartRun(runId: string): Promise<AutomationRun> {
    const prior = this.store.getAutomationRun(runId)
    if (!prior) {
      throw new Error('run not found')
    }
    if (!AutomationService.RESTARTABLE_STATUSES.has(prior.status)) {
      throw new Error('run is not restartable')
    }
    const automation = this.store.listAutomations().find((a) => a.id === prior.automationId)
    if (!automation) {
      throw new Error('automation no longer exists')
    }
    // Why: reconstruct payload from the prior run's context. The new run uses
    // the automation's CURRENT steps/prompt — design intent is "restart with
    // current config", not a snapshot. The prior context.automation.projectId
    // captures the run-time picked project (acceptsProjectSelection); fall
    // back to the automation's stored projectId if absent.
    const priorContext = prior.context as
      | {
          automation?: { projectId?: string }
          trigger?: { linear?: { issue: LinearIssuePayload } }
        }
      | undefined
    const payload: RunNowPayload = {
      projectId: priorContext?.automation?.projectId ?? automation.projectId,
      ...(priorContext?.trigger?.linear ? { linear: priorContext.trigger.linear } : {})
    }
    return this.dispatchRun({
      automation,
      payload,
      triggerOverrides: {
        kind: prior.trigger,
        triggerSource: prior.triggerSource,
        triggerAutoTriggerId: prior.triggerAutoTriggerId,
        triggerRuleId: prior.triggerRuleId,
        triggerEntityId: prior.triggerEntityId,
        restartedFromRunId: prior.id
      }
    })
  }

  /** Iterable of every concrete runner so cancel/retry can fan out without
   *  knowing the kind set. */
  private allRunners(): StepRunner[] {
    return [
      this.runPromptRunner,
      this.waitForSetupRunner,
      this.runCommandRunner,
      this.createWorktreeRunner,
      this.createWorkspaceGroupRunner,
      this.updateLinearIssueRunner,
      this.collectCiResultsRunner
    ]
  }

  getTriggerPollStatus(): { source: TriggerSourceId; lastPollAt: number; intervalMs: number }[] {
    if (!this.autoTriggerEngine?.getPollStatus) {
      return []
    }
    const map = this.autoTriggerEngine.getPollStatus()
    return Array.from(map, ([source, v]) => ({ source, ...v }))
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
        if (
          state.status === 'running' ||
          state.status === 'pending' ||
          state.status === 'waiting'
        ) {
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
    this.broadcastAutomationsChanged()
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
    // Why: every automation crossing to the renderer must be masked — uphold the
    // invariant structurally even though http triggers don't reach this legacy
    // dispatch path today.
    const payload: AutomationDispatchRequest = {
      automation: { ...automation, autoTriggers: maskAutoTriggers(automation.autoTriggers) },
      run
    }
    webContents.send('automations:dispatchRequested', payload)
  }
}
