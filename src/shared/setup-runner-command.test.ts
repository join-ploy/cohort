import { describe, expect, it } from 'vitest'

import { buildSelfTerminatingScriptCommand, buildSetupRunnerCommand } from './setup-runner-command'

describe('buildSetupRunnerCommand', () => {
  it('wraps a posix path with bash', () => {
    expect(buildSetupRunnerCommand('/tmp/runner.sh', 'posix')).toBe('bash /tmp/runner.sh')
  })

  it('quotes posix paths with spaces', () => {
    expect(buildSetupRunnerCommand('/path with spaces/runner.sh', 'posix')).toBe(
      `bash '/path with spaces/runner.sh'`
    )
  })

  it('wraps a windows path with cmd.exe /c', () => {
    expect(buildSetupRunnerCommand('C:\\tmp\\runner.cmd', 'windows')).toBe(
      'cmd.exe /c "C:\\tmp\\runner.cmd"'
    )
  })

  it('routes WSL UNC paths through bash with the linux-side path', () => {
    expect(buildSetupRunnerCommand('//wsl.localhost/Ubuntu/tmp/runner.sh', 'windows')).toBe(
      'bash /tmp/runner.sh'
    )
  })
})

describe('buildSelfTerminatingScriptCommand', () => {
  it('appends "; exit $?" on posix', () => {
    expect(buildSelfTerminatingScriptCommand('/tmp/runner.sh', 'posix')).toBe(
      'bash /tmp/runner.sh; exit $?'
    )
  })

  it('appends "& exit /b %ERRORLEVEL%" on windows', () => {
    expect(buildSelfTerminatingScriptCommand('C:\\tmp\\runner.cmd', 'windows')).toBe(
      'cmd.exe /c "C:\\tmp\\runner.cmd" & exit /b %ERRORLEVEL%'
    )
  })

  it('handles WSL UNC paths on windows by routing through bash with the posix suffix', () => {
    // Why: the WSL UNC branch produces `bash <linuxpath>` which is typed into the
    // Windows host shell. In WSL bash itself the `; exit $?` propagates the
    // runner's exit code; in cmd/PowerShell the suffix is treated as additional
    // tokens to bash and is effectively inert. Documented limitation — the
    // self-terminating contract is best-effort on the WSL UNC path.
    expect(
      buildSelfTerminatingScriptCommand('//wsl.localhost/Ubuntu/tmp/runner.sh', 'windows')
    ).toBe('bash /tmp/runner.sh; exit $?')
  })

  it('preserves quoting from buildSetupRunnerCommand', () => {
    expect(buildSelfTerminatingScriptCommand('/path with spaces/runner.sh', 'posix')).toBe(
      `bash '/path with spaces/runner.sh'; exit $?`
    )
  })
})
