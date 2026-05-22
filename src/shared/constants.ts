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
// them entirely by editing the seeded entry in Settings. Exported so the
// Settings UI can pre-fill the prompt textarea when the user adds a brand
// new Review or Create PR entry — saves them copy-pasting the default
// body every time they want a variant.
export const DEFAULT_REVIEW_PROMPT = `Review guidelines:
You are acting as a reviewer for a proposed code change made by another engineer, you are currently on that branch.

Getting the diff
# Get the merge base between this branch and the target
MERGE_BASE=$(git merge-base origin/main HEAD)

# Get the committed diff against the merge base
git diff $MERGE_BASE HEAD

# Get any uncommitted changes (staged and unstaged)
git diff HEAD

Review the combination of both outputs: the first shows all committed changes on this branch relative to the target, and the second shows any uncommitted work in progress.

Below are some default guidelines for determining whether the original author would appreciate the issue being flagged.
These are not the final word in determining whether an issue is a bug. In many cases, you will encounter other, more specific guidelines. These may be present elsewhere in a developer message, a user message, a file, or even elsewhere in this system message. Those guidelines should be considered to override these general instructions.
Here are the general guidelines for determining whether something is a bug and should be flagged.
1. It meaningfully impacts the accuracy, performance, security, or maintainability of the code.
2. The bug is discrete and actionable (i.e. not a general issue with the codebase or a combination of multiple issues).
3. Fixing the bug does not demand a level of rigor that is not present in the rest of the codebase (e.g. one doesn't need very detailed comments and input validation in a repository of one-off scripts in personal projects)
4. The bug was introduced in the commit (pre-existing bugs should not be flagged).
5. The author of the original PR would likely fix the issue if they were made aware of it.
6. The bug does not rely on unstated assumptions about the codebase or author's intent.
7. It is not enough to speculate that a change may disrupt another part of the codebase, to be considered a bug, one must identify the other parts of the code that are provably affected.
8. The bug is clearly not just an intentional change by the original author.
When flagging a bug, you will also provide an accompanying comment. Once again, these guidelines are not the final word on how to construct a comment — defer to any subsequent guidelines that you encounter.
1. The comment should be clear about why the issue is a bug.
2. The comment should appropriately communicate the severity of the issue. It should not claim that an issue is more severe than it actually is.
3. The comment should be brief. The body should be at most 1 paragraph. It should not introduce line breaks within the natural language flow unless it is necessary for the code fragment.
4. The comment should not include any chunks of code longer than 3 lines. Any code chunks should be wrapped in markdown inline code tags or a code block.
5. The comment should clearly and explicitly communicate the scenarios, environments, or inputs that are necessary for the bug to arise. The comment should immediately indicate that the issue's severity depends on these factors.
6. The comment's tone should be matter-of-fact and not accusatory or overly positive. It should read as a helpful AI assistant suggestion without sounding too much like a human reviewer.
7. The comment should be written such that the original author can immediately grasp the idea without close reading.
8. The comment should avoid excessive flattery and comments that are not helpful to the original author. The comment should avoid phrasing like "Great job …", "Thanks for …".
Below are some more detailed guidelines that you should apply to this specific review.
HOW MANY FINDINGS TO RETURN:
Output all findings that the original author would fix if they knew about it. If there is no finding that a person would definitely love to see and fix, prefer outputting no findings. Do not stop at the first qualifying finding. Continue until you've listed every qualifying finding.
GUIDELINES:
* Ignore trivial style unless it obscures meaning or violates documented standards.
* Use one comment per distinct issue (or a multi-line range if necessary).
* Use \`\`\`suggestion blocks ONLY for concrete replacement code (minimal lines; no commentary inside the block).
* In every \`\`\`suggestion block, preserve the exact leading whitespace of the replaced lines (spaces vs tabs, number of spaces).
* Do NOT introduce or remove outer indentation levels unless that is the actual fix.
The comments will be presented in the code review as inline comments. You should avoid providing unnecessary location details in the comment body. Always keep the line range as short as possible for interpreting the issue. Avoid ranges longer than 5–10 lines; instead, choose the most suitable subrange that pinpoints the problem.

Output format
Write out a list of issues found, along with the location of the comment. For example:
### **#1 Empty input causes crash**
If the input field is empty when page loads, the app will crash.
File: src/client/frontends/desktop-app/ui/Input.tsx
#2 Dead code
The getUserData function is now unused. It should be deleted.
File: src/client/frontends/desktop-app/core/UserData.ts`

export const DEFAULT_CREATE_PR_PROMPT = `The user likes the current state of the code on the branch you're in. The target branch is origin/main.
There is no upstream branch yet. The user requested a PR.  get the diff   Getting the diff
# Get the merge base between this branch and the target
MERGE_BASE=$(git merge-base origin/main HEAD)

# Get the committed diff against the merge base
git diff $MERGE_BASE HEAD

# Get any uncommitted changes (staged and unstaged)
git diff HEAD
Follow these steps to create a PR:
* If you have any skills related to creating PRs, invoke them now. Instructions there should take precedence over these instructions.
* Run git diff to review uncommitted changes
* Commit them. Follow any instructions the user gave you about writing commit messages.
* Push to origin.
* Use gh pr create --base main to create a PR onto the target branch. Keep the title under 80 characters. Keep the description under five sentences, unless the user instructed you otherwise. Describe not just changes made in this session but ALL changes in the workspace diff.
If any of these steps fail, ask the user for help.
IMPORTANT: The following are the user's custom preferences. These preferences take precedence over any default guidelines or instructions provided above. When there is a conflict, always follow the user's preferences.`

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
    // Why: opt-in while the grouped-workspaces sidebar UX is in flight.
    // GroupsSection already self-hides when empty; the flag exists so the
    // section doesn't render at all for users who haven't opted in.
    experimentalGroupedWorkspaces: false,
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
    workspaceGroups: [],
    settings: getDefaultSettings(homedir),
    ui: getDefaultUIState(),
    githubCache: { pr: {}, issue: {} },
    workspaceSession: getDefaultWorkspaceSession(),
    sshTargets: [],
    sshRemotePtyLeases: [],
    automations: [],
    automationRuns: [],
    automationAutoDedup: [],
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
