import { useEffect } from 'react'
import { useAppStore } from '@/store'

/**
 * Handle main-process chain-executor requests to send a prompt into a pane
 * that was previously opened by {@link useAutomationOpenPromptPaneEvents}.
 *
 * The main-process helper `sendPromptToPane` sends a request keyed by
 * requestId on `automations:sendPromptToPane`. This hook resolves it by
 * parsing the paneKey as `<tabId>:<paneId>`, looking up the first live ptyId
 * for that tab in the store (`ptyIdsByTabId[tabId][0]` — the same source of
 * truth the sidebar liveness gate and WorktreeJumpPalette use), and writing
 * `prompt + '\n'` so the agent receives the submission.
 */
export function useAutomationSendPromptToPaneEvents(): void {
  useEffect(() => {
    const unsubscribe = window.api.automations.onSendPromptToPane(
      ({ requestId, paneKey, prompt }) => {
        try {
          // Why: paneKey shape is `<tabId>:<paneId>` — the opposite direction
          // of `useAutomationOpenPromptPaneEvents`, which builds the key from
          // tabId + FIRST_PANE_ID. The tabId may itself contain no colons, so
          // splitting on the FIRST colon is sufficient (and matches
          // `parsePaneKey` in mergeSnapshotAndSessions).
          const sepIdx = paneKey.indexOf(':')
          if (sepIdx <= 0) {
            window.api.automations.replySendPromptToPane(requestId, {
              ok: false,
              error: `Malformed paneKey: ${paneKey}`
            })
            return
          }
          const tabId = paneKey.slice(0, sepIdx)
          // Why: ptyIdsByTabId is the live-pty source of truth — without it,
          // we can't distinguish a tab that's still alive from one that was
          // closed since the chain step opened it.
          const ptyIds = useAppStore.getState().ptyIdsByTabId[tabId] ?? []
          const ptyId = ptyIds[0]
          if (!ptyId) {
            // Why: surface as a structured failure so the chain executor
            // fails-fast with a meaningful step error instead of waiting out
            // the 30s timeout (e.g. user closed the tab between steps).
            window.api.automations.replySendPromptToPane(requestId, {
              ok: false,
              error: `No live PTY for paneKey ${paneKey}.`
            })
            return
          }
          // Why: trailing newline submits the prompt — without it the agent's
          // input buffer just accumulates characters.
          window.api.pty.write(ptyId, `${prompt}\n`)
          window.api.automations.replySendPromptToPane(requestId, { ok: true })
        } catch (err) {
          // Why: surface the renderer-side reason verbatim so the chain
          // executor can fail-fast with a meaningful step error. Empty catch
          // here would silently degrade into a 30s timeout in main.
          const message = err instanceof Error ? err.message : String(err)
          window.api.automations.replySendPromptToPane(requestId, { ok: false, error: message })
        }
      }
    )
    return unsubscribe
  }, [])
}
