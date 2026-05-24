import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
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
 *  3. Creating an inactive background terminal tab in the target worktree.
 *  4. Spawning the PTY directly so we can capture `ptyId` synchronously and
 *     hand it back to the runner for exit tracking.
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
      async ({ requestId, worktreeId, source, commandId, customCommand }) => {
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
            const promptPath = await window.api.prompts.write({ label: cmd.label, body })
            // Why: shell-escape the prompt path with double quotes so spaces
            // are tolerated. `$(cat "...")` is the canonical bash/zsh form;
            // the outer double quotes around `$(...)` preserve the full
            // multi-line prompt as a single argv element to the command.
            launchCommand = `${cmd.command} "$(cat "${promptPath}")"`
          }

          // Why: spawn the PTY immediately and attach an inactive tab to the
          // live session — mirrors `launchAgentBackgroundSession`'s pattern so
          // automation runs do not steal the worktree's focus.
          const tab = store.createTab(worktreeId, undefined, undefined, { activate: false })
          const paneKey = `${tab.id}:${FIRST_PANE_ID}`
          const paneEnv = {
            ORCA_PANE_KEY: paneKey,
            ORCA_TAB_ID: tab.id,
            ORCA_WORKTREE_ID: worktreeId
          }
          // Why (debug-group-runcmd): capture the freshly-created tab state
          // BEFORE pty.spawn so we can tell whether something (e.g. a parallel
          // mount path) bound a PTY to the tab while our IPC was in flight.
          // tab.ptyId here SHOULD be null — initialPtyId isn't passed.
          const preSpawnPtyIds = useAppStore.getState().ptyIdsByTabId[tab.id]?.slice() ?? []
          console.log('[debug-group-runcmd] pre-spawn', {
            tabId: tab.id,
            worktreeId,
            cwdSentToMain: worktree.path,
            tabPtyId: tab.ptyId,
            ptyIdsByTabIdLen: preSpawnPtyIds.length,
            ptyIdsByTabId: preSpawnPtyIds
          })
          let result
          try {
            result = await window.api.pty.spawn({
              cols: 120,
              rows: 40,
              cwd: worktree.path,
              command: launchCommand,
              env: paneEnv,
              connectionId: repo?.connectionId ?? null,
              worktreeId,
              tabId: tab.id,
              leafId: 'pane:1'
            })
          } catch (err) {
            store.closeTab(tab.id)
            throw err
          }
          // Why (debug-group-runcmd): is the freshly-spawned PTY id different
          // from anything already bound? If so, the tab is racing two PTYs.
          const beforeBindState = useAppStore.getState()
          const beforeBindTab = beforeBindState.tabsByWorktree[worktreeId]?.find(
            (t) => t.id === tab.id
          )
          console.log('[debug-group-runcmd] post-spawn pre-bind', {
            tabId: tab.id,
            spawnedPtyId: result.id,
            tabPtyId: beforeBindTab?.ptyId ?? null,
            ptyIdsByTabIdLen: (beforeBindState.ptyIdsByTabId[tab.id] ?? []).length,
            ptyIdsByTabId: beforeBindState.ptyIdsByTabId[tab.id]?.slice() ?? []
          })
          store.updateTabPtyId(tab.id, result.id)
          // Why (debug-group-runcmd): after the binding call, did tab.ptyId
          // actually pick up our explicit spawn id? If a phantom PTY was first,
          // tab.ptyId will NOT equal result.id (terminals.ts:919 preserves the
          // existing tab.ptyId).
          const afterBindState = useAppStore.getState()
          const afterBindTab = afterBindState.tabsByWorktree[worktreeId]?.find(
            (t) => t.id === tab.id
          )
          console.log('[debug-group-runcmd] post-bind', {
            tabId: tab.id,
            spawnedPtyId: result.id,
            tabPtyId: afterBindTab?.ptyId ?? null,
            tabPtyIdMatchesSpawn: afterBindTab?.ptyId === result.id,
            ptyIdsByTabIdLen: (afterBindState.ptyIdsByTabId[tab.id] ?? []).length,
            ptyIdsByTabId: afterBindState.ptyIdsByTabId[tab.id]?.slice() ?? []
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
