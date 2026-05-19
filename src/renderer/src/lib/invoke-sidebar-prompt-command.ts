import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import type { OrcaHooks, SidebarPromptCommand } from '../../../shared/types'

export type SidebarPromptKind = 'review' | 'createPr'

/**
 * Invoke a right-sidebar prompt command (Review / Create PR).
 *
 * Steps:
 *  1. Read the active worktree + per-repo preferences via `hooks:check`.
 *  2. Compose the resolved prompt body (cmd.prompt + repo preferences).
 *  3. Write it to `~/.orca/prompts/<label>.md` via `prompts:write`.
 *  4. Open a new central terminal tab in the active worktree and queue the
 *     shell command `<cmd.command> "$(cat <absolute-prompt-path>)"`.
 *
 * Why: the queue runs once the new tab's PTY shell is ready (consumed by
 * TerminalPane on first mount). That side-steps the race between tab
 * creation and PTY readiness and reuses the same path the agent quick-launch
 * flow uses. Returns false when the active worktree cannot be resolved or
 * the new-tab create fails so the caller can show a no-op feedback.
 */
export async function invokeSidebarPromptCommand(
  cmd: SidebarPromptCommand,
  kind: SidebarPromptKind
): Promise<boolean> {
  const store = useAppStore.getState()
  const activeWorktreeId = store.activeWorktreeId
  if (!activeWorktreeId) {
    toast.error('Open a worktree first to run this command.')
    return false
  }
  const activeWorktree = findWorktreeById(store.worktreesByRepo, activeWorktreeId)
  if (!activeWorktree) {
    toast.error('Active worktree could not be resolved.')
    return false
  }

  // Why: per-repo preferences are appended to the user's global prompt so
  // each repo can layer project conventions on top of the shared default.
  // Best-effort — if hooks:check fails (offline / IPC error), fall through
  // with just the global prompt rather than blocking the command.
  let preferences: string | undefined
  try {
    const result = await window.api.hooks.check({ repoId: activeWorktree.repoId })
    const hooks = (result.hooks as OrcaHooks | null) ?? null
    preferences = kind === 'review' ? hooks?.reviewPreferences : hooks?.createPrPreferences
  } catch (err) {
    console.error('[sidebar-prompt] hooks:check failed:', err)
  }

  const body = preferences ? `${cmd.prompt}\n\n${preferences}` : cmd.prompt

  let promptPath: string
  try {
    promptPath = await window.api.prompts.write({ label: cmd.label, body })
  } catch (err) {
    console.error('[sidebar-prompt] prompts:write failed:', err)
    const message = err instanceof Error ? err.message : 'Failed to write prompt file.'
    toast.error(message)
    return false
  }

  // Why: shell-escape the prompt path with double quotes so spaces in the
  // path are tolerated. `$(cat "...")` is the canonical bash/zsh form. The
  // outer double quotes around the `$(...)` expansion preserve the entire
  // multi-line prompt as a single argv element to the configured command.
  const launchCommand = `${cmd.command} "$(cat "${promptPath}")"`

  // Why: Create PR targets the user's currently-focused terminal when one
  // is active, so the command joins their existing shell session (e.g. a
  // Claude session they're already chatting in) instead of fragmenting
  // attention across a new tab. Review always opens a fresh tab — reviews
  // are independent sessions and shouldn't intrude on whatever the user
  // is doing. Fallback to a new tab when no terminal tab is active.
  if (kind === 'createPr') {
    const activeTab = store.getActiveTab(activeWorktreeId)
    if (activeTab?.contentType === 'terminal') {
      const ptyIds = store.ptyIdsByTabId[activeTab.id] ?? []
      const ptyId = ptyIds[0]
      if (ptyId) {
        // Why: append \n so the shell executes immediately, matching the
        // queued-startup behavior in the new-tab path.
        window.api.pty.write(ptyId, `${launchCommand}\n`)
        store.setActiveTabType('terminal')
        return true
      }
    }
    // No active terminal → fall through to new-tab creation below.
  }

  // Why: reuse the same createTab + queueTabStartupCommand path that the
  // tab-bar quick-launch and new-workspace flows use. The startup command
  // is fired once the PTY shell is ready, which avoids the race between
  // tab creation and shell readiness.
  const newTab = store.createTab(activeWorktreeId)
  store.queueTabStartupCommand(newTab.id, {
    command: launchCommand
  })

  // Why: mirror launchAgentInNewTab's post-create UI choreography — flip
  // the worktree to terminal view and focus the freshly-created tab so the
  // first keystroke after invocation lands in the right surface.
  store.setActiveTabType('terminal')
  store.setActiveTabForWorktree(activeWorktreeId, newTab.id)

  // Why: append the new tab to the end of the visual order. Without this,
  // reconcileTabOrder falls back to terminals-first when the stored order
  // is unset, which can jump the new tab to index 0 instead of the end —
  // mirrors the choreography in launchAgentInNewTab + Terminal.handleNewTab.
  const fresh = useAppStore.getState()
  const termIds = (fresh.tabsByWorktree[activeWorktreeId] ?? []).map((t) => t.id)
  const editorIds = fresh.openFiles
    .filter((f) => f.worktreeId === activeWorktreeId)
    .map((f) => f.id)
  const browserIds = (fresh.browserTabsByWorktree?.[activeWorktreeId] ?? []).map((t) => t.id)
  const storedOrder = fresh.tabBarOrderByWorktree[activeWorktreeId] ?? []
  const validIds = new Set([...termIds, ...editorIds, ...browserIds])
  const base = storedOrder.filter((id) => validIds.has(id))
  const inBase = new Set(base)
  for (const id of [...termIds, ...editorIds, ...browserIds]) {
    if (!inBase.has(id)) {
      base.push(id)
      inBase.add(id)
    }
  }
  const order = base.filter((id) => id !== newTab.id)
  order.push(newTab.id)
  fresh.setTabBarOrder(activeWorktreeId, order)

  return true
}
