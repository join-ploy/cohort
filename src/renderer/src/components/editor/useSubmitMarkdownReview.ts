import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { compileMarkdownReview } from './compile-markdown-review'
import { resolveReviewTargets, type ReviewTarget } from './markdown-review-target'

// Why: bracketed-paste markers keep the multi-line review intact in the agent's
// input, and the submit `\r` is sent as a separate write after a short delay so
// the agent's paste handler doesn't swallow the Enter (mirrors the automations
// send-to-pane path). The target agent is already running, so we write straight
// to its live PTY rather than waiting for the launch-time bracketed-paste
// handshake — an idle agent emitted that handshake at startup and never repeats
// it, so waiting for it would always time out.
const BRACKETED_PASTE_BEGIN = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'
const ENTER_DELAY_MS = 80

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
      const ptyId = state.ptyIdsByTabId[tabId]?.[0]
      if (!ptyId) {
        toast.message('That agent is no longer running.')
        return
      }
      const draft = state.markdownReviewDraftsByFilePath[filePath]
      if (!draft) {
        return
      }
      const content = compileMarkdownReview(relativePath, draft)
      if (!content) {
        toast.message('Nothing to submit — add a comment or an overall note first.')
        return
      }
      window.api.pty.write(ptyId, `${BRACKETED_PASTE_BEGIN}${content}${BRACKETED_PASTE_END}`)
      await new Promise((resolve) => setTimeout(resolve, ENTER_DELAY_MS))
      window.api.pty.write(ptyId, '\r')
      state.clearReview(filePath)
      toast.success('Review sent to the agent.')
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
