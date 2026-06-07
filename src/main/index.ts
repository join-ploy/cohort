import { grantDirAcl } from './win32-utils'
import { rm } from 'fs/promises'
import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme } from 'electron'
import { electronApp, is } from '@electron-toolkit/utils'
import devIcon from '../../resources/icon-dev.png?asset'
import { Store, initDataPath } from './persistence'
import { StatsCollector, initStatsPath } from './stats/collector'
import { ClaudeUsageStore, initClaudeUsagePath } from './claude-usage/store'
import { CodexUsageStore, initCodexUsagePath } from './codex-usage/store'
import { killAllPty } from './ipc/pty'
import { initDaemonPtyProvider, disconnectDaemon } from './daemon/daemon-init'
import { closeAllWatchers } from './ipc/filesystem-watcher'
import { registerCoreHandlers } from './ipc/register-core-handlers'
import { registerMobileHandlers } from './ipc/mobile'
import { initTelemetry, shutdownTelemetry, trackAppOpenedOnce } from './telemetry/client'
import { runManagedHookInstallers } from './agent-hooks/install-telemetry'
import { initCohortClassifier } from './telemetry/cohort-classifier'
import { initOnboardingCohortClassifier } from './telemetry/onboarding-cohort-classifier'
import { resolveConsent } from './telemetry/consent'
import { triggerStartupNotificationRegistration } from './ipc/notifications'
import { OrcaRuntimeService } from './runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime/runtime-rpc'
import { clearRuntimeMetadataIfOwned } from './runtime/runtime-metadata'
import { registerAppMenu, rebuildAppMenu } from './menu/register-app-menu'
import { checkForUpdatesFromMenu, isQuittingForUpdate } from './updater'
import {
  configureDevUserDataPath,
  enableMainProcessGpuFeatures,
  installDevParentDisconnectQuit,
  installDevParentWatchdog,
  installUncaughtPipeErrorGuard,
  patchPackagedProcessPath
} from './startup/configure-process'
import { startFirstWindowStartupServices } from './startup/first-window-startup-services'
import { hydrateShellPath, mergePathSegments } from './startup/hydrate-shell-path'
import { acquireSingleInstanceLock } from './startup/single-instance-lock'
import { RateLimitService } from './rate-limits/service'
import { attachMainWindowServices } from './window/attach-main-window-services'
import { createMainWindow } from './window/createMainWindow'
import { CodexAccountService } from './codex-accounts/service'
import { CodexRuntimeHomeService } from './codex-accounts/runtime-home-service'
import { ClaudeAccountService } from './claude-accounts/service'
import { ClaudeRuntimeAuthService } from './claude-accounts/runtime-auth-service'
import { agentHookServer } from './agent-hooks/server'
import { claudeHookService } from './claude/hook-service'
import { codexHookService } from './codex/hook-service'
import { geminiHookService } from './gemini/hook-service'
import { cursorHookService } from './cursor/hook-service'
import { droidHookService } from './droid/hook-service'
import {
  getPtyIdForPaneKey,
  registerPaneKeyTeardownListener,
  getLocalPtyProvider,
  setPtyExitRegistry,
  setOnPtyExitListener,
  subscribePtyData
} from './ipc/pty'
import { killAllRunScripts } from './ipc/run-script'
import { killAllSetupScripts, setSetupScriptRegistry } from './ipc/setup-script'
import { AgentBrowserBridge } from './browser/agent-browser-bridge'
import { browserManager } from './browser/browser-manager'
import { setUnreadDockBadgeCount } from './dock/unread-badge'
import { AutomationService } from './automations/service'
import { AutoTriggerEngine } from './automations/auto-trigger-engine'
import { TriggerSourceRegistry } from './automations/trigger-sources/registry'
import { makeLinearIssueSource } from './automations/trigger-sources/linear-issue'
import { makeGithubPrSource } from './automations/trigger-sources/github-pr'
import { makeHttpEndpointSource } from './automations/trigger-sources/http-endpoint'
import { makeScheduleSource } from './automations/trigger-sources/schedule'
import { registerTriggerSourceHandlers } from './ipc/trigger-sources'
import { getClient as getLinearClient } from './linear/client'
import type { TriggerSourceId } from '../shared/automations-types'
import { AgentStatusRegistry } from './agent-status/registry'
import { SetupScriptRegistry } from './setup-script/registry'
import { PtyExitRegistry } from './pty/exit-registry'
import { createCleanupService, type CleanupService } from './archive/cleanup-service'
import { runWorktreeRemoval } from './worktree-removal/run-worktree-removal'
import {
  createWorkspaceGroup as createWorkspaceGroupFlow,
  notifyWorkspaceGroupsChanged,
  repoFolderName
} from './ipc/workspace-groups'
import { collectTakenWorkspaceNamesForRepo } from './ipc/worktree-logic'
import { generateUniqueWorkspaceName } from '../shared/workspace-name-generator'
import { resolvePrBaseCore } from './git/resolve-pr-base'
import { createLocalWorktree } from './ipc/worktree-remote'

let mainWindow: BrowserWindow | null = null
/** Whether a manual app.quit() (Cmd+Q, etc.) is in progress. Shared with the
 *  window close handler so it can tell the renderer to skip the running-process
 *  confirmation dialog and proceed directly to buffer capture + close. */
let isQuitting = false
let store: Store | null = null
let stats: StatsCollector | null = null
let claudeUsage: ClaudeUsageStore | null = null
let codexUsage: CodexUsageStore | null = null
let codexAccounts: CodexAccountService | null = null
let codexRuntimeHome: CodexRuntimeHomeService | null = null
let claudeAccounts: ClaudeAccountService | null = null
let claudeRuntimeAuth: ClaudeRuntimeAuthService | null = null
let runtime: OrcaRuntimeService | null = null
let rateLimits: RateLimitService | null = null
let runtimeRpc: OrcaRuntimeRpcServer | null = null
let watcherShutdownPromise: Promise<void> | null = null
let watcherShutdownDone = false
let automations: AutomationService | null = null
let archiveCleanup: CleanupService | null = null
// Why: main-process mirror of the renderer's agent-status map, written from
// the same hook-event callback that fans events out via `agentStatus:set`.
// The chain executor (next Phase 1 task) reads from this so RunPromptRunner
// can poll agent state without an IPC roundtrip.
const agentStatusRegistry = new AgentStatusRegistry()
// Why: main-process source of truth for setup-script lifecycle (per worktree).
// Written by src/main/ipc/setup-script.ts at spawn + exit, read by the
// AutomationService's WaitForSetupRunner so chain steps can wait on setup
// without an IPC roundtrip.
const setupScriptRegistry = new SetupScriptRegistry()
setSetupScriptRegistry(setupScriptRegistry)
// Why: main-process source of truth for PTY exit observations. Written by
// src/main/ipc/pty.ts at PTY teardown, read by the AutomationService's
// RunCommandRunner so chain steps can detect command completion without an
// IPC roundtrip.
const ptyExitRegistry = new PtyExitRegistry()
setPtyExitRegistry(ptyExitRegistry)
// Why: nudge the chain executor whenever a PTY exits so RunCommandRunner
// resolves the step within milliseconds instead of waiting for the next
// scheduler tick. Mirrors the agent-status wake hook below.
setOnPtyExitListener(() => {
  automations?.wakeChains()
})

installUncaughtPipeErrorGuard()
// Why: propagate the Orca app version into `process.env` so PTY-env
// construction in both main (local-pty-provider) and the forked daemon
// (pty-subprocess) can set `TERM_PROGRAM_VERSION` without re-importing
// electron. The daemon inherits `process.env` via fork (daemon-init.ts:93).
process.env.ORCA_APP_VERSION = app.getVersion()
patchPackagedProcessPath()
// Why: patchPackagedProcessPath seeds a minimal list of well-known system
// dirs synchronously so early IPC (e.g. preflight before the shell spawn
// completes) doesn't miss homebrew/nix. Kick off the login-shell probe in
// parallel for packaged runs — when it resolves, its PATH is prepended and
// detectInstalledAgents picks up whatever the user's rc files put on PATH
// (cargo/pyenv/volta/custom tool install dirs) without hardcoding each one.
// Dev runs already inherit a complete PATH from the launching terminal, so
// the spawn cost is only paid where it's needed.
if (app.isPackaged && process.platform !== 'win32') {
  void hydrateShellPath().then((result) => {
    if (result.ok) {
      mergePathSegments(result.segments)
    }
  })
}
configureDevUserDataPath(is.dev)

function focusExistingWindow(): void {
  // Why: the second-instance event fires on the *primary* Electron process
  // after another launch tries (and fails) to acquire the lock. Bring the
  // existing window forward so the user sees the same focus behaviour as
  // re-clicking the dock/taskbar icon, rather than a silent no-op.
  //
  // Why show() as well as restore() + focus(): isMinimized() only covers the
  // dock-minimised case. A hidden window (close-to-tray on macOS via Cmd+W,
  // or a window on a different macOS Space) is NOT minimised, so focus()
  // alone is a silent no-op. show() handles those plus Windows taskbar
  // focus-steal, which focus() alone does not reliably trigger.
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show()
    }
    mainWindow.focus()
  }
  // Pre-window case: the primary is still booting and will call
  // openMainWindow() from whenReady(). No action needed here.
}

// Why: the lock must be acquired AFTER configureDevUserDataPath — Electron
// derives the lock identity from the `userData` path, so this placement lets
// dev (`cohort-dev`) and packaged (`cohort`) runs lock in separate namespaces
// instead of serialising against each other.
//
// Why skip in dev: engineers routinely run `pnpm dev` in parallel from
// multiple worktrees while shipping features, and the lock makes the second
// `pnpm dev` exit silently. In dev we accept that `orca-runtime.json` and
// `endpoint.env` may race (the bundled `orca-dev` CLI / agent hooks route
// to whichever instance wrote last). The dev build is not used for real
// agent work, so that routing ambiguity is acceptable. Packaged Orca keeps
// the lock to protect against the corruption documented in PR #1326 /
// issue #1312.
const hasSingleInstanceLock = is.dev ? true : acquireSingleInstanceLock(app, focusExistingWindow)
if (!hasSingleInstanceLock) {
  if (is.dev) {
    // Why: packaged runs have no attached console, but dev runs do. Emit a
    // single line so a `pnpm dev` operator does not mistake a silent exit
    // for a broken launcher.
    console.log(
      '[single-instance] Another Orca instance is already running against this userData path — focusing existing window.'
    )
  }
  app.quit()
}

// Why: when the lock is held by another process, we've already called
// app.quit() above. Skip every remaining file-writing side effect so this
// transient process never touches userData, and let handler registration
// below happen — those handlers only fire after whenReady, which app.quit()
// prevents from ever dispatching.
if (hasSingleInstanceLock) {
  installDevParentDisconnectQuit(is.dev)
  installDevParentWatchdog(is.dev)
  // Why: must run after configureDevUserDataPath (which redirects userData to
  // cohort-dev in dev mode) but before app.setName('Cohort') inside whenReady
  // (which would change the resolved path on case-sensitive filesystems).
  initDataPath()
  // Why: same timing constraint as initDataPath — capture the userData path
  // before app.setName changes it. See persistence.ts:20-28.
  initStatsPath()
  initClaudeUsagePath()
  initCodexUsagePath()
  enableMainProcessGpuFeatures()
}

function openMainWindow(): BrowserWindow {
  if (!store) {
    throw new Error('Store must be initialized before opening the main window')
  }
  if (!runtime) {
    throw new Error('Runtime must be initialized before opening the main window')
  }
  if (!stats) {
    throw new Error('Stats must be initialized before opening the main window')
  }
  if (!claudeUsage) {
    throw new Error('Claude usage store must be initialized before opening the main window')
  }
  if (!codexUsage) {
    throw new Error('Codex usage store must be initialized before opening the main window')
  }
  if (!rateLimits) {
    throw new Error('Rate limit service must be initialized before opening the main window')
  }
  if (!automations) {
    throw new Error('Automation service must be initialized before opening the main window')
  }
  if (!codexAccounts) {
    throw new Error('Codex account service must be initialized before opening the main window')
  }
  if (!codexRuntimeHome) {
    throw new Error('Codex runtime home service must be initialized before opening the main window')
  }
  if (!claudeAccounts) {
    throw new Error('Claude account service must be initialized before opening the main window')
  }
  if (!claudeRuntimeAuth) {
    throw new Error(
      'Claude runtime auth service must be initialized before opening the main window'
    )
  }

  // Why: Chromium's BrowserWindow constructor resets the userData DACL to a
  // Protected DACL. Grant explicit Full Control ACEs on all existing children
  // before the constructor runs so they survive the upcoming DACL reset.
  // Per-write EPERM retries in fs-utils/installer-utils serve as the backstop
  // for any directories created after startup.
  if (process.platform === 'win32') {
    try {
      grantDirAcl(app.getPath('userData'), { recursive: true })
    } catch {
      // Non-fatal; per-call retries are the backstop.
    }
  }

  const window = createMainWindow(store, {
    getIsQuitting: () => isQuitting,
    onQuitAborted: () => {
      isQuitting = false
    }
  })

  // Why: telemetry-plan.md§First-launch experience anchors default-on
  // `app_opened` to the first main-window load. Existing users in the
  // pending-banner cohort resolve through telemetry/client.ts; this load
  // path only fires once consent is already enabled.
  const onFirstWindowLoad = (): void => {
    if (!store) {
      return
    }
    const consent = resolveConsent(store.getSettings())
    if (consent.effective !== 'enabled') {
      return
    }
    trackAppOpenedOnce()
  }
  window.webContents.on('did-finish-load', onFirstWindowLoad)

  registerCoreHandlers(
    store,
    runtime,
    stats,
    claudeUsage,
    codexUsage,
    codexAccounts,
    claudeAccounts,
    rateLimits,
    window.webContents.id,
    automations
  )
  automations.setWebContents(window.webContents)
  automations.start()
  attachMainWindowServices(
    window,
    store,
    runtime,
    () => codexRuntimeHome!.prepareForCodexLaunch(),
    () => claudeRuntimeAuth!.prepareForClaudeLaunch()
  )
  rateLimits.attach(window)
  rateLimits.start()
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
    }
    automations?.setWebContents(null)
    // Why: detach the agent hook listener on window close so the server
    // never fires into a destroyed webContents during the gap before
    // reopen (e.g. macOS dock re-activation). This also ensures the
    // replay-loop through lastStatusByPaneKey runs only on deliberate
    // window recreations instead of stacking on top of stale listeners.
    agentHookServer.setListener(null)
    // Why: any running synthesized-title spinner intervals would fire into a
    // destroyed webContents; stop them all here instead of deferring to
    // per-pane teardown, which may never run for restored-but-never-torn-down
    // panes when the window goes away. stopSyntheticTitleSpinner deletes only
    // the current entry, which the Map iterator handles safely.
    for (const paneKey of syntheticTitleSpinnerByPaneKey.keys()) {
      stopSyntheticTitleSpinner(paneKey)
    }
  })
  mainWindow = window
  agentHookServer.setListener(
    ({ paneKey, tabId, worktreeId, connectionId, payload, receivedAt, stateStartedAt }) => {
      // Why: registry writes are an independent main-process side effect — the
      // chain executor polls this map regardless of window lifecycle. Hoist
      // above the isDestroyed() guard so a hidden/closing window (macOS dock-
      // hide, background-running) can't drop events and leave the runner
      // reading stale agent state. receivedAt is the hook server's
      // authoritative timestamp; using it (instead of Date.now()) keeps
      // registry ordering consistent with the renderer slice, which also keys
      // monotonic updates off updatedAt.
      // Why: forward `lastAssistantMessage` from the hook payload into the
      // registry so chain runners can surface the agent's actual reply (per
      // Claude Code's Stop hook contract — and Codex/OpenCode equivalents
      // normalized in agent-hooks/server.ts) without parsing terminal output.
      agentStatusRegistry.set(paneKey, {
        state: payload.state,
        updatedAt: receivedAt,
        ...(typeof payload.lastAssistantMessage === 'string' && payload.lastAssistantMessage
          ? { lastAssistantMessage: payload.lastAssistantMessage }
          : {})
      })
      // Why: a chain run-prompt step polls agent status against the registry on
      // each chain tick (60s cadence). Without this nudge, an agent that
      // finishes between ticks shows `done` in the sidebar but the chain step
      // stays `running` until the next scheduler cycle. Waking on any state
      // change collapses that gap.
      automations?.wakeChains()
      if (mainWindow?.isDestroyed()) {
        return
      }
      mainWindow?.webContents.send('agentStatus:set', {
        ...payload,
        paneKey,
        tabId,
        worktreeId,
        connectionId,
        receivedAt,
        stateStartedAt
      })
      // Why: cursor-agent's OSC title stays "Cursor Agent" for the whole turn,
      // and opencode's stays bare "OpenCode" — neither carries a working/idle
      // signal the title heuristic can read. Synthesize an OSC title update
      // from the hook state and inject it into the pane's data stream so the
      // existing renderer-side title tracker (which drives the sidebar
      // spinner, unread badge, and worktree status dot for every other agent)
      // lights up for these panes too. Braille prefix → working keyword path;
      // "action required" → permission; bare label → idle.
      const profile = SYNTHETIC_TITLE_PROFILES[payload.agentType ?? '']
      if (profile) {
        driveSyntheticTitleFromHook(paneKey, payload.state, profile)
      }
    }
  )
  return window
}

function shutdownWatchersOnce(): Promise<void> {
  if (watcherShutdownDone) {
    return Promise.resolve()
  }
  if (!watcherShutdownPromise) {
    // Why: @parcel/watcher tears down native async work during unsubscribe.
    // Electron must wait for that cleanup before Node's environment exits.
    watcherShutdownPromise = closeAllWatchers()
      .catch((error) => {
        console.error('[filesystem-watcher] shutdown failed:', error)
      })
      .then(() => {
        watcherShutdownDone = true
      })
  }
  return watcherShutdownPromise
}

// Why: Pi-style persistent spinner — cursor-agent re-emits its own
// "Cursor Agent" OSC title on every internal redraw, so a single synthesized
// "⠋ Cursor Agent" frame gets silently overwritten in the renderer within
// milliseconds and the sidebar dot snaps back to solid. Keep asserting a
// fresh working frame on an interval until the hook reports a non-working
// state. Interval matches Pi's 80ms cadence — fast enough for a smooth
// spinner, slow enough to stay well under the per-flush IPC budget.
// Why: opencode emits a single literal "OpenCode" title at startup and
// nothing thereafter, so a one-shot working frame would suffice for it. We
// reuse the same persistent-spinner mechanism rather than branching because
// the animated spinner is also nicer UX (matches every other working agent).
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPINNER_INTERVAL_MS = 80

// Why: per-agent labels for the synthesized titles. The detector classifies
// these labels via `containsAgentName` + spinner/keyword rules, so the chosen
// strings must round-trip through detectAgentStatusFromTitle to the right
// status. See agent-status.test.ts for the pinned classifications.
type SyntheticTitleProfile = {
  workingLabel: string
  permissionLabel: string
  idleLabel: string
}
const SYNTHETIC_TITLE_PROFILES: Record<string, SyntheticTitleProfile> = {
  cursor: {
    workingLabel: 'Cursor Agent',
    permissionLabel: 'Cursor - action required',
    idleLabel: 'Cursor ready'
  },
  opencode: {
    workingLabel: 'OpenCode',
    permissionLabel: 'OpenCode - action required',
    idleLabel: 'OpenCode ready'
  },
  droid: {
    workingLabel: 'Droid',
    permissionLabel: 'Droid - action required',
    idleLabel: 'Droid ready'
  }
}

const syntheticTitleSpinnerByPaneKey = new Map<
  string,
  { timer: ReturnType<typeof setInterval>; frame: number; profile: SyntheticTitleProfile }
>()

// Why: on PTY teardown the paneKey→ptyId mapping is dropped, so the spinner
// interval would keep firing but sendSyntheticTitle would no-op forever.
// Stop the interval explicitly so the process doesn't carry a timer per dead
// pane.
registerPaneKeyTeardownListener((paneKey) => {
  stopSyntheticTitleSpinner(paneKey)
})

function sendSyntheticTitle(ptyId: string, data: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }
  mainWindow.webContents.send('pty:data', { id: ptyId, data })
}

function stopSyntheticTitleSpinner(paneKey: string): void {
  const entry = syntheticTitleSpinnerByPaneKey.get(paneKey)
  if (entry) {
    clearInterval(entry.timer)
    syntheticTitleSpinnerByPaneKey.delete(paneKey)
  }
}

function driveSyntheticTitleFromHook(
  paneKey: string,
  state: string,
  profile: SyntheticTitleProfile
): void {
  const ptyId = getPtyIdForPaneKey(paneKey)
  if (!ptyId) {
    return
  }
  if (state === 'working') {
    // Why: immediately emit the first frame so the spinner starts visible at
    // this hook event even if the interval's next tick is 80ms away. Subsequent
    // frames come from the interval below.
    const existing = syntheticTitleSpinnerByPaneKey.get(paneKey)
    const frame = existing ? existing.frame : 0
    sendSyntheticTitle(ptyId, `\x1b]0;${SPINNER_FRAMES[frame]} ${profile.workingLabel}\x07`)
    if (existing) {
      // Why: refresh the profile so an agent-type change mid-pane (rare, but
      // possible if a hook reports a different agentType than the previous
      // event) lands on the right idle/permission labels at terminal state.
      existing.profile = profile
      return
    }
    const timer = setInterval(() => {
      const ptyIdNow = getPtyIdForPaneKey(paneKey)
      if (!ptyIdNow) {
        stopSyntheticTitleSpinner(paneKey)
        return
      }
      const cur = syntheticTitleSpinnerByPaneKey.get(paneKey)
      if (!cur) {
        return
      }
      cur.frame = (cur.frame + 1) % SPINNER_FRAMES.length
      sendSyntheticTitle(
        ptyIdNow,
        `\x1b]0;${SPINNER_FRAMES[cur.frame]} ${cur.profile.workingLabel}\x07`
      )
    }, SPINNER_INTERVAL_MS)
    syntheticTitleSpinnerByPaneKey.set(paneKey, { timer, frame, profile })
    return
  }
  // Why: leaving the spinner running after a `blocked`/`waiting`/`done` event
  // would immediately race the terminal state back to "working" on the next
  // tick. Stop first, then inject the terminal frame. Idle/done uses a
  // decorated "<Agent> ready" label rather than the bare native title — which
  // for cursor the detector deliberately treats as a no-op so cursor's own
  // per-turn re-emissions cannot clobber our synthesized state. The
  // done/permission frames also carry a trailing BEL (0x07 outside of any OSC
  // sequence) so the tab-level unread badge + notification dispatch in
  // pty-connection lights up — those key off BEL, not the working→idle title
  // transition.
  stopSyntheticTitleSpinner(paneKey)
  const label =
    state === 'blocked' || state === 'waiting' ? profile.permissionLabel : profile.idleLabel
  sendSyntheticTitle(ptyId, `\x1b]0;${label}\x07\x07`)
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.stablyai.orca')
  app.setName('Cohort')

  if (process.platform === 'darwin' && is.dev) {
    const dockIcon = nativeImage.createFromPath(devIcon)
    app.dock?.setIcon(dockIcon)
  }

  store = new Store()
  // Why: telemetry must initialize before any IPC handler / renderer can
  // call `track()`. The client is a no-op in dev/contributor builds
  // (`IS_OFFICIAL_BUILD === false`) and a no-op while `TELEMETRY_ENABLED`
  // is false in PR 2 — so this call is safe to run early; it only records
  // the Store reference, seeds common props, and resets per-session burst
  // caps. Actual transport initialization is still gated by both flags.
  initTelemetry(store)
  // Why: cohort-classifier reads the repo count synchronously at every emit
  // for cohort-extended events. The Store has been sync-loaded above, and
  // this init runs before any IPC handler is registered and before any
  // window loads — so the classifier is hydrated before any `track()` call,
  // regardless of whether it originates from the renderer, an IPC handler,
  // or `trackAppOpenedOnce` / `did-finish-load`.
  initCohortClassifier(store)
  initOnboardingCohortClassifier(store)
  stats = new StatsCollector()
  claudeUsage = new ClaudeUsageStore(store)
  codexUsage = new CodexUsageStore(store)
  rateLimits = new RateLimitService()
  codexRuntimeHome = new CodexRuntimeHomeService(store)
  codexAccounts = new CodexAccountService(store, rateLimits, codexRuntimeHome)
  claudeRuntimeAuth = new ClaudeRuntimeAuthService(store)
  claudeAccounts = new ClaudeAccountService(store, rateLimits, claudeRuntimeAuth)
  rateLimits.setCodexHomePathResolver(() => codexRuntimeHome!.prepareForRateLimitFetch())
  rateLimits.setClaudeAuthPreparationResolver(() => claudeRuntimeAuth!.prepareForRateLimitFetch())
  rateLimits.setSettingsResolver(() => store!.getSettings())
  rateLimits.setInactiveClaudeAccountsResolver(() => {
    const settings = store!.getSettings()
    return settings.claudeManagedAccounts
      .filter((account) => account.id !== settings.activeClaudeManagedAccountId)
      .map((account) => ({ id: account.id, managedAuthPath: account.managedAuthPath }))
  })
  rateLimits.setInactiveCodexAccountsResolver(() => {
    const settings = store!.getSettings()
    return settings.codexManagedAccounts
      .filter((account) => account.id !== settings.activeCodexManagedAccountId)
      .map((account) => ({ id: account.id, managedHomePath: account.managedHomePath }))
  })
  runtime = new OrcaRuntimeService(store, stats, {
    // Why: resolve the PTY provider lazily. initDaemonPtyProvider() runs later
    // inside attachMainWindowServices and calls setLocalPtyProvider(routedAdapter)
    // to swap the in-process provider for the daemon-routed one. Capturing the
    // provider reference eagerly here would freeze the pre-daemon LocalPtyProvider
    // and defeat the teardown helper's prefix sweep (design §4.3 wire-up).
    getLocalProvider: () => getLocalPtyProvider()
  })
  const runtimeRef = runtime
  const storeRef = store
  // Why: cleanup-service runs from the main process at startup and on a timer;
  // mainWindow can be in any state (null during bootstrap, destroyed during
  // shutdown). Read it through the module-level binding and skip when missing —
  // meta cleanup that the runWorktreeRemoval path performs is the load-bearing
  // work; the changed-notify is just a UI hint that the next list refresh
  // picks up anyway.
  // Why: E2E specs need a way to make a freshly-archived worktree immediately
  // past TTL without waiting 30 days or mutating persisted state by hand. The
  // override is a positive number (not 0) so the gt-threshold comparison still
  // captures the just-archived row deterministically.
  const archiveTtlOverrideRaw = process.env.ORCA_ARCHIVE_TTL_MS_OVERRIDE
  const archiveTtlOverride =
    archiveTtlOverrideRaw !== undefined && Number.isFinite(Number(archiveTtlOverrideRaw))
      ? Math.max(0, Number(archiveTtlOverrideRaw))
      : undefined
  archiveCleanup = createCleanupService({
    store: storeRef,
    runRemoval: async (worktreeId) => {
      const window = mainWindow
      if (!window || window.isDestroyed()) {
        return
      }
      // Why: skipArchive=true so we never auto-execute the repo's orca.yaml
      // `archive` hook from unsupervised cleanup. The user wasn't around to
      // confirm the hook-trust prompt 30 days earlier, and a collaborator
      // could have added a malicious script in the interim.
      await runWorktreeRemoval(
        { worktreeId, force: false, skipArchive: true },
        { store: storeRef, runtime: runtimeRef, mainWindow: window }
      )
    },
    runGroupRemoval: async (groupId) => {
      const window = mainWindow
      if (!window || window.isDestroyed()) {
        return
      }
      const group = storeRef.getWorkspaceGroups().find((g) => g.id === groupId)
      if (!group) {
        return
      }
      // Why: clean members were already dropped by the worktree cleanup loop
      // (they carry their own archived meta). A member still present here is
      // dirty — runWorktreeRemoval (force:false) throws, which bubbles up so the
      // group stays archived (with archiveCleanupError) and retries next tick.
      // skipArchive=true: never auto-run the repo's archive hook unsupervised.
      for (const memberWorktreeId of group.memberWorktreeIds) {
        if (!storeRef.getWorktreeMeta(memberWorktreeId)) {
          continue
        }
        await runWorktreeRemoval(
          { worktreeId: memberWorktreeId, force: false, skipArchive: true },
          { store: storeRef, runtime: runtimeRef, mainWindow: window }
        )
      }
      // Why: members' leaf dirs are gone, so the shared group folder is now
      // empty — drop it with the record. force:true no-ops if it never existed.
      if (group.parentPath) {
        await rm(group.parentPath, { recursive: true, force: true })
      }
      storeRef.removeWorkspaceGroup(groupId)
      notifyWorkspaceGroupsChanged(window)
    },
    ...(archiveTtlOverride !== undefined ? { ttlMs: archiveTtlOverride } : {})
  })
  // Why: archiveCleanup.start() is deferred until after openMainWindow() runs
  // (below) so the immediate runOnce() inside start() sees a live mainWindow.
  // Starting here would short-circuit every candidate via the runRemoval
  // null-window guard, defeating the "user quit Orca for 30+ days" tick.
  // Why: E2E specs trigger the cleanup tick on demand to assert TTL behaviour
  // without waiting for the hourly setInterval. Guarded by ORCA_E2E so the
  // handler is never registered in shipping builds.
  if (process.env.ORCA_E2E_USER_DATA_DIR) {
    ipcMain.removeHandler('worktrees:_archiveCleanupNow')
    ipcMain.handle('worktrees:_archiveCleanupNow', async () => {
      await archiveCleanup?.runOnce()
    })
  }
  // Why: assemble the auto-trigger engine alongside the AutomationService so
  // both share a single store/lifecycle. The Linear source pulls its client
  // lazily via getClient (called fresh on each poll / fetchOptions) so a
  // connect/disconnect after app boot is observed on the next tick without
  // rebuilding the registry.
  const triggerSourceRegistry = new TriggerSourceRegistry()
  triggerSourceRegistry.register(makeLinearIssueSource({ getClient: () => getLinearClient() }))
  triggerSourceRegistry.register(makeGithubPrSource({ getRepos: () => storeRef.getRepos() }))
  triggerSourceRegistry.register(makeHttpEndpointSource())
  triggerSourceRegistry.register(makeScheduleSource())
  // Why: bridge the source catalog + fetchOptions to the renderer before any
  // window is opened so the first TriggersModal mount has the handlers ready.
  registerTriggerSourceHandlers(triggerSourceRegistry)
  // TODO(SSH): hostId varies per remote target once SSH execution lands.
  const AUTO_TRIGGER_HOST_ID = 'local'
  // TODO(persist): in-memory until we add a per-source watermark table to the
  // settings store; restart falls back to enabledAt and re-polls any backlog.
  const autoTriggerWatermarks = new Map<string, number>()
  // Per-http-trigger interval clock, keyed by trigger id. In-memory like the
  // source watermarks above.
  const httpTriggerLastPoll = new Map<string, number>()
  // Per-schedule-trigger next-fire instant; in-memory so it re-anchors each start.
  const scheduleNextRun = new Map<string, number>()
  // Signature (cron|timezone) each anchor was computed for; lets the engine
  // re-anchor when a trigger's schedule is edited instead of firing the stale instant.
  const scheduleAnchorSig = new Map<string, string>()
  // Why: dispatchAutoRun lives on AutomationService but the engine needs it as
  // a ctor dep — late-bind via serviceRef so both can coexist. The engine's
  // start/stop lifecycle is owned by AutomationService.start()/stop() so the
  // service receives the engine as an opt below.
  let serviceRef: AutomationService | null = null
  const autoTriggerEngine = new AutoTriggerEngine({
    registry: triggerSourceRegistry,
    listAutomations: () => storeRef.listAutomations(),
    dispatchAutoRun: async ({ automation, trigger, rule, event }) => {
      if (!serviceRef) {
        // Why: defensive — the engine is started by service.start() so this
        // branch should be unreachable in practice. Log and skip rather than
        // throw so a single missed wiring doesn't crash the tick loop.
        console.warn('[auto-trigger] dispatchAutoRun called before service init')
        return
      }
      await serviceRef.dispatchAutoRun({ automation, trigger, rule, event })
    },
    dedupHas: (a, t, e) => storeRef.hasAutomationAutoDedup(a, t, e),
    dedupInsert: (automationId, autoTriggerId, sourceId, entityId, entityIdentifier, firedAt) => {
      storeRef.insertAutomationAutoDedup({
        automationId,
        autoTriggerId,
        sourceId,
        entityId,
        ...(entityIdentifier !== undefined ? { entityIdentifier } : {}),
        firedAt
      })
    },
    lastPoll: (sourceId: TriggerSourceId, hostId) =>
      autoTriggerWatermarks.get(`${sourceId}|${hostId}`) ?? 0,
    lastPollSet: (sourceId: TriggerSourceId, hostId, value) => {
      autoTriggerWatermarks.set(`${sourceId}|${hostId}`, value)
    },
    httpLastPoll: (triggerId) => httpTriggerLastPoll.get(triggerId) ?? 0,
    httpLastPollSet: (triggerId, value) => {
      httpTriggerLastPoll.set(triggerId, value)
    },
    scheduleNextRun: (id) => scheduleNextRun.get(id) ?? 0,
    scheduleNextRunSet: (id, value) => {
      scheduleNextRun.set(id, value)
    },
    scheduleAnchorSig: (id) => scheduleAnchorSig.get(id) ?? '',
    scheduleAnchorSigSet: (id, sig) => {
      scheduleAnchorSig.set(id, sig)
    },
    hostId: AUTO_TRIGGER_HOST_ID,
    now: () => Date.now()
  })
  automations = new AutomationService(store, {
    autoTriggerEngine,
    getAutoTriggerPollIntervalSeconds: () => storeRef.getAutomationsPollIntervalSeconds(),
    // Why: hand the registry's reader to the service so the chain executor
    // can construct RunPromptRunner with main-process status access.
    getAgentStatus: (paneKey) => agentStatusRegistry.get(paneKey),
    // Why: hand the setup-script registry's reader to the service so the
    // chain executor's WaitForSetupRunner (wired in P2.5) can read setup
    // state directly. Stored now for a stable constructor surface.
    getSetupScript: (worktreeId) => setupScriptRegistry.get(worktreeId),
    // Why: hand the PTY exit registry's reader to the service so the chain
    // executor's RunCommandRunner can detect command completion directly.
    getPtyExit: (ptyId) => ptyExitRegistry.get(ptyId),
    // Why: hand the PTY data subscription bridge to the service so the chain
    // executor's RunCommandRunner can capture the command `outputTail`
    // intra-process — same flush window as the renderer broadcast.
    subscribePtyData: (listener) => subscribePtyData(listener),
    // Why: hand the paneKey → ptyId lookup to the service so RunPromptRunner
    // can subscribe to its prompt pane's data stream and capture the agent's
    // last-turn output.
    getPtyIdForPaneKey: (paneKey) => getPtyIdForPaneKey(paneKey),
    // Why: bridge the chain's narrow create-worktree dep onto the runtime's
    // wider managed-worktree create API. `runHooks: true` launches the repo's
    // setup script (which the next `wait-for-setup` step is built to observe);
    // `activate: false` ensures a chain run doesn't yank the user's focus into
    // the new worktree (createManagedWorktree maps runHooks=true to
    // setupDecision='run' internally, so 'inherit' here is a no-op fallback for
    // when runHooks ever toggles off in a future config). NOTE: the runner's
    // `linkedIssue` is for Linear; createManagedWorktree's `linkedIssue` field
    // is a numeric GitHub issue ID — incompatible. Linear linkage is stamped
    // via setWorktreeMeta after creation.
    // Why (grouped-workspaces L3): bridge the chain runner onto the shared
    // create-workspace-group helper so the IPC handler and the automation
    // runner take the same validate/create/rollback path. The runner hands
    // over a normalized shape with `branchName` doubling as workspaceName +
    // branch name (mirroring the IPC contract); we map members' `baseBranch`
    // onto the IPC's `baseRef` field and pass through the
    // createdByAutomationRunId for sidebar attribution.
    createWorkspaceGroup: async (input) => {
      if (!mainWindow) {
        throw new Error('createWorkspaceGroup: no mainWindow available.')
      }
      // Why: chain-shape automations may leave branchName empty when the user
      // wants the group name auto-generated (just like the manual composer
      // and the create-worktree wiring above). Generate an adjective_noun
      // slug against the same taken-names set the manual composer + IPC
      // validator use (repo folder basenames + existing group workspaceNames)
      // so the new slug can never collide with a sibling. The slug doubles
      // as the workspaceName AND the per-member branch — matches the runner
      // contract where branchName plays a triple role today.
      const resolvedBranchName =
        input.branchName.trim() ||
        generateUniqueWorkspaceName(
          new Set([
            ...storeRef.getRepos().map(repoFolderName),
            ...storeRef.getWorkspaceGroups().map((g) => g.workspaceName)
          ])
        )
      const result = await createWorkspaceGroupFlow(
        {
          workspaceName: resolvedBranchName,
          displayName: input.displayName,
          branchName: resolvedBranchName,
          members: input.members.map((m) => ({
            repoId: m.repoId,
            baseRef: m.baseBranch ? m.baseBranch : null,
            setupDecision: m.setupDecision
          })),
          ...(input.createdByAutomationRunId
            ? { createdByAutomationRunId: input.createdByAutomationRunId }
            : {}),
          linkedLinearIssue: input.linkedIssue?.id ?? null
        },
        { store: storeRef, runtime: runtimeRef, mainWindow }
      )
      return {
        groupId: result.group.id,
        memberWorktreeIds: result.memberWorktrees.map((wt) => wt.id),
        parentPath: result.group.parentPath
      }
    },
    createWorktree: async (input) => {
      // Why: chain-shape automations don't ask the user for a worktree name —
      // mirror the renderer's NewWorkspaceComposer flow by generating an
      // adjective_noun slug per repo and feeding it as the canonical
      // workspaceName. createManagedWorktree's slug mode then uses it for both
      // folder + branch with no prefix; sanitizeWorktreeName is skipped, so an
      // empty displayName no longer trips "Invalid worktree name".
      const trimmedDisplay = input.displayName.trim()
      const generatedSlug = generateUniqueWorkspaceName(
        collectTakenWorkspaceNamesForRepo(input.repoId, storeRef.getAllWorktreeMeta())
      )
      // Why: automation runs must happen in the background — never yank the
      // user's focus into the new worktree. `runHooks: true` would force
      // activation inside createManagedWorktree (shouldActivate ORs runHooks),
      // so we pass `runHooks: false` and request the setup script explicitly
      // via `setupDecision: 'run'`. The wait-for-setup step still observes the
      // setup PTY through the same registry.
      const result = await runtimeRef.createManagedWorktree({
        repoSelector: input.repoId,
        name: trimmedDisplay || generatedSlug,
        workspaceName: generatedSlug,
        baseBranch: input.baseBranch,
        linkedIssue: null,
        ...(input.createdByAutomationRunId
          ? { createdByAutomationRunId: input.createdByAutomationRunId }
          : {}),
        runHooks: false,
        activate: false,
        setupDecision: 'run'
      })
      if (input.linkedIssue?.id) {
        storeRef.setWorktreeMeta(result.worktree.id, {
          linkedLinearIssue: input.linkedIssue.id
        })
      }
      return {
        worktreeId: result.worktree.id,
        path: result.worktree.path,
        branch: result.worktree.branch
      }
    },
    createWorktreeFromPr: async (input) => {
      if (!mainWindow) {
        throw new Error('createWorktreeFromPr: no mainWindow available.')
      }
      const repo = storeRef.getRepo(input.repoId)
      if (!repo) {
        throw new Error(`createWorktreeFromPr: repo not found: ${input.repoId}`)
      }
      const resolved = await resolvePrBaseCore({
        repo,
        prNumber: input.prNumber,
        headRefName: input.headRefName,
        isCrossRepository: input.isCrossRepository
      })
      // Why: surface resolve failures as a thrown Error so the runner's
      // try/catch fails the create-worktree step with the underlying message.
      if ('error' in resolved) {
        throw new Error(resolved.error)
      }
      const slug = generateUniqueWorkspaceName(
        collectTakenWorkspaceNamesForRepo(input.repoId, storeRef.getAllWorktreeMeta())
      )
      const trimmedDisplay = input.displayName.trim()
      const result = await createLocalWorktree(
        {
          repoId: input.repoId,
          name: trimmedDisplay || slug,
          workspaceName: slug,
          ...(trimmedDisplay ? { displayName: trimmedDisplay } : {}),
          baseBranch: resolved.baseBranch,
          linkedPR: input.prNumber,
          ...(resolved.pushTarget ? { pushTarget: resolved.pushTarget } : {}),
          ...(input.createdByAutomationRunId
            ? { createdByAutomationRunId: input.createdByAutomationRunId }
            : {}),
          // Why: WorkspaceSource has no 'automation' member; 'unknown' is the
          // neutral fallback for non-user-initiated creates.
          telemetrySource: 'unknown'
        },
        repo,
        storeRef,
        mainWindow,
        runtimeRef
      )
      return {
        worktreeId: result.worktree.id,
        path: result.worktree.path,
        branch: result.worktree.branch
      }
    },
    // Why: resolve the renderer + ipc lazily so the RunPromptRunner picks up
    // the current BrowserWindow on each tick (it can change across reload)
    // and so the service stays decoupled from the import-time `electron`
    // module surface — keeps service.test.ts free of an Electron mock.
    getWebContents: () => mainWindow?.webContents ?? null,
    getIpcMain: () => ipcMain
  })
  // Why: complete the late-bind so the engine's dispatchAutoRun closure can
  // route into the now-constructed AutomationService. start() may fire the
  // engine timer immediately, but the first poll won't run until the engine's
  // setInterval cadence elapses, so this assignment lands before any dispatch.
  serviceRef = automations
  runtime.setAccountServices({ claudeAccounts, codexAccounts, rateLimits })
  runtime.setAgentBrowserBridge(new AgentBrowserBridge(browserManager))
  nativeTheme.themeSource = store.getSettings().theme ?? 'system'
  // Why: managed hook installation mutates user-global agent config. Each
  // installer runs inside its own try/catch so a malformed local config
  // (e.g. corrupted ~/.claude/settings.json) cannot brick Orca startup.
  // The agent label travels with each installer so the catch can attribute
  // the failure in the `agent_hook_install_failed` telemetry event.
  runManagedHookInstallers([
    ['claude', () => claudeHookService.install()],
    ['codex', () => codexHookService.install()],
    ['gemini', () => geminiHookService.install()],
    ['cursor', () => cursorHookService.install()],
    ['droid', () => droidHookService.install()]
  ])

  registerAppMenu({
    onCheckForUpdates: (options) => checkForUpdatesFromMenu(options),
    onOpenSettings: () => {
      mainWindow?.webContents.send('ui:openSettings')
    },
    onZoomIn: () => {
      mainWindow?.webContents.send('terminal:zoom', 'in')
    },
    onZoomOut: () => {
      mainWindow?.webContents.send('terminal:zoom', 'out')
    },
    onZoomReset: () => {
      mainWindow?.webContents.send('terminal:zoom', 'reset')
    },
    onToggleLeftSidebar: () => {
      mainWindow?.webContents.send('ui:toggleLeftSidebar')
    },
    onToggleRightSidebar: () => {
      mainWindow?.webContents.send('ui:toggleRightSidebar')
    },
    onToggleAppearance: (key) => {
      if (!store) {
        return
      }
      if (key === 'statusBarVisible') {
        // Why: status bar visibility lives under the persisted UI state
        // (ui:set/ui:get), not settings. The renderer owns the authoritative
        // toggle logic (it knows the current value and persists it back), so
        // we forward the event and let it flip + store.
        mainWindow?.webContents.send('ui:toggleStatusBar')
        return
      }
      const current = store.getSettings()
      store.updateSettings({ [key]: !current[key] })
      // Why: settings:get returns the current snapshot; renderer tracks
      // settings through window.api.settings.get(). Push the new value so
      // the sidebar/titlebar re-render without waiting for a round-trip.
      mainWindow?.webContents.send('settings:changed', { [key]: !current[key] })
      rebuildAppMenu()
    },
    getAppearanceState: () => {
      const settings = store?.getSettings()
      const ui = store?.getUI()
      return {
        showTasksButton: settings?.showTasksButton !== false,
        showTitlebarAppName: settings?.showTitlebarAppName !== false,
        statusBarVisible: ui?.statusBarVisible !== false
      }
    }
  })
  // Why: E2E tests launch parallel Electron instances that would all race to
  // bind the default fixed port, crashing on EADDRINUSE. Port 0 lets the OS
  // assign a random available port per instance while still exercising the
  // full WebSocket startup path.
  const isE2E = Boolean(process.env.ORCA_E2E_USER_DATA_DIR)
  // Why: a developer running `pnpm dev` while the packaged Orca is also open
  // would otherwise race the packaged app for 6768 and silently fall back to
  // a random OS-assigned port — breaking deterministic mobile pairing/repro
  // scripts against the dev instance. Pin the first dev instance to 6769 so
  // ws://127.0.0.1:6769 is stable; a second dev instance still falls back via
  // ws-transport's EADDRINUSE handler.
  const devWsPort = is.dev && !isE2E ? 6769 : undefined
  runtimeRpc = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: app.getPath('userData'),
    enableWebSocket: true,
    ...(isE2E ? { wsPort: 0 } : {}),
    ...(devWsPort !== undefined ? { wsPort: devWsPort } : {})
  })
  registerMobileHandlers(runtimeRpc)

  await startFirstWindowStartupServices({
    // Why: the persistent-terminal daemon is always started. If it fails, the
    // LocalPtyProvider remains as the implicit fallback — terminals work, just
    // without cross-restart persistence.
    startDaemonPtyProvider: () => initDaemonPtyProvider(),
    // Why: PTY spawn env reads ORCA_AGENT_HOOK_* from the live server state,
    // so the hook server must start before restored terminals can mount.
    startAgentHookServer: () =>
      agentHookServer.start({
        env: app.isPackaged ? 'production' : 'development',
        // Why: hooks source this endpoint file at invocation time, so old PTY
        // env still reaches the current Orca process after an app restart.
        userDataPath: app.getPath('userData')
      }),
    onDaemonError: (error) => {
      console.error('[daemon] Failed to start daemon PTY provider, falling back to local:', error)
    },
    onAgentHookServerError: (error) => {
      // Why: Claude/Codex/Gemini/OpenCode/Cursor hook callbacks are sidebar
      // enrichment only. Orca must still boot if the loopback receiver fails.
      console.error('[agent-hooks] Failed to start local hook server:', error)
    }
  })

  // Why: once the hook server is ready (or has already failed open), window
  // creation and runtime RPC startup are independent.
  const [win] = await Promise.all([
    Promise.resolve(openMainWindow()),
    runtimeRpc.start().catch((error) => {
      console.error('[runtime] Failed to start local RPC transport:', error)
    })
  ])

  // Why: start archive cleanup now that mainWindow is assigned — the
  // immediate runOnce() inside start() needs a live window so the
  // 30-day-quit cleanup tick actually fires on launch (not waiting an
  // extra hour for the next setInterval pass).
  archiveCleanup.start()

  // Why: the macOS notification permission dialog must fire after the window
  // is visible and focused. If it fires before the window exists, the system
  // dialog either doesn't appear or gets immediately covered by the maximized
  // window, making it impossible for the user to click "Allow".
  win.once('show', () => {
    // Why: store can be null if init failed earlier; bail rather than risk a
    // throw inside an Electron event listener.
    if (!store) {
      return
    }
    const onboarding = store.getOnboarding()
    if (onboarding.closedAt !== null) {
      triggerStartupNotificationRegistration(store)
    }
  })

  app.on('activate', () => {
    // Don't re-open a window while Squirrel's ShipIt is replacing the .app
    // bundle.  Without this guard the old version gets resurrected and the
    // update never applies.
    if (BrowserWindow.getAllWindows().length === 0 && !isQuittingForUpdate()) {
      openMainWindow()
    }
  })
})

app.on('before-quit', () => {
  isQuitting = true
  // Why: PTY cleanup is deferred to will-quit so the renderer has a chance to
  // capture terminal scrollback buffers before PTY exit events race in and
  // unmount TerminalPane components (removing their capture callbacks).
  // The window close handler passes isQuitting to the renderer so it skips the
  // child-process confirmation dialog and proceeds directly to buffer capture.
  archiveCleanup?.stop()
  rateLimits?.stop()
  // Why: run/setup script PTYs need an explicit teardown here (not in will-quit)
  // so their run:exited / setup:exited broadcasts reach the renderer while the
  // BrowserWindow is still alive — by the time killAllPty runs in will-quit
  // the renderer is likely already torn down. Best-effort; cleanup races are
  // tolerated and we don't await so quit isn't blocked.
  void killAllRunScripts()
  void killAllSetupScripts()
})

// Why: will-quit fires twice when daemon disconnect needs an async flush.
// First pass: run all sync cleanup, then preventDefault to await the final
// checkpoint writes. Second pass (after disconnect resolves): skip the
// async work and let Electron exit.
let daemonDisconnectDone = false
app.on('will-quit', (e) => {
  // Why: stats.flush() must run before killAllPty() so it can read the
  // live agent state and emit synthetic agent_stop events for agents that
  // are still running. killAllPty() does not call runtime.onPtyExit(),
  // so without this ordering, running agents would produce orphaned
  // agent_start events with no matching stops.
  automations?.stop()
  setUnreadDockBadgeCount(0)
  agentHookServer.stop()
  stats?.flush()
  // Why: agent-browser daemon processes would otherwise linger after Orca quits,
  // holding ports and leaving stale session state on disk.
  runtime?.getAgentBrowserBridge()?.destroyAllSessions()
  killAllPty()
  const watcherShutdown = shutdownWatchersOnce()
  store?.flush()

  // Why: disconnectDaemon writes final checkpoints via async getSnapshot RPCs.
  // Without preventDefault, Electron exits before the RPCs complete and the
  // checkpoint data is lost. The guard prevents an infinite quit loop —
  // app.quit() re-fires will-quit, but the second pass skips straight through.
  if (!daemonDisconnectDone) {
    e.preventDefault()
    // Why: capture ownership synchronously (before any await) so the guard
    // still has the right pid/runtimeId to compare against if shutdown
    // partially clears global state. Evaluating these inside .then() would
    // let a later teardown path null them out mid-chain.
    const ownedPid = process.pid
    const ownedRuntimeId = runtime?.getRuntimeId()
    // Why: the construction of rpcStopAndClear AND the allSettled() below must
    // both live inside the `!daemonDisconnectDone` guard. will-quit re-fires
    // after app.quit() below; without this guard, the second pass would
    // re-invoke runtimeRpc.stop() (redundant rmSync on an already-removed
    // socket) and re-run the ownership-guarded clear against a metadata file
    // that may now belong to the auto-updater's replacement process.
    const rpcStopAndClear = runtimeRpc
      ? runtimeRpc
          .stop()
          .then(() => {
            if (ownedRuntimeId) {
              clearRuntimeMetadataIfOwned(app.getPath('userData'), ownedPid, ownedRuntimeId)
            }
          })
          .catch((error) => {
            console.error('[runtime] Failed to stop local RPC transport:', error)
          })
      : Promise.resolve()
    // Why: Promise.allSettled — we need BOTH the daemon disconnect and the
    // RPC stop + owned-metadata clear to complete before Electron exits.
    // Using allSettled (not all) preserves the existing fail-open posture:
    // if disconnectDaemon rejects, we still quit instead of hanging the app.
    //
    // Telemetry shutdown folds in after the daemon/RPC teardown and BEFORE
    // app.quit(): the PostHog client has up to 2s of bounded flush. Errors
    // inside `shutdownTelemetry()` are caught by the client itself — we
    // catch again here defensively so a flush failure cannot cancel the
    // quit chain.
    Promise.allSettled([disconnectDaemon(), rpcStopAndClear, watcherShutdown])
      .then(() => shutdownTelemetry())
      .catch(() => {
        /* swallow — telemetry must never prevent app.quit() */
      })
      .then(() => {
        daemonDisconnectDone = true
        app.quit()
      })
  }
})

app.on('window-all-closed', () => {
  // Why: on macOS, closing all windows normally keeps the app alive (dock
  // stays active). But when a quit is in progress (Cmd+Q), the window close
  // handler defers to the renderer for buffer capture, which cancels the
  // original quit sequence. Re-trigger quit here so the app actually exits
  // instead of requiring a second Cmd+Q.
  if (process.platform !== 'darwin' || isQuitting) {
    app.quit()
  }
})
