import { useEffect } from 'react'
import { launchAgentBackgroundSession } from '@/lib/launch-agent-background-session'
import { FIRST_PANE_ID } from '../../../shared/pane-key'
import type { TuiAgent } from '../../../shared/types'

/**
 * Handle main-process chain-executor requests to open a prompt pane.
 *
 * The main-process helper {@link openPromptPane} sends a request keyed by
 * requestId on `automations:openPromptPane`. This hook resolves it by
 * calling the same {@link launchAgentBackgroundSession} primitive that the
 * legacy automation dispatcher uses, then replies with the resulting
 * paneKey so the chain executor can track agent status.
 */
export function useAutomationOpenPromptPaneEvents(): void {
  useEffect(() => {
    const unsubscribe = window.api.automations.onOpenPromptPane(
      async ({ requestId, worktreeId, agentId, prompt }) => {
        try {
          const result = await launchAgentBackgroundSession({
            agent: agentId as TuiAgent,
            worktreeId,
            prompt,
            launchSource: 'unknown'
          })
          if (!result) {
            // Why: launchAgentBackgroundSession returns null when no startup
            // plan can be built (e.g. unknown agent, empty prompt). Surface
            // that as a structured failure so the chain executor fails-fast
            // instead of waiting out the 30s timeout.
            window.api.automations.replyOpenPromptPane(requestId, {
              ok: false,
              error: 'Could not build an agent startup plan for the requested prompt.'
            })
            return
          }
          const paneKey = `${result.tabId}:${FIRST_PANE_ID}`
          window.api.automations.replyOpenPromptPane(requestId, { ok: true, paneKey })
        } catch (err) {
          // Why: surface the renderer-side reason verbatim so the chain
          // executor can fail-fast with a meaningful step error. Empty catch
          // here would silently degrade into a 30s timeout in main.
          const message = err instanceof Error ? err.message : String(err)
          window.api.automations.replyOpenPromptPane(requestId, { ok: false, error: message })
        }
      }
    )
    return unsubscribe
  }, [])
}
