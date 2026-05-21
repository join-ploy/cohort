import { useEffect } from 'react'
import { useAppStore } from '@/store'

// Why: agent TUIs (Claude, Codex, OpenCode, …) want `\r` (carriage return,
// what the terminal sends when Enter is pressed) to submit input, not a bare
// `\n` (line feed). Bracketed paste markers also keep multi-line prompts
// intact and stop the inserted text from being interpreted
// character-by-character.
const BRACKETED_PASTE_BEGIN = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'

// Why: when the bracketed-paste end marker and the submit `\r` land in the
// same PTY write, some agents consume the `\r` as part of paste processing
// instead of as the Enter that submits the buffered text — you'd see the
// prompt sit in the input box requiring a manual Enter. Splitting the write
// and giving the agent's paste handler a brief moment to finish is the
// standard fix. 80ms is conservative enough to be reliable across Claude /
// Codex / OpenCode / Gemini / cursor-agent and short enough to feel
// instantaneous to the operator.
const ENTER_DELAY_MS = 80

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
      async ({ requestId, paneKey, prompt }) => {
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
          // Bracketed-paste envelope keeps multi-line prompts intact; write
          // the paste first, give the agent a moment to finish processing
          // the end marker, then send the submit `\r` in a separate write so
          // the Enter isn't swallowed as part of the paste.
          window.api.pty.write(
            ptyId,
            `${BRACKETED_PASTE_BEGIN}${prompt}${BRACKETED_PASTE_END}`
          )
          await new Promise((resolve) => setTimeout(resolve, ENTER_DELAY_MS))
          window.api.pty.write(ptyId, '\r')
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
