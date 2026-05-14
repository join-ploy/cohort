export type SetupRunnerCommandPlatform = 'windows' | 'posix'

export function buildSetupRunnerCommand(
  runnerScriptPath: string,
  platform: SetupRunnerCommandPlatform
): string {
  if (platform === 'windows') {
    if (isWslUncPath(runnerScriptPath)) {
      const linuxPath = wslUncToLinuxPath(runnerScriptPath)
      return `bash ${quotePosixArg(linuxPath)}`
    }
    return `cmd.exe /c ${quoteWindowsArg(runnerScriptPath)}`
  }

  return `bash ${quotePosixArg(runnerScriptPath)}`
}

/**
 * Build a runner command that terminates the parent shell (PTY) when the runner
 * exits, preserving the runner's exit code. Use this from the script-runner
 * (run/setup) IPC handlers where the user expects the PTY to close when their
 * script finishes — not from issue-command flows that should keep the shell
 * interactive afterward.
 */
export function buildSelfTerminatingScriptCommand(
  runnerScriptPath: string,
  platform: SetupRunnerCommandPlatform
): string {
  const base = buildSetupRunnerCommand(runnerScriptPath, platform)
  // Why: cmd.exe's sequential operator is `&` (unconditional, like `;` in posix);
  // `exit /b %ERRORLEVEL%` propagates the runner's exit code to the parent cmd.
  // The WSL UNC branch returns `bash …` and falls through to the posix suffix —
  // which works inside WSL bash but is inert when typed into a cmd/PowerShell
  // host. Documented as a best-effort limitation for that niche path.
  if (platform === 'windows' && !isWslUncPath(runnerScriptPath)) {
    return `${base} & exit /b %ERRORLEVEL%`
  }
  return `${base}; exit $?`
}

function isWslUncPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return /^\/\/(wsl\.localhost|wsl\$)\//.test(normalized)
}

function wslUncToLinuxPath(windowsPath: string): string {
  const normalized = windowsPath.replace(/\\/g, '/')
  const match = normalized.match(/^\/\/(wsl\.localhost|wsl\$)\/[^/]+(\/.*)?$/)
  return match?.[2] || '/'
}

function quotePosixArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value
  }

  return `'${value.replace(/'/g, `'\\''`)}'`
}

function quoteWindowsArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}
