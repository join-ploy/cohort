import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { exec, execFile } from 'child_process'
import { getDefaultRepoHookSettings } from '../shared/constants'
import { gitExecFileSync } from './git/runner'
import { isWslPath, parseWslPath, toWindowsWslPath, toLinuxPath } from './wsl'
import type {
  OrcaHooks,
  Repo,
  SetupDecision,
  SetupRunPolicy,
  WorktreeSetupLaunch
} from '../shared/types'

const HOOK_TIMEOUT = 120_000 // 2 minutes

function getHookShell(): string | undefined {
  if (process.platform === 'win32') {
    return process.env.ComSpec || 'cmd.exe'
  }

  return '/bin/bash'
}

/**
 * Parse a simple orca.yaml file. Handles only the supported `scripts:`,
 * `databaseUrl:`, `issueCommand:`, `reviewPreferences:`, and
 * `createPrPreferences:` keys. `scripts:`, `issueCommand:`,
 * `reviewPreferences:`, and `createPrPreferences:` accept block scalar `|`
 * multiline values; `databaseUrl:` is a single-line scalar (the rendered
 * template lives in the context bar's opener dropdown).
 */
export function parseOrcaYaml(content: string): OrcaHooks | null {
  const hooks: OrcaHooks = { scripts: {} }
  const lines = content.split(/\r?\n/)

  // Why: `reviewPreferences` and `createPrPreferences` reuse the same
  // top-level block-scalar parser as `issueCommand`. They share one buffer
  // (`bufferedValue`) because only one such section can be open at a time —
  // a new top-level key flushes the previous buffer into the right hooks
  // field via the `flushPending` helper below.
  let currentSection:
    | 'scripts'
    | 'issueCommand'
    | 'reviewPreferences'
    | 'createPrPreferences'
    | null = null
  let currentKey: 'setup' | 'archive' | 'run' | null = null
  let bufferedValue = ''

  const flushPending = (): void => {
    if (currentSection === 'scripts' && currentKey) {
      hooks.scripts[currentKey] = bufferedValue.trimEnd()
    } else if (currentSection === 'issueCommand') {
      hooks.issueCommand = bufferedValue.trimEnd() || undefined
    } else if (currentSection === 'reviewPreferences') {
      hooks.reviewPreferences = bufferedValue.trimEnd() || undefined
    } else if (currentSection === 'createPrPreferences') {
      hooks.createPrPreferences = bufferedValue.trimEnd() || undefined
    }
  }

  // Why: an inline scalar written as `run: ''` or `run: ""` should behave the same as
  // omitting the key — without this, the literal quote characters survive and the empty
  // guard below would treat the script as set.
  const stripEmptyQuotedScalar = (value: string): string =>
    value === "''" || value === '""' ? '' : value

  for (const line of lines) {
    const topLevelKeyMatch = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(\|)?\s*(.*)$/)
    if (topLevelKeyMatch) {
      flushPending()

      const [, key, blockScalar, rest] = topLevelKeyMatch
      currentKey = null
      bufferedValue = ''

      if (key === 'scripts') {
        currentSection = 'scripts'
        continue
      }

      if (key === 'issueCommand') {
        currentSection = 'issueCommand'
        if (blockScalar) {
          continue
        }
        hooks.issueCommand = stripEmptyQuotedScalar(rest.trim()) || undefined
        currentSection = null
        continue
      }

      if (key === 'reviewPreferences') {
        currentSection = 'reviewPreferences'
        if (blockScalar) {
          continue
        }
        hooks.reviewPreferences = stripEmptyQuotedScalar(rest.trim()) || undefined
        currentSection = null
        continue
      }

      if (key === 'createPrPreferences') {
        currentSection = 'createPrPreferences'
        if (blockScalar) {
          continue
        }
        hooks.createPrPreferences = stripEmptyQuotedScalar(rest.trim()) || undefined
        currentSection = null
        continue
      }

      if (key === 'databaseUrl') {
        // Why: single-line scalar — TablePlus URLs are long but never multi-line.
        // Strip wrapping quotes that users might paste in (TablePlus copy-link
        // doesn't add them, but `'…'` / `"…"` are valid YAML scalar forms).
        const raw = stripEmptyQuotedScalar(rest.trim())
        const unquoted =
          (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
            ? raw.slice(1, -1)
            : raw
        if (unquoted) {
          hooks.databaseUrl = unquoted
        }
        currentSection = null
        continue
      }

      currentSection = null
      continue
    }

    if (currentSection === 'scripts') {
      // Indented key like "  setup: |" or "  archive: |" or "  setup: echo hello"
      const keyMatch = line.match(/^  (setup|archive|run):\s*(\|)?\s*(.*)$/)
      if (keyMatch) {
        // Save previous key
        if (currentKey) {
          hooks.scripts[currentKey] = bufferedValue.trimEnd()
        }
        currentKey = keyMatch[1] as 'setup' | 'archive' | 'run'
        const inlineValue = stripEmptyQuotedScalar(keyMatch[3] ?? '')
        bufferedValue = inlineValue ? `${inlineValue}\n` : ''
        continue
      }

      // Content line (indented by 4+ spaces under a key)
      if (currentKey && line.startsWith('    ')) {
        bufferedValue += `${line.slice(4)}\n`
      }
      continue
    }

    // Why: `issueCommand`, `reviewPreferences`, and `createPrPreferences`
    // are top-level scalar sections. Their block-scalar bodies are indented
    // by two spaces (one level under the top-level key) — keep them out of
    // the `scripts:` parser's four-space indentation rule.
    if (
      (currentSection === 'issueCommand' ||
        currentSection === 'reviewPreferences' ||
        currentSection === 'createPrPreferences') &&
      line.startsWith('  ')
    ) {
      bufferedValue += `${line.slice(2)}\n`
    }
  }

  flushPending()

  if (
    !hooks.scripts.setup &&
    !hooks.scripts.archive &&
    !hooks.scripts.run &&
    !hooks.issueCommand &&
    !hooks.databaseUrl &&
    !hooks.reviewPreferences &&
    !hooks.createPrPreferences
  ) {
    return null
  }
  return hooks
}

/**
 * Parse a conductor.json file. Reads only the scripts.{setup,run,archive}
 * block; all other top-level keys are silently ignored. We're cherry-picking
 * the script bag from Conductor's schema, not consuming it whole.
 */
export function parseConductorJson(content: string): OrcaHooks | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const scripts = (parsed as { scripts?: unknown }).scripts
  if (!scripts || typeof scripts !== 'object') {
    return null
  }
  const s = scripts as Record<string, unknown>
  const out: OrcaHooks = { scripts: {} }
  if (typeof s.setup === 'string' && s.setup.trim()) {
    out.scripts.setup = s.setup
  }
  if (typeof s.run === 'string' && s.run.trim()) {
    out.scripts.run = s.run
  }
  if (typeof s.archive === 'string' && s.archive.trim()) {
    out.scripts.archive = s.archive
  }
  // Why: conductor.json users who keep the same db-client connection scheme
  // can colocate it with their existing scripts block. Mirrors the orca.yaml
  // top-level `databaseUrl:` key so either config file is a valid source.
  const databaseUrl = (parsed as { databaseUrl?: unknown }).databaseUrl
  if (typeof databaseUrl === 'string' && databaseUrl.trim()) {
    out.databaseUrl = databaseUrl
  }
  // Why: the Review / Create PR prompt preferences are equally repo-level
  // text and benefit from living in the same shared config surface, so we
  // accept them from either orca.yaml or conductor.json.
  const reviewPreferences = (parsed as { reviewPreferences?: unknown }).reviewPreferences
  if (typeof reviewPreferences === 'string' && reviewPreferences.trim()) {
    out.reviewPreferences = reviewPreferences
  }
  const createPrPreferences = (parsed as { createPrPreferences?: unknown }).createPrPreferences
  if (typeof createPrPreferences === 'string' && createPrPreferences.trim()) {
    out.createPrPreferences = createPrPreferences
  }
  if (
    !out.scripts.setup &&
    !out.scripts.run &&
    !out.scripts.archive &&
    !out.databaseUrl &&
    !out.reviewPreferences &&
    !out.createPrPreferences
  ) {
    return null
  }
  return out
}

/**
 * Load hooks from a repo root. Prefers orca.yaml; falls back to conductor.json
 * when only the latter exists. orca.yaml wins when both are present so users
 * who explicitly opt in to Orca's format aren't silently overridden.
 */
export function loadHooks(repoPath: string): OrcaHooks | null {
  const yamlPath = join(repoPath, 'orca.yaml')
  if (existsSync(yamlPath)) {
    try {
      return parseOrcaYaml(readFileSync(yamlPath, 'utf-8'))
    } catch {
      return null
    }
  }

  const jsonPath = join(repoPath, 'conductor.json')
  if (existsSync(jsonPath)) {
    try {
      return parseConductorJson(readFileSync(jsonPath, 'utf-8'))
    } catch {
      return null
    }
  }

  return null
}

/**
 * Check whether any hook config file (orca.yaml or conductor.json) exists.
 */
export function hasHookConfig(repoPath: string): boolean {
  return existsSync(join(repoPath, 'orca.yaml')) || existsSync(join(repoPath, 'conductor.json'))
}

/**
 * Return which hook config file is active for the repo. orca.yaml wins when
 * both exist; returns null when neither does. Used by the empty-state UI to
 * decide which filename to surface.
 */
export function getActiveHookConfigKind(repoPath: string): 'orca-yaml' | 'conductor-json' | null {
  if (existsSync(join(repoPath, 'orca.yaml'))) {
    return 'orca-yaml'
  }
  if (existsSync(join(repoPath, 'conductor.json'))) {
    return 'conductor-json'
  }
  return null
}

// Why: when a newer Orca release adds a top-level key to `orca.yaml` (like
// `issueCommand` was added here), older versions that don't recognise it will
// return `null` from `parseOrcaYaml` and show a confusing "could not be parsed"
// error.  Detecting well-formed but unrecognised keys lets the UI suggest an
// update instead of implying the file is broken.
const RECOGNIZED_ORCA_YAML_KEYS = new Set([
  'scripts',
  'issueCommand',
  'databaseUrl',
  'reviewPreferences',
  'createPrPreferences'
])

/**
 * Return true when `orca.yaml` contains at least one top-level key that this
 * version of Orca does not handle. Conductor schemas legitimately include
 * unrelated keys (e.g. runScriptMode), so this check is yaml-only — flagging
 * a conductor.json would produce a misleading "outdated Orca" warning.
 */
export function hasUnrecognizedOrcaYamlKeys(repoPath: string): boolean {
  if (getActiveHookConfigKind(repoPath) !== 'orca-yaml') {
    return false
  }
  try {
    const content = readFileSync(join(repoPath, 'orca.yaml'), 'utf-8')
    return content.split(/\r?\n/).some((line) => {
      // Why: bare `key:` at end-of-line (no trailing space) is valid YAML for
      // a mapping with a block value on the next line. Match both forms so
      // newer keys like `futureFeature:\n  nested` are still detected.
      const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(\s|$)/)
      return m != null && !RECOGNIZED_ORCA_YAML_KEYS.has(m[1])
    })
  } catch {
    return false
  }
}

// ─── Issue command files ────────────────────────────────────────────────
// Why: `orca.yaml` is the tracked, project-wide defaults surface, while
// `.orca/issue-command` remains the per-user override. Keeping the local file in
// `.orca/` lets users customize agent automation without editing committed config.

const ORCA_DIR = '.orca'
const ISSUE_COMMAND_FILENAME = 'issue-command'

export function getIssueCommandFilePath(repoPath: string): string {
  return join(repoPath, ORCA_DIR, ISSUE_COMMAND_FILENAME)
}

export function getSharedIssueCommand(repoPath: string): string | null {
  return loadHooks(repoPath)?.issueCommand?.trim() || null
}

export type ResolvedIssueCommand = {
  localContent: string | null
  sharedContent: string | null
  effectiveContent: string | null
  localFilePath: string
  source: 'local' | 'shared' | 'none'
}

/**
 * Resolve the GitHub issue command using local override first, then tracked repo config.
 */
export function readIssueCommand(repoPath: string): ResolvedIssueCommand {
  const filePath = getIssueCommandFilePath(repoPath)
  let localContent: string | null = null

  if (existsSync(filePath)) {
    try {
      const content = readFileSync(filePath, 'utf-8').trim()
      localContent = content || null
    } catch {
      localContent = null
    }
  }

  const sharedContent = getSharedIssueCommand(repoPath)
  const effectiveContent = localContent ?? sharedContent

  return {
    localContent,
    sharedContent,
    effectiveContent,
    localFilePath: filePath,
    source: localContent ? 'local' : sharedContent ? 'shared' : 'none'
  }
}

/**
 * Write the per-user issue command override to `{repoRoot}/.orca/issue-command`.
 * Creates `.orca/` and ensures it is in `.gitignore` on first write.
 * If content is empty, deletes only the override so the shared `orca.yaml`
 * command becomes effective again.
 */
export function writeIssueCommand(repoPath: string, content: string): void {
  const filePath = getIssueCommandFilePath(repoPath)
  const trimmed = content.trim()

  try {
    if (!trimmed) {
      rmSync(filePath, { force: true })
      return
    }

    const orcaDir = join(repoPath, ORCA_DIR)
    if (!existsSync(orcaDir)) {
      mkdirSync(orcaDir, { recursive: true })
    }
    ensureOrcaDirIgnored(repoPath)
    writeFileSync(filePath, `${trimmed}\n`, 'utf-8')
  } catch (err) {
    console.error('[hooks] Failed to write issue command:', err)
    // Why: re-throw so the error propagates through the IPC handler to the
    // renderer, which already has .catch() ready to surface write failures.
    throw err
  }
}

/**
 * Ensure `.orca` is listed in the repo's `.gitignore` so the per-user
 * directory is never accidentally committed.
 */
function ensureOrcaDirIgnored(repoPath: string): void {
  const gitignorePath = join(repoPath, '.gitignore')
  try {
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, 'utf-8')
      if (/^\.orca\/?$/m.test(content)) {
        return
      }
      const separator = content.endsWith('\n') ? '' : '\n'
      writeFileSync(gitignorePath, `${content}${separator}.orca\n`, 'utf-8')
    } else {
      writeFileSync(gitignorePath, '.orca\n', 'utf-8')
    }
  } catch {
    console.warn('[hooks] Could not update .gitignore to exclude .orca')
  }
}

export function getEffectiveHooks(repo: Repo, worktreePath?: string): OrcaHooks | null {
  const yamlHooks = loadHooks(worktreePath ?? repo.path)
  const legacySetup = repo.hookSettings?.scripts.setup?.trim()
  const legacyArchive = repo.hookSettings?.scripts.archive?.trim()
  const legacyRun = repo.hookSettings?.scripts.run?.trim()
  const setup = yamlHooks?.scripts.setup?.trim() || legacySetup
  const archive = yamlHooks?.scripts.archive?.trim() || legacyArchive
  const run = yamlHooks?.scripts.run?.trim() || legacyRun
  // Why: persisted per-repo override wins over orca.yaml so individual users
  // can point at their own local DB without editing the committed file. Empty
  // override falls through to the yaml value (parity with setup/archive).
  const persistedDbUrl = repo.hookSettings?.databaseUrl?.trim()
  const yamlDbUrl = yamlHooks?.databaseUrl?.trim()
  const databaseUrl = persistedDbUrl || yamlDbUrl
  // Why: Review / Create PR preferences use the same persisted-override-wins
  // precedence as databaseUrl. Empty override falls through to the yaml
  // value so the user can clear the local override and re-inherit the
  // committed default without an empty string clobbering it.
  const persistedReviewPrefs = repo.hookSettings?.reviewPreferences?.trim()
  const yamlReviewPrefs = yamlHooks?.reviewPreferences?.trim()
  const reviewPreferences = persistedReviewPrefs || yamlReviewPrefs
  const persistedCreatePrPrefs = repo.hookSettings?.createPrPreferences?.trim()
  const yamlCreatePrPrefs = yamlHooks?.createPrPreferences?.trim()
  const createPrPreferences = persistedCreatePrPrefs || yamlCreatePrPrefs

  if (!setup && !archive && !run && !databaseUrl && !reviewPreferences && !createPrPreferences) {
    return null
  }

  // Why: `orca.yaml` is the preferred source going forward, but existing users may
  // still have setup/archive commands persisted only in repo settings. Resolve each
  // hook independently so a repo that has only migrated one command into `orca.yaml`
  // does not silently lose the other legacy hook until the migration is complete.
  return {
    scripts: {
      ...(setup ? { setup } : {}),
      ...(archive ? { archive } : {}),
      ...(run ? { run } : {})
    },
    ...(databaseUrl ? { databaseUrl } : {}),
    ...(reviewPreferences ? { reviewPreferences } : {}),
    ...(createPrPreferences ? { createPrPreferences } : {})
  }
}

export function getEffectiveSetupRunPolicy(repo: Repo): SetupRunPolicy {
  return repo.hookSettings?.setupRunPolicy ?? getDefaultRepoHookSettings().setupRunPolicy!
}

export function shouldRunSetupForCreate(repo: Repo, decision: SetupDecision = 'inherit'): boolean {
  if (decision === 'run') {
    return true
  }
  if (decision === 'skip') {
    return false
  }

  const policy = getEffectiveSetupRunPolicy(repo)
  if (policy === 'ask') {
    throw new Error('Setup decision required for this repository')
  }

  return policy === 'run-by-default'
}

export function getSetupCommandSource(
  repo: Repo,
  worktreePath?: string
): { source: 'yaml'; command: string } | null {
  const yamlSetup = loadHooks(worktreePath ?? repo.path)?.scripts.setup?.trim()

  if (yamlSetup) {
    return { source: 'yaml', command: yamlSetup }
  }

  return null
}

function getSetupEnvVars(
  repo: Repo,
  worktreePath: string,
  workspaceName?: string,
  groupRepos?: readonly string[]
): Record<string, string> {
  return {
    ORCA_ROOT_PATH: repo.path,
    ORCA_WORKTREE_PATH: worktreePath,
    // Why: Conductor users key shell scripts and Postgres DB names off
    // CONDUCTOR_WORKSPACE_NAME and CONDUCTOR_ROOT_PATH. Forward both so
    // existing setup/run/archive scripts work unchanged. The workspace name
    // is only available when callers pass it (IPC handlers do; legacy
    // worktrees synthesized before backfill omit it).
    CONDUCTOR_ROOT_PATH: repo.path,
    ...(workspaceName ? { CONDUCTOR_WORKSPACE_NAME: workspaceName } : {}),
    // Why: grouped workspaces expose the sibling repos as
    // CONDUCTOR_WORKSPACE_REPOS so setup/run/archive scripts can fan out
    // across the group (e.g. `for r in $CONDUCTOR_WORKSPACE_REPOS; do ...`).
    // Absent for non-grouped worktrees so existing single-repo scripts see
    // no new variable.
    ...(groupRepos && groupRepos.length > 0
      ? { CONDUCTOR_WORKSPACE_REPOS: groupRepos.join(',') }
      : {}),
    GHOSTX_ROOT_PATH: repo.path
  }
}

function getGitPath(cwd: string, relativePath: string): string {
  return gitExecFileSync(['rev-parse', '--git-path', relativePath], {
    cwd
  }).trim()
}

function buildWindowsRunnerScript(script: string): string {
  const lines = script.replace(/\r?\n/g, '\n').split('\n')
  const runnerLines = ['@echo off', 'setlocal EnableExtensions']

  for (const rawLine of lines) {
    const command = rawLine.trim()
    if (!command) {
      runnerLines.push('')
      continue
    }

    // Why: setup commands often invoke `npm`/`pnpm`, which are batch files on
    // Windows. Calling one batch file from another without `call` never returns
    // to later lines, and plain newline-separated commands also keep running
    // after failures. Wrap each line in `call` and bail on non-zero exit codes
    // so the generated runner matches the fail-fast behavior of `set -e`.
    runnerLines.push(`call ${command}`)
    runnerLines.push('if errorlevel 1 exit /b %errorlevel%')
  }

  return `${runnerLines.join('\r\n')}\r\n`
}

export function createSetupRunnerScript(
  repo: Repo,
  worktreePath: string,
  script: string,
  workspaceName?: string,
  groupRepos?: readonly string[]
): WorktreeSetupLaunch {
  return createWorktreeRunnerScript(
    repo,
    worktreePath,
    script,
    'setup-runner',
    workspaceName,
    groupRepos
  )
}

export function createIssueCommandRunnerScript(
  repo: Repo,
  worktreePath: string,
  command: string,
  workspaceName?: string,
  groupRepos?: readonly string[]
): WorktreeSetupLaunch {
  // Why: long issue-automation commands are user-visible shell input when
  // written directly to the PTY, so terminal line editors can wrap or truncate
  // them before execution. Writing the real command into a runner script keeps
  // the shell startup path short and mirrors the already-stable setup runner
  // flow instead of inventing a second launch mechanism.
  return createWorktreeRunnerScript(
    repo,
    worktreePath,
    command,
    'issue-command-runner',
    workspaceName,
    groupRepos
  )
}

export function createRunRunnerScript(
  repo: Repo,
  worktreePath: string,
  script: string,
  workspaceName?: string,
  groupRepos?: readonly string[]
): WorktreeSetupLaunch {
  // Why: scripts.run is user-authored shell input; wrapping ensures non-zero
  // exits propagate and ORCA_WORKTREE_PATH is set before exec.
  return createWorktreeRunnerScript(
    repo,
    worktreePath,
    script,
    'run-runner',
    workspaceName,
    groupRepos
  )
}

function createWorktreeRunnerScript(
  repo: Repo,
  worktreePath: string,
  script: string,
  runnerBaseName: 'setup-runner' | 'issue-command-runner' | 'run-runner',
  workspaceName?: string,
  groupRepos?: readonly string[]
): WorktreeSetupLaunch {
  const envVars = getSetupEnvVars(repo, worktreePath, workspaceName, groupRepos)
  // Why: WSL worktrees run on a Linux filesystem even though process.platform
  // is 'win32'. Use bash scripts for WSL, .cmd for native Windows.
  const wslWorktree = isWslPath(worktreePath)
  const useWindowsFormat = process.platform === 'win32' && !wslWorktree
  const normalizedScript = useWindowsFormat
    ? script.replace(/\r?\n/g, '\r\n')
    : script.replace(/\r\n/g, '\n')
  // Why: linked git worktrees use a `.git` file that points at the real gitdir,
  // so writing under `${worktreePath}/.git/...` fails. `git rev-parse --git-path`
  // resolves the actual per-worktree git storage path safely across platforms.
  const gitRelPath = useWindowsFormat ? `orca/${runnerBaseName}.cmd` : `orca/${runnerBaseName}.sh`
  let runnerScriptPath = getGitPath(worktreePath, gitRelPath)

  // Why: for WSL worktrees, getGitPath returns a Linux path (e.g. /home/user/...)
  // because git runs inside WSL. Convert it to a Windows UNC path so mkdirSync
  // and writeFileSync (which run on Windows) can access it.
  if (wslWorktree) {
    const wslInfo = parseWslPath(worktreePath)
    if (wslInfo) {
      runnerScriptPath = toWindowsWslPath(runnerScriptPath.trim(), wslInfo.distro)
    }
  }

  mkdirSync(dirname(runnerScriptPath), { recursive: true })

  if (useWindowsFormat) {
    writeFileSync(runnerScriptPath, buildWindowsRunnerScript(normalizedScript), 'utf-8')
  } else {
    writeFileSync(runnerScriptPath, `#!/usr/bin/env bash\nset -e\n${normalizedScript}\n`, 'utf-8')
    // Why: chmod via UNC paths to WSL filesystem is supported by Windows and
    // sets the execute bit correctly inside WSL.
    chmodSync(runnerScriptPath, 0o755)
  }

  // Why: when the worktree is on WSL, env vars like ORCA_ROOT_PATH and
  // ORCA_WORKTREE_PATH contain Windows UNC paths. The setup script runs
  // inside WSL bash, so translate them to Linux paths.
  if (wslWorktree) {
    for (const key of Object.keys(envVars)) {
      envVars[key] = toLinuxPath(envVars[key])
    }
  }

  return { runnerScriptPath, envVars }
}

/**
 * Run a named hook script in the given working directory.
 */
export function runHook(
  hookName: 'setup' | 'archive',
  cwd: string,
  repo: Repo,
  hooksPath?: string,
  workspaceName?: string,
  groupRepos?: readonly string[]
): Promise<{ success: boolean; output: string }> {
  const hooks = getEffectiveHooks(repo, hooksPath)
  const script = hooks?.scripts[hookName]

  if (!script) {
    return Promise.resolve({ success: true, output: '' })
  }

  const wslInfo = parseWslPath(cwd)

  if (wslInfo) {
    // Why: use execFile('wsl.exe', [...]) instead of exec() to bypass the
    // Windows shell (cmd.exe). exec() always routes through a shell, and
    // cmd.exe doesn't understand single-quote escaping — it would mangle
    // paths/scripts containing %, ^, &, |, etc.
    const escapedCwd = wslInfo.linuxPath.replace(/'/g, "'\\''")
    const escapedScript = script.replace(/'/g, "'\\''")
    const bashCmd = `cd '${escapedCwd}' && ${escapedScript}`
    // Why: translate ORCA_ROOT_PATH / ORCA_WORKTREE_PATH to Linux paths so
    // hook scripts that reference $ORCA_WORKTREE_PATH get usable paths
    // inside WSL, not Windows UNC paths.
    const envVars = getSetupEnvVars(repo, cwd, workspaceName, groupRepos)
    const wslEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(envVars)) {
      wslEnv[key] = toLinuxPath(value)
    }

    return new Promise((resolve) => {
      execFile(
        'wsl.exe',
        ['-d', wslInfo.distro, '--', 'bash', '-c', bashCmd],
        {
          timeout: HOOK_TIMEOUT,
          encoding: 'utf-8',
          env: { ...process.env, ...wslEnv }
        },
        (error, stdout, stderr) => {
          if (error) {
            console.error(`[hooks] ${hookName} hook failed in ${cwd}:`, error.message)
            resolve({
              success: false,
              output: `${stdout}\n${stderr}\n${error.message}`.trim()
            })
          } else {
            console.log(`[hooks] ${hookName} hook completed in ${cwd}`)
            resolve({
              success: true,
              output: `${stdout}\n${stderr}`.trim()
            })
          }
        }
      )
    })
  }

  return new Promise((resolve) => {
    exec(
      script,
      {
        cwd,
        timeout: HOOK_TIMEOUT,
        shell: getHookShell(),
        env: {
          ...process.env,
          ...getSetupEnvVars(repo, cwd, workspaceName, groupRepos)
        }
      },
      (error, stdout, stderr) => {
        if (error) {
          console.error(`[hooks] ${hookName} hook failed in ${cwd}:`, error.message)
          resolve({
            success: false,
            output: `${stdout}\n${stderr}\n${error.message}`.trim()
          })
        } else {
          console.log(`[hooks] ${hookName} hook completed in ${cwd}`)
          resolve({
            success: true,
            output: `${stdout}\n${stderr}`.trim()
          })
        }
      }
    )
  })
}
