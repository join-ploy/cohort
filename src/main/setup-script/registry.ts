// Why: main-process source of truth for setup-script lifecycle, keyed by
// worktreeId. Mirrors AgentStatusRegistry's shape so the chain executor's
// WaitForSetupRunner can poll setup-script state without an IPC roundtrip.
// The renderer continues to drive UI via `setup:started`/`setup:exited`
// broadcasts; this registry is an additive main-process concern that does
// not change those broadcasts.

export type SetupScriptState = 'pending' | 'running' | 'exited-success' | 'exited-failure'

export type SetupScriptEntry = {
  state: SetupScriptState
  exitCode: number | null
  startedAt: number | null
  finishedAt: number | null
}

export class SetupScriptRegistry {
  private readonly entries = new Map<string, SetupScriptEntry>()

  set(worktreeId: string, entry: SetupScriptEntry): void {
    this.entries.set(worktreeId, entry)
  }

  get(worktreeId: string): SetupScriptEntry | undefined {
    return this.entries.get(worktreeId)
  }

  clear(worktreeId: string): void {
    this.entries.delete(worktreeId)
  }
}
