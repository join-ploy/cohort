import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { compileMarkdownReview } from './compile-markdown-review'
import { resolveReviewTargets, type ReviewTarget } from './markdown-review-target'

export function useSubmitMarkdownReview(args: {
  filePath: string
  relativePath: string
  worktreeId: string
}): {
  submit: () => void
  pickerTargets: ReviewTarget[] | null
  pickTarget: (tabId: string) => void
  cancelPicker: () => void
} {
  const { filePath, relativePath, worktreeId } = args
  const [pickerTargets, setPickerTargets] = useState<ReviewTarget[] | null>(null)

  const sendToTab = useCallback(
    async (tabId: string): Promise<void> => {
      const state = useAppStore.getState()
      const draft = state.markdownReviewDraftsByFilePath[filePath]
      if (!draft) {
        return
      }
      const content = compileMarkdownReview(relativePath, draft)
      if (!content) {
        toast.message('Nothing to submit — add a comment or an overall note first.')
        return
      }
      // Why: omit `agent` — pasteDraftWhenAgentReady early-returns for agents
      // with a draftPromptFlag (e.g. Claude), which is the launch-with-prefill
      // guard, not what we want when pasting into an already-running agent.
      const ok = await pasteDraftWhenAgentReady({
        tabId,
        content,
        submit: true,
        onTimeout: () =>
          toast.message("Agent wasn't ready — your review is still here, try again in a moment.")
      })
      if (ok) {
        state.clearReview(filePath)
        toast.success('Review sent to the agent.')
      }
    },
    [filePath, relativePath]
  )

  const submit = useCallback(() => {
    const state = useAppStore.getState()
    const tabs = state.tabsByWorktree[worktreeId] ?? []
    const targets = resolveReviewTargets({ tabs, agentStatusByPaneKey: state.agentStatusByPaneKey })
    if (targets.length === 0) {
      toast.message('No running agent in this worktree to send the review to.')
      return
    }
    if (targets.length === 1) {
      void sendToTab(targets[0].tabId)
      return
    }
    setPickerTargets(targets)
  }, [worktreeId, sendToTab])

  const pickTarget = useCallback(
    (tabId: string) => {
      setPickerTargets(null)
      void sendToTab(tabId)
    },
    [sendToTab]
  )

  const cancelPicker = useCallback(() => setPickerTargets(null), [])

  return { submit, pickerTargets, pickTarget, cancelPicker }
}
