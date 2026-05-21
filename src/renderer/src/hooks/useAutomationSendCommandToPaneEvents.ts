import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import type { OrcaHooks, SidebarPromptCommand } from '../../../shared/types'

/**
 * Handle main-process chain-executor requests to write a command into an
 * already-open pane (RunCommandRunner with `paneRef`).
 *
 * The resolution mirrors {@link useAutomationOpenCommandPaneEvents}:
 *   - source='custom': use `customCommand` verbatim.
 *   - source='review' / 'create-pr': look up the configured
 *     SidebarPromptCommand, layer on per-repo hook preferences, write the
 *     prompt body to disk, and build the canonical
 *     `${cmd.command} "$(cat "${promptPath}")"` launch command.
 * The resolved line is then written into the pane's live PTY with a trailing
 * newline (Enter), instead of spawning a new pane.
 */
export function useAutomationSendCommandToPaneEvents(): void {
  useEffect(() => {
    const unsubscribe = window.api.automations.onSendCommandToPane(
      async ({ requestId, paneKey, source, commandId, customCommand, worktreeId }) => {
        try {
          // Why: paneKey shape is `<tabId>:<paneId>`. Split on the FIRST colon
          // so a tabId with no colons resolves cleanly.
          const sepIdx = paneKey.indexOf(':')
          if (sepIdx <= 0) {
            window.api.automations.replySendCommandToPane(requestId, {
              ok: false,
              error: `Malformed paneKey: ${paneKey}`
            })
            return
          }
          const tabId = paneKey.slice(0, sepIdx)
          const store = useAppStore.getState()
          const ptyIds = store.ptyIdsByTabId[tabId] ?? []
          const ptyId = ptyIds[0]
          if (!ptyId) {
            window.api.automations.replySendCommandToPane(requestId, {
              ok: false,
              error: `No live PTY for paneKey ${paneKey}.`
            })
            return
          }

          let launchCommand: string
          if (source === 'custom') {
            const trimmed = (customCommand ?? '').trim()
            if (!trimmed) {
              window.api.automations.replySendCommandToPane(requestId, {
                ok: false,
                error: 'Custom run-command step is missing a command line.'
              })
              return
            }
            launchCommand = trimmed
          } else {
            const settings = store.settings
            if (!settings) {
              window.api.automations.replySendCommandToPane(requestId, {
                ok: false,
                error: 'Settings have not loaded yet — cannot resolve command.'
              })
              return
            }
            const commands: SidebarPromptCommand[] =
              source === 'review'
                ? (settings.reviewCommands ?? [])
                : (settings.createPrCommands ?? [])
            const cmd = commands.find((entry) => entry.id === commandId)
            if (!cmd) {
              window.api.automations.replySendCommandToPane(requestId, {
                ok: false,
                error: `No ${source === 'review' ? 'Review' : 'Create PR'} command with id "${commandId ?? ''}" is configured.`
              })
              return
            }
            // Resolve repo-scoped preferences best-effort — a hooks:check
            // failure must not block the automation. Falls through with the
            // bare prompt body in that case.
            let preferences: string | undefined
            try {
              const worktree = findWorktreeById(store.worktreesByRepo, worktreeId)
              if (worktree) {
                const result = await window.api.hooks.check({ repoId: worktree.repoId })
                const hooks = (result.hooks as OrcaHooks | null) ?? null
                preferences =
                  source === 'review' ? hooks?.reviewPreferences : hooks?.createPrPreferences
              }
            } catch (err) {
              console.error('[automation-send-command-to-pane] hooks:check failed:', err)
            }
            const body = preferences ? `${cmd.prompt}\n\n${preferences}` : cmd.prompt
            const promptPath = await window.api.prompts.write({ label: cmd.label, body })
            launchCommand = `${cmd.command} "$(cat "${promptPath}")"`
          }

          // Trailing newline submits the command (Enter).
          window.api.pty.write(ptyId, `${launchCommand}\n`)
          window.api.automations.replySendCommandToPane(requestId, { ok: true })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          window.api.automations.replySendCommandToPane(requestId, { ok: false, error: message })
        }
      }
    )
    return unsubscribe
  }, [])
}
