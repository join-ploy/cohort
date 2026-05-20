import type { AgentStatusState } from '../../shared/agent-status-types'

export type AgentStatusEntry = {
  state: AgentStatusState
  updatedAt: number
}

// Why: mirrors the renderer slice's 30-minute TTL (AGENT_STATUS_STALE_AFTER_MS).
// Entries past this age are treated as stale by isFresh() so chain runners
// can refuse to act on a paneKey that hasn't reported in a long time.
const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000

/**
 * Main-process mirror of the renderer's agent-status map, keyed by `paneKey`
 * (`${tabId}:${paneId}`). Captures the same hook payloads that get forwarded
 * to the renderer so chain-engine runners can read agent state without an
 * IPC roundtrip.
 */
export class AgentStatusRegistry {
  private readonly entries = new Map<string, AgentStatusEntry>()
  private readonly staleAfterMs: number

  constructor(opts: { staleAfterMs?: number } = {}) {
    this.staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  }

  set(paneKey: string, entry: AgentStatusEntry): void {
    // Why: out-of-order hook events (e.g. an SSH replay landing after a fresh
    // local push) must not clobber a newer entry. <= preserves identical-
    // timestamp same-state writes — equal updatedAt carries identical data.
    const existing = this.entries.get(paneKey)
    if (!existing || existing.updatedAt <= entry.updatedAt) {
      this.entries.set(paneKey, entry)
    }
  }

  get(paneKey: string): AgentStatusEntry | undefined {
    return this.entries.get(paneKey)
  }

  isFresh(paneKey: string, now: number): boolean {
    const entry = this.entries.get(paneKey)
    if (!entry) {
      return false
    }
    return now - entry.updatedAt < this.staleAfterMs
  }
}
