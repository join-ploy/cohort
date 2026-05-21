import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import type { OrcaHooks, SidebarPromptCommand } from '../../../shared/types'

// Why: agent TUIs (Claude, Codex, OpenCode, …) treat the input as a draft
// until they see a carriage return (`\r`) — the key that the terminal sends
// when Enter is pressed. A bare `\n` is line-feed, which line-buffered shells
// accept as Enter but agents in raw mode often don't. Bracketed paste also
// stops the inserted text from being interpreted character-by-character, so
// long multi-line commands don't get mangled mid-write. The shells we target
// also understand bracketed paste, so we can use the same envelope for every
// pane regardless of what's running in it.
const BRACKETED_PASTE_BEGIN = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'

// Why: when the bracketed-paste end marker and the submit `\r` land in the
// same PTY write, some agents consume the `\r` as part of paste processing
// instead of as the Enter that submits the buffered text — the operator
// sees the prompt sit in the input box requiring a manual Enter. Splitting
// the write and giving the agent's paste handler a brief moment to finish
// is the standard fix.
const ENTER_DELAY_MS = 80

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
            // Why: we're writing into an existing pane, which already has an
            // agent (Claude/Codex/…) running. Send just the prompt body as a
            // follow-up turn — sending the wrapped launch command
            // (`claude "$(cat …)"`) would inject those characters literally
            // into the running agent's input box, which is not what the
            // operator wants. The prompt-on-disk indirection is only useful
            // when spawning a fresh pane via openCommandPane.
            launchCommand = preferences ? `${cmd.prompt}\n\n${preferences}` : cmd.prompt
          }

          // Bracketed-paste envelope keeps multi-line commands intact; write
          // the paste first, give the agent a moment to finish processing
          // the end marker, then send the submit `\r` in a separate write so
          // the Enter isn't swallowed as part of the paste.
          window.api.pty.write(
            ptyId,
            `${BRACKETED_PASTE_BEGIN}${launchCommand}${BRACKETED_PASTE_END}`
          )
          await new Promise((resolve) => setTimeout(resolve, ENTER_DELAY_MS))
          window.api.pty.write(ptyId, '\r')
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
