import { useEffect } from 'react'
import { useAppStore } from '../store'
import { evictOpenPromptPaneDedupeForPane } from '@/lib/open-prompt-pane-dedupe'

/**
 * Handle main-process chain-executor requests to close a prompt pane it
 * previously opened. Fired on retry so the old agent tab is torn down
 * before the executor opens a fresh one. The paneKey shape is
 * `${tabId}:${paneRuntimeId}` — we close the whole tab so the PTY exits
 * cleanly. Unknown tab ids are a no-op (already closed, never existed).
 */
export function useAutomationClosePromptPaneEvents(): void {
  useEffect(() => {
    const unsubscribe = window.api.automations.onClosePromptPane(({ paneKey }) => {
      // Why: drop the open-pane dedupe entry for this pane first, so a retry of
      // the same run-step (same ${runId}:${stepId} dedupeKey) launches a fresh
      // agent instead of being handed this now-closed pane's stale paneKey.
      evictOpenPromptPaneDedupeForPane(paneKey)
      const tabId = paneKey.split(':', 1)[0]
      if (!tabId) {
        return
      }
      useAppStore.getState().closeTab(tabId)
    })
    return unsubscribe
  }, [])
}
