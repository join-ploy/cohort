import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { buildAgentStartupPlan, type AgentStartupPlan } from '@/lib/tui-agent-startup'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { TuiAgent, Worktree } from '../../../shared/types'
import type { LaunchSource } from '../../../shared/telemetry-events'
import { FIRST_PANE_ID } from '../../../shared/pane-key'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree-id'
import {
  registerEagerPtyBuffer,
  subscribeToPtyData,
  subscribeToPtyExit
} from '@/components/terminal-pane/pty-dispatcher'
import { createAgentStatusOscProcessor } from '@/components/terminal-pane/agent-status-osc'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'

export type LaunchAgentBackgroundSessionArgs = {
  agent: TuiAgent
  worktreeId: string
  prompt?: string
  launchSource?: LaunchSource
  title?: string
  onExit?: (ptyId: string, code: number) => void
  onAgentStatus?: (payload: ParsedAgentStatusPayload) => void
  /** When the caller already knows the worktree's path and owning repo
   *  connectionId (e.g. the chain executor in main hands these over so the
   *  renderer doesn't need its cache), pass them here. Bypasses the renderer
   *  cache lookup entirely — useful when the worktree was created
   *  milliseconds earlier and the `worktrees:changed` broadcast may not have
   *  settled yet. */
  worktreeOverride?: {
    path: string
    connectionId: string | null
  }
  /** Ask C (grouped-workspaces member-scoped runs): forwards to `pty.spawn`'s
   *  `keepCwd` so Phase J1's grouped-worktree cwd override doesn't redirect
   *  the agent's CWD to the group's parentPath. The tab is still bound to
   *  the supplied `worktreeId` (so the group's card / stop-all keeps owning
   *  it); only the CWD changes. */
  keepCwd?: boolean
}

export type LaunchAgentBackgroundSessionResult = {
  tabId: string
  ptyId: string
  startupPlan: AgentStartupPlan
}

async function resolveWorktreeWithRetry(worktreeId: string): Promise<Worktree | undefined> {
  // Why: chain-shape automations call this immediately after creating a
  // worktree in the main process. The `worktrees:changed` broadcast that
  // populates the renderer cache is async, so the lookup can race ahead.
  // Force a fetch for the owning repo and retry the lookup briefly before
  // giving up; this turns a flaky race into a deterministic resolution.
  let worktree = useAppStore
    .getState()
    .allWorktrees()
    .find((entry) => entry.id === worktreeId)
  if (worktree) {
    return worktree
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  if (!repoId) {
    return undefined
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    await useAppStore.getState().fetchWorktrees(repoId)
    worktree = useAppStore
      .getState()
      .allWorktrees()
      .find((entry) => entry.id === worktreeId)
    if (worktree) {
      return worktree
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return undefined
}

export async function launchAgentBackgroundSession(
  args: LaunchAgentBackgroundSessionArgs
): Promise<LaunchAgentBackgroundSessionResult | null> {
  const {
    agent,
    worktreeId,
    prompt,
    launchSource,
    title,
    onExit,
    onAgentStatus,
    worktreeOverride,
    keepCwd
  } = args
  // Why: when the caller pre-resolved the worktree info, skip the cache
  // lookup entirely. This is the chain-executor path — main already knows
  // the path + connectionId and hands them over so we don't race the
  // renderer's `worktrees:changed` broadcast.
  let worktreePath: string
  let connectionId: string | null
  if (worktreeOverride) {
    worktreePath = worktreeOverride.path
    connectionId = worktreeOverride.connectionId
  } else {
    const worktree = await resolveWorktreeWithRetry(worktreeId)
    if (!worktree) {
      throw new Error('The target workspace is no longer available.')
    }
    const repo = useAppStore.getState().repos.find((entry) => entry.id === worktree.repoId) ?? null
    worktreePath = worktree.path
    connectionId = repo?.connectionId ?? null
  }
  const store = useAppStore.getState()
  const cmdOverrides = store.settings?.agentCmdOverrides ?? {}
  const trimmedPrompt = prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  const isFollowupPath = TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start'

  let startupPlan: AgentStartupPlan | null = null
  let pasteDraftAfterLaunch: string | null = null
  if (hasPrompt && isFollowupPath) {
    startupPlan = buildAgentStartupPlan({
      agent,
      prompt: '',
      cmdOverrides,
      platform: CLIENT_PLATFORM,
      allowEmptyPromptLaunch: true
    })
    pasteDraftAfterLaunch = trimmedPrompt
  } else {
    startupPlan = buildAgentStartupPlan({
      agent,
      prompt: hasPrompt ? trimmedPrompt : '',
      cmdOverrides,
      platform: CLIENT_PLATFORM,
      allowEmptyPromptLaunch: !hasPrompt
    })
  }
  if (!startupPlan) {
    return null
  }

  // Why: spawn-first avoids the same TerminalPane auto-spawn race as
  // run-command automation. If a hidden prompt tab is revealed while spawn is
  // in flight, the visible pane must observe initialPtyId, not a null ptyId.
  const tabId = globalThis.crypto.randomUUID()
  const paneKey = `${tabId}:${FIRST_PANE_ID}`
  // Why: agent hook callbacks are keyed by pane, and background automation
  // tabs never mount a TerminalPane to inject this env for us.
  const paneEnv = {
    ...startupPlan.env,
    ORCA_PANE_KEY: paneKey,
    ORCA_TAB_ID: tabId,
    ORCA_WORKTREE_ID: worktreeId
  }
  const result = await window.api.pty.spawn({
    cols: 120,
    rows: 40,
    cwd: worktreePath,
    command: startupPlan.launchCommand,
    env: paneEnv,
    connectionId,
    worktreeId,
    tabId,
    leafId: 'pane:1',
    telemetry: {
      agent_kind: tuiAgentToAgentKind(agent),
      launch_source: launchSource ?? 'unknown',
      request_kind: 'new'
    },
    // Why (Ask C): when a chain runner flags this launch as member-scoped,
    // suppress Phase J1's grouped-worktree cwd override so the agent stays
    // rooted at the member worktree's path.
    ...(keepCwd ? { keepCwd: true } : {})
  })
  const tab = store.createTab(worktreeId, undefined, undefined, {
    activate: false,
    id: tabId,
    initialPtyId: result.id
  })
  if (title) {
    store.setTabCustomTitle(tab.id, title)
  }
  let exitHandled = false
  let unsubscribeExit = (): void => {}
  let unsubscribeData = (): void => {}
  const handleExit = (ptyId: string, code: number): void => {
    if (exitHandled) {
      return
    }
    exitHandled = true
    unsubscribeExit()
    unsubscribeData()
    useAppStore.getState().clearTabPtyId(tab.id, ptyId)
    onExit?.(ptyId, code)
  }
  registerEagerPtyBuffer(result.id, handleExit)
  const processAgentStatus = createAgentStatusOscProcessor()
  unsubscribeData = subscribeToPtyData(result.id, (data) => {
    const processed = processAgentStatus(data)
    for (const payload of processed.payloads) {
      useAppStore.getState().setAgentStatus(paneKey, payload, undefined)
      onAgentStatus?.(payload)
    }
  })
  // Why: opening the workspace attaches a real terminal transport and disposes
  // the eager exit handler. This sidecar keeps automation completion tracking
  // alive regardless of whether the tab is hidden or mounted.
  unsubscribeExit = subscribeToPtyExit(result.id, (code) => handleExit(result.id, code))

  if (pasteDraftAfterLaunch !== null) {
    void pasteDraftWhenAgentReady({
      tabId: tab.id,
      content: pasteDraftAfterLaunch,
      agent,
      submit: true,
      onTimeout: () => {
        toast.message("Your automation prompt wasn't sent — open the workspace and paste it.")
        track('agent_error', {
          error_class: 'paste_readiness_timeout',
          agent_kind: tuiAgentToAgentKind(agent)
        })
      }
    })
  }

  return { tabId: tab.id, ptyId: result.id, startupPlan }
}
