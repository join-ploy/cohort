import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { registerEagerPtyBuffer } from '@/components/terminal-pane/pty-dispatcher'
import { FIRST_PANE_ID } from '../../../shared/pane-key'
import type { OrcaHooks, SidebarPromptCommand } from '../../../shared/types'

/**
 * Handle main-process chain-executor requests to open a command pane.
 *
 * The main-process helper `openCommandPane` sends a request keyed by
 * requestId on `automations:openCommandPane`. This hook resolves it by:
 *  1. Looking up the requested SidebarPromptCommand from settings (or using
 *     `customCommand` directly for source='custom').
 *  2. Writing the prompt body to `~/.orca/prompts/<label>.md` (for review /
 *     create-pr; skipped for custom).
 *  3. Spawning the PTY directly so we can capture `ptyId` synchronously and
 *     hand it back to the runner for exit tracking.
 *  4. Attaching an inactive background terminal tab to the live PTY (createTab
 *     with initialPtyId — see the spawn-first WHY comment below for the race
 *     this ordering avoids).
 *
 * Why a direct spawn (not `invokeSidebarPromptCommand`): that helper drives
 * the active worktree and either piggybacks on an existing terminal (for
 * Create PR) or routes through queueTabStartupCommand, neither of which give
 * us a ptyId we can hand back to main. Automation runs need deterministic
 * exit tracking, so we mirror `launchAgentBackgroundSession`'s direct-spawn
 * pattern instead.
 */
export function useAutomationOpenCommandPaneEvents(): void {
  useEffect(() => {
    const unsubscribe = window.api.automations.onOpenCommandPane(
      async ({
        requestId,
        worktreeId,
        worktreePath,
        connectionId,
        source,
        commandId,
        customCommand,
        memberScoped
      }) => {
        try {
          const store = useAppStore.getState()
          const worktree = findWorktreeById(store.worktreesByRepo, worktreeId)
          if (!worktree) {
            window.api.automations.replyOpenCommandPane(requestId, {
              ok: false,
              error: `Worktree "${worktreeId}" is no longer available.`
            })
            return
          }
          const repo = store.repos.find((entry) => entry.id === worktree.repoId)

          let launchCommand: string
          if (source === 'custom') {
            const trimmed = (customCommand ?? '').trim()
            if (!trimmed) {
              window.api.automations.replyOpenCommandPane(requestId, {
                ok: false,
                error: 'Custom run-command step is missing a command line.'
              })
              return
            }
            launchCommand = trimmed
          } else {
            const settings = store.settings
            if (!settings) {
              window.api.automations.replyOpenCommandPane(requestId, {
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
              window.api.automations.replyOpenCommandPane(requestId, {
                ok: false,
                error: `No ${source === 'review' ? 'Review' : 'Create PR'} command with id "${commandId ?? ''}" is configured.`
              })
              return
            }

            // Why: per-repo preferences layer on top of the user's global
            // prompt — best-effort, mirroring `invokeSidebarPromptCommand`.
            // A hooks:check failure here must not block the automation, so
            // we fall through with just the bare prompt body.
            let preferences: string | undefined
            try {
              const result = await window.api.hooks.check({ repoId: worktree.repoId })
              const hooks = (result.hooks as OrcaHooks | null) ?? null
              preferences =
                source === 'review' ? hooks?.reviewPreferences : hooks?.createPrPreferences
            } catch (err) {
              console.error('[automation-command-pane] hooks:check failed:', err)
            }

            const body = preferences ? `${cmd.prompt}\n\n${preferences}` : cmd.prompt
            // Why: automation run-command steps can launch in parallel. The
            // shell reads this file later via $(cat ...), so using the shared
            // command label would let sibling launches overwrite each other
            // before their shells expand the prompt path.
            const promptPath = await window.api.prompts.write({
              label: `${cmd.label}-${requestId}`,
              body
            })
            // Why: shell-escape the prompt path with double quotes so spaces
            // are tolerated. `$(cat "...")` is the canonical bash/zsh form;
            // the outer double quotes around `$(...)` preserve the full
            // multi-line prompt as a single argv element to the command.
            launchCommand = `${cmd.command} "$(cat "${promptPath}")"`
          }

          // Why: spawn-first to avoid a TerminalPane auto-spawn race. The
          // chain executor immediately reveals the new tab in the member's
          // group card; if we createTab → await pty.spawn, TerminalPane mounts
          // mid-await against a tab whose ptyId is still null, hits its
          // FRESH SPAWN path, and binds a phantom shell to the visible pane
          // while our explicit run-command PTY runs invisibly. Pre-mint the
          // tabId, spawn the PTY against it, then call createTab with
          // initialPtyId so TerminalPane never observes a tab without a PTY.
          // See user reproduction in commit 7d26a9c5 diagnostics.
          const tabId = globalThis.crypto.randomUUID()
          const paneKey = `${tabId}:${FIRST_PANE_ID}`
          const paneEnv = {
            ORCA_PANE_KEY: paneKey,
            ORCA_TAB_ID: tabId,
            ORCA_WORKTREE_ID: worktreeId
          }
          const result = await window.api.pty.spawn({
            cols: 120,
            rows: 40,
            cwd: worktreePath ?? worktree.path,
            command: launchCommand,
            env: paneEnv,
            connectionId: connectionId ?? repo?.connectionId ?? null,
            worktreeId,
            tabId,
            leafId: 'pane:1',
            // Why: when the runner unwrapped a member-scoped ref, the agent
            // should run at the member's worktreePath — not the group's
            // parent. Forward as `keepCwd: true` so Phase J1 skips the
            // standard grouped-member CWD lift. Parity with run-prompt's
            // launchAgentBackgroundSession.
            ...(memberScoped ? { keepCwd: true } : {})
          })
          // Why: hidden run-command PTYs can emit output before TerminalPane
          // mounts. Register the eager handle before publishing the tab so a
          // fast reveal attaches to this PTY instead of spawning by sessionId.
          registerEagerPtyBuffer(result.id, (ptyId) => {
            useAppStore.getState().clearTabPtyId(tabId, ptyId)
          })
          store.createTab(worktreeId, undefined, undefined, {
            activate: false,
            id: tabId,
            initialPtyId: result.id
          })

          window.api.automations.replyOpenCommandPane(requestId, {
            ok: true,
            ptyId: result.id,
            paneKey
          })
        } catch (err) {
          // Why: surface the renderer-side reason verbatim so the chain
          // executor can fail-fast with a meaningful step error. Empty catch
          // here would silently degrade into a 30s timeout in main.
          const message = err instanceof Error ? err.message : String(err)
          window.api.automations.replyOpenCommandPane(requestId, { ok: false, error: message })
        }
      }
    )
    return unsubscribe
  }, [])
}
