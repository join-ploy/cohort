export type OpenPromptPaneReply = { ok: true; paneKey: string } | { ok: false; error: string }

const MAX_DEDUPE_ENTRIES = 500

// Cache of in-flight/resolved open requests keyed by the runner's stable
// `${runId}:${stepId}` dedupeKey, plus a reverse paneKey→dedupeKey index so a
// close can evict the matching entry.
const byDedupeKey = new Map<string, Promise<OpenPromptPaneReply>>()
const dedupeKeyByPaneKey = new Map<string, string>()

/**
 * Launch a prompt pane at most once per dedupeKey. Parallel automation ticks
 * can retry or duplicate-deliver the same run-step open request while an agent
 * immediately flips to waiting; caching by the stable `${runId}:${stepId}` key
 * keeps the renderer to a single launched pane.
 *
 * The cache must be evicted when the pane is closed (see
 * {@link evictOpenPromptPaneDedupeForPane}) — otherwise a "Retry all" re-run of
 * the same run-step would be handed the prior attempt's (now torn-down)
 * paneKey and the chain would reuse a dead agent's stale output instead of
 * relaunching.
 */
export function rememberOpenPromptPane(
  key: string,
  launch: () => Promise<OpenPromptPaneReply>
): Promise<OpenPromptPaneReply> {
  const existing = byDedupeKey.get(key)
  if (existing) {
    return existing
  }
  const promise = launch()
  byDedupeKey.set(key, promise)
  // Record the reverse link once the launch resolves so a later close can find
  // this entry by paneKey. Failed launches aren't reusable panes, so they get
  // no reverse entry (and remain cached only until the next session — matching
  // prior behaviour).
  void promise.then((reply) => {
    if (reply.ok) {
      dedupeKeyByPaneKey.set(reply.paneKey, key)
    }
  })
  if (byDedupeKey.size > MAX_DEDUPE_ENTRIES) {
    const oldest = byDedupeKey.keys().next().value
    if (oldest) {
      byDedupeKey.delete(oldest)
    }
  }
  return promise
}

/**
 * Evict the cached open for a pane that is being closed. Called from the
 * close-pane handler on retry teardown so a subsequent re-run of the same
 * run-step launches a fresh agent instead of reusing the torn-down pane.
 */
export function evictOpenPromptPaneDedupeForPane(paneKey: string): void {
  const key = dedupeKeyByPaneKey.get(paneKey)
  if (key === undefined) {
    return
  }
  byDedupeKey.delete(key)
  dedupeKeyByPaneKey.delete(paneKey)
}

/** Test-only: reset module state between cases. */
export function __resetOpenPromptPaneDedupeForTests(): void {
  byDedupeKey.clear()
  dedupeKeyByPaneKey.clear()
}
