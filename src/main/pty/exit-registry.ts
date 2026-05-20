// Why: main-process source of truth for PTY exit observations, keyed by
// ptyId. Mirrors SetupScriptRegistry's shape so the chain executor's
// RunCommandRunner can poll PTY exit state without an IPC roundtrip.
// The renderer continues to drive UI via `pty:exit` broadcasts; this
// registry is an additive main-process concern that does not change those
// broadcasts.

export type PtyExitEntry = {
  exitCode: number
  /** Wall-clock millis recorded when the PTY's onExit fired on the local
   *  provider. */
  finishedAt: number
}

export class PtyExitRegistry {
  private readonly entries = new Map<string, PtyExitEntry>()

  set(ptyId: string, entry: PtyExitEntry): void {
    this.entries.set(ptyId, entry)
  }

  get(ptyId: string): PtyExitEntry | undefined {
    return this.entries.get(ptyId)
  }

  clear(ptyId: string): void {
    this.entries.delete(ptyId)
  }
}
