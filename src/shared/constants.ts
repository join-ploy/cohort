/* eslint-disable max-lines -- Why: this file is the single source of truth
   for default global settings, default repo hook settings, default
   onboarding state, default UI state, default workspace session, and a
   handful of related shared constants. Splitting it would only spread the
   defaults across multiple files without a meaningful boundary. */
import type {
  GlobalSettings,
  NotificationSettings,
  OnboardingChecklistState,
  OnboardingState,
  PersistedState,
  PersistedUIState,
  RepoHookSettings,
  SidebarPromptCommand,
  StatusBarItem,
  WorkspaceSessionState,
  WorktreeCardProperty
} from './types'
import { DEFAULT_TERMINAL_FONT_WEIGHT } from './terminal-fonts'

export const SCHEMA_VERSION = 1
export const DEFAULT_APP_FONT_FAMILY = 'Geist'

// Why: the onboarding wizard's last step index. Centralized so backfill,
// clamps, and UI step references all agree on the same upper bound.
export const ONBOARDING_FINAL_STEP = 4

export const ORCA_BROWSER_PARTITION = 'persist:orca-browser'
// Why: blank browser tabs must start from an inert guest URL that does not
// navigate the privileged main window to about:blank. Renderer and main both
// need the exact same value so the attach policy can allow only this one safe
// data URL while still rejecting arbitrary renderer-provided data URLs.
export const ORCA_BROWSER_BLANK_URL = 'data:text/html,'

// Why: Electron's invoke error path preserves message text, not arbitrary
// custom Error fields. Keep this stable token shared across main/renderer.
export const SSH_TERMINATE_RECONNECT_REQUIRED = 'SSH_TERMINATE_RECONNECT_REQUIRED'

export const BROWSER_FAMILY_LABELS: Record<string, string> = {
  chrome: 'Google Chrome',
  chromium: 'Chromium',
  arc: 'Arc',
  edge: 'Microsoft Edge',
  brave: 'Brave',
  firefox: 'Firefox',
  safari: 'Safari',
  manual: 'File'
}

// Why: Geist Mono ships with the app as a web font (see main.css @font-face),
// so the default terminal face is identical on macOS, Linux, and Windows
// without depending on what monospace the user happens to have installed.
// buildFontFamily() still adds the full cross-platform fallback chain on top.
function defaultTerminalFontFamily(): string {
  return 'Geist Mono'
}
/**
 * Why: ProseMirror builds an in-memory tree for the entire document, so large
 * markdown files cause noticeable typing lag in the rich editor. Files above
 * this threshold fall back to source mode (Monaco) which handles large files
 * efficiently via virtualized line rendering.
 */
export const RICH_MARKDOWN_MAX_SIZE_BYTES = 300 * 1024

export const DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS = 1000
export const MIN_EDITOR_AUTO_SAVE_DELAY_MS = 250
export const MAX_EDITOR_AUTO_SAVE_DELAY_MS = 10_000

// Why: initial threshold of agents spawned (since last update) before we show
// the star-on-GitHub notification. Doubles each time the user dismisses
// without starring — e.g. 35 → 70 → 140 → 280. Past dismissals are encoded
// in starNagNextThreshold, so this constant is only the first-time seed.
export const STAR_NAG_INITIAL_THRESHOLD = 35

export const DEFAULT_WORKTREE_CARD_PROPERTIES: WorktreeCardProperty[] = [
  'status',
  'unread',
  'ci',
  'issue',
  'pr',
  'comment',
  // Why: agent activity is the primary reason users opt into the feature, so
  // show it inline on each card by default. Unchecking this from the
  // Workspaces view options hides the inline list entirely — there is no
  // alternative agent-activity surface in the sidebar.
  'inline-agents'
]

// Why: long markdown defaults for the right-sidebar Review / Create PR
// dropdowns. Kept verbatim from the product brief so the user can replace
// them entirely by editing the seeded entry in Settings.
const DEFAULT_REVIEW_PROMPT = `Review guidelines:
You are acting as a reviewer for the changes on the current branch. Focus on
correctness, clarity, and risk before style.

Process:
- Diff the current branch against its base ref. Read both sides of every hunk;
  do not approve a change you have not actually looked at.
- For each change, ask: what is the intent, what could break, and is the test
  coverage sufficient? Surface assumptions the change relies on.
- Treat error handling, concurrency, and SSH/remote execution paths as
  high-risk regions. Flag silent swallowed errors and stringly-typed wire
  formats explicitly.
- Verify cross-platform behavior. Code that hardcodes \`/\`, \`metaKey\`, or
  POSIX-only shells is broken on Windows.
- Quote file paths and line ranges in your feedback so the author can jump to
  them. Group related findings together rather than listing them randomly.

Output:
- Lead with a short summary (one or two sentences) of what the change does
  and your overall confidence.
- Then bulleted findings, ordered most to least important. Mark each finding
  as Blocking / Question / Nit so the author knows what gates merge.
- Close with explicit "Looks good to merge" or "Needs changes before merge"
  with a one-line justification.

File: src/client/frontends/desktop-app/core/UserData.ts`

const DEFAULT_CREATE_PR_PROMPT = `The user likes the current state of the
branch and wants you to open a pull request that accurately represents it.

Process:
- Inspect the full diff between the current branch and its base ref. Do not
  rely on the latest commit message alone — earlier commits in the branch
  often carry user-facing context that belongs in the PR body.
- Group changes by theme. A single PR may touch multiple concerns; the body
  should reflect that grouping rather than dumping a flat file list.
- If anything in the diff looks unintentional (debug logs, commented-out
  code, stray TODOs) pause and ask before opening the PR.

PR title:
- Use the project's prevailing tense and style (look at recent merged PRs).
- Stay under 70 characters; put detail in the body, not the title.

PR body:
- Lead with a Summary section: 1-3 bullets describing what changed and why.
- Add a Test plan section: bulleted checklist of how the change was or should
  be verified. Include manual steps when automated coverage is partial.
- Note anything reviewers should look at first (load-bearing assumptions,
  risk areas, follow-up work intentionally deferred).

User preferences and Linear MCP:
- If the user has Linear preferences configured, link the PR to the matching
  Linear issue and use the issue title/key in the PR body.
- Honor the user's commit-style conventions when generating the title.`

export const DEFAULT_STATUS_BAR_ITEMS: StatusBarItem[] = [
  'claude',
  'codex',
  'gemini',
  'opencode-go',
  'ssh',
  'resource-usage'
]

/** Synthetic worktree id used by the memory collector to bucket PTYs that
 *  are not associated with any worktree. Shared across main and renderer so
 *  the collector and the status-bar popover agree on the sentinel. */
export const ORPHAN_WORKTREE_ID = '__orphan__'

// Why: the floating terminal is a local synthetic workspace, so persistence
// pruning must classify it without consulting the repo catalog.
export const FLOATING_TERMINAL_WORKTREE_ID = 'global-floating-terminal'

export const REPO_COLORS = [
  '#737373', // neutral
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#14b8a6', // teal
  '#8b5cf6', // purple
  '#ec4899' // pink
] as const

export function getDefaultNotificationSettings(): NotificationSettings {
  return {
    enabled: true,
    agentTaskComplete: true,
    terminalBell: false,
    suppressWhenFocused: true,
    customSoundPath: null
  }
}

export function getDefaultOnboardingState(): OnboardingState {
  return {
    closedAt: null,
    outcome: null,
    lastCompletedStep: -1,
    checklist: {
      addedRepo: false,
      choseAgent: false,
      ranFirstAgent: false,
      ranSecondAgentOnSameTask: false,
      triedCmdJ: false,
      shapedSidebar: false,
      reviewedDiff: false,
      openedPr: false,
      addedFolder: false,
      openedFile: false,
      ranAgentOnFile: false,
      dismissed: false
    } satisfies OnboardingChecklistState
  }
}

export function getDefaultSettings(homedir: string): GlobalSettings {
  return {
    workspaceDir: `${homedir}/orca/workspaces`,
    nestWorkspaces: true,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'git-username',
    branchPrefixCustom: '',
    enableGitHubAttribution: false,
    theme: 'system',
    appFontFamily: DEFAULT_APP_FONT_FAMILY,
    editorAutoSave: false,
    editorAutoSaveDelayMs: DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS,
    editorMinimapEnabled: false,
    terminalFontSize: 12,
    terminalFontFamily: defaultTerminalFontFamily(),
    terminalFontWeight: DEFAULT_TERMINAL_FONT_WEIGHT,
    terminalLineHeight: 1,
    // Why: VS Code defaults terminal GPU acceleration to "auto": prefer
    // xterm WebGL for performance, but allow renderer failure to choose DOM.
    terminalGpuAcceleration: 'auto',
    // Why 'auto': when the user has picked a known ligature font we want the
    // feature enabled by default, but we never force it if they pick a font
    // that lacks ligatures or if they've explicitly opted out. The resolver
    // is in shared/terminal-ligatures.ts.
    terminalLigatures: 'auto',
    terminalCursorStyle: 'bar',
    terminalCursorBlink: true,
    terminalThemeDark: 'Ghostty Default Style Dark',
    terminalDividerColorDark: '#3f3f46',
    terminalUseSeparateLightTheme: false,
    terminalThemeLight: 'Builtin Tango Light',
    terminalDividerColorLight: '#d4d4d8',
    terminalInactivePaneOpacity: 0.8,
    terminalActivePaneOpacity: 1,
    terminalPaneOpacityTransitionMs: 140,
    terminalDividerThicknessPx: 3,
    // Default true so Windows users get native right-click paste out of the
    // box. Other platforms ignore this field because the UI never exposes it,
    // and Ctrl+right-click still opens the context menu when paste is enabled.
    terminalRightClickToPaste: true,
    terminalWindowsShell: 'powershell.exe',
    // Why: Windows users expect "PowerShell" to mean modern PowerShell when it
    // is installed, with a safe fallback to the inbox Windows PowerShell.
    terminalWindowsPowerShellImplementation: 'auto',
    terminalMouseHideWhileTyping: false,
    // Default false: opt-in only (matches Ghostty's default). Existing users
    // on upgrade inherit this default via persistence.ts's
    // { ...defaults.settings, ...parsed.settings } merge, so enabling
    // focus-follows-mouse never happens unexpectedly.
    terminalFocusFollowsMouse: false,
    windowBackgroundBlur: false,
    terminalClipboardOnSelect: false,
    terminalAllowOsc52Clipboard: false,
    setupScriptLaunchMode: 'new-tab',
    terminalScrollbackBytes: 10_000_000,
    openLinksInApp: true,
    rightSidebarOpenByDefault: true,
    showTitlebarAppName: true,
    showTasksButton: true,
    floatingTerminalEnabled: true,
    floatingTerminalDefaultedForAllUsers: true,
    floatingTerminalCwd: '~',
    floatingTerminalTriggerLocation: 'floating-button',
    notifications: getDefaultNotificationSettings(),
    diffDefaultView: 'inline',
    promptCacheTimerEnabled: false,
    promptCacheTtlMs: 300_000,
    codexManagedAccounts: [],
    activeCodexManagedAccountId: null,
    claudeManagedAccounts: [],
    activeClaudeManagedAccountId: null,
    terminalScopeHistoryByWorktree: true,
    defaultTuiAgent: null,
    skipDeleteWorktreeConfirm: false,
    skipDeleteAutomationConfirm: false,
    defaultTaskViewPreset: 'all',
    defaultTaskSource: 'github',
    defaultRepoSelection: null,
    defaultLinearTeamSelection: null,
    opencodeSessionCookie: '',
    opencodeWorkspaceId: '',
    geminiCliOAuthEnabled: false,
    agentCmdOverrides: {},
    // Why: 'auto' runs a layout-aware probe at boot (see
    // src/renderer/src/lib/keyboard-layout/*) that picks 'true' for US and
    // US-International and 'false' for every other layout. This mirrors
    // Ghostty's detectOptionAsAlt() and ensures users on Turkish, German,
    // French, etc. can type Option+Q/L/E characters like @, €, [, ] out of
    // the box (issue #903) while US users keep Option-as-Alt readline chords.
    terminalMacOptionAsAlt: 'auto',
    terminalMacOptionAsAltMigrated: false,
    experimentalMobile: false,
    // Why: indefinite hold by default — the desktop "Restore" banner is the
    // explicit return-to-desktop-size action, no wall-clock guess.
    // See docs/mobile-fit-hold.md.
    mobileAutoRestoreFitMs: null,
    // Why: off by default — opt-in cosmetic joke feature. Leaving the default
    // false keeps the overlay unmounted for users who never enable it.
    experimentalPet: false,
    experimentalActivity: true,
    experimentalWorktreeSymlinks: false,
    // Why: ship one seeded entry for each dropdown so the buttons render with
    // something usable out of the box. Users can rename / replace / delete
    // from the General settings pane.
    reviewCommands: getDefaultReviewCommands(),
    createPrCommands: getDefaultCreatePrCommands(),
    // Why: hydrate an empty default so the renderer's optional-chained reads
    // (`settings?.githubProjects?.activeProject`) land on a stable shape
    // instead of `undefined`. Upgraded profiles inherit this via the
    // `{ ...defaults, ...parsed }` merge in persistence.ts.
    githubProjects: {
      pinned: [],
      recent: [],
      lastViewByProject: {},
      activeProject: null
    }
  }
}

// Why: seeded with placeholder UUIDs so the renderer can render the entry on
// first launch before any user has saved a custom one. Editing or deleting
// from Settings replaces the entry — no special protection. `claude` is the
// default `command` because it is the user's coding CLI of choice; users on
// other CLIs (codex, opencode, etc.) can rename in one click.
export function getDefaultReviewCommands(): SidebarPromptCommand[] {
  return [
    {
      id: 'default-review',
      label: 'Review',
      command: 'claude',
      prompt: DEFAULT_REVIEW_PROMPT
    }
  ]
}

export function getDefaultCreatePrCommands(): SidebarPromptCommand[] {
  return [
    {
      id: 'default-create-pr',
      label: 'Create PR',
      command: 'claude',
      prompt: DEFAULT_CREATE_PR_PROMPT
    }
  ]
}

export function getDefaultRepoHookSettings(): RepoHookSettings {
  return {
    mode: 'auto',
    setupRunPolicy: 'run-by-default',
    scripts: {
      setup: '',
      archive: '',
      run: ''
    }
  }
}

export function getDefaultPersistedState(homedir: string): PersistedState {
  return {
    schemaVersion: SCHEMA_VERSION,
    repos: [],
    sparsePresetsByRepo: {},
    worktreeMeta: {},
    settings: getDefaultSettings(homedir),
    ui: getDefaultUIState(),
    githubCache: { pr: {}, issue: {} },
    workspaceSession: getDefaultWorkspaceSession(),
    sshTargets: [],
    sshRemotePtyLeases: [],
    automations: [],
    automationRuns: [],
    onboarding: getDefaultOnboardingState()
  }
}

export function getDefaultUIState(): PersistedUIState {
  return {
    lastActiveRepoId: null,
    lastActiveWorktreeId: null,
    sidebarWidth: 280,
    rightSidebarWidth: 350,
    // Why: open-by-default is the new persisted baseline; the renderer's
    // hydration also treats absent → true for upgrade users who never
    // had this key on disk.
    rightSidebarOpen: true,
    groupBy: 'repo',
    sortBy: 'recent',
    showActiveOnly: false,
    hideDefaultBranchWorkspace: false,
    filterRepoIds: [],
    collapsedGroups: [],
    uiZoomLevel: 0,
    editorFontZoomLevel: 0,
    worktreeCardProperties: [...DEFAULT_WORKTREE_CARD_PROPERTIES],
    statusBarItems: [...DEFAULT_STATUS_BAR_ITEMS],
    statusBarVisible: true,
    dismissedUpdateVersion: null,
    lastUpdateCheckAt: null,
    trustedOrcaHooks: {},
    acknowledgedAgentsByPaneKey: {},
    pathOpenerChoice: 'finder'
  }
}

export function getDefaultWorkspaceSession(): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    openFilesByWorktree: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    activeBrowserTabIdByWorktree: {},
    activeFileIdByWorktree: {},
    activeTabTypeByWorktree: {},
    browserUrlHistory: []
  }
}
