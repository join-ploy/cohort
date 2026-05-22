import React, { useCallback, useEffect, useState } from 'react'
import { Play, Square } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import {
  getGroupByWorktreeId,
  getMemberWorktreesForGroup,
  getRepoMapFromState,
  useActiveWorktree,
  useRepoById
} from '@/store/selectors'
import type { ScriptState } from '@/store/slices/scripts'
import SidebarPtyTerminal from './SidebarPtyTerminal'
import { SetupPanelGroupContainer } from './SetupPanelGroupView'
import type { OrcaHooks } from '../../../../shared/types'
import type {
  SetupStartArgs,
  SetupStartResult,
  SetupStopArgs,
  SetupStopResult
} from '../../../../shared/script-types'

// Why: mirror of RunPanel for the per-worktree setup script. Differences:
// (1) state is keyed by worktreeId (not repoId), (2) `start` / `stop` take
// `{ worktreeId }` only — repoId is derived inside main, (3) no Cmd+R hint
// (Cmd+R is reserved for the run script per docs/plans/2026-05-14-per-repo-
// run-script-design.md). The view component is exported separately so tests
// can render the empty / configured branches without firing the async
// hooks-check IPC, which a `node`-environment vitest run can never resolve
// in time for renderToStaticMarkup.

export type SetupPanelViewProps = {
  /** Trimmed setup script body from `orca.yaml`. `undefined` → empty state. */
  setupScript: string | undefined
  /** Per-worktree setup state mirrored from the scripts slice. */
  setupState: ScriptState | null
  /** True when the active worktree is the primary working tree. Setup is
   *  reserved for `git worktree add`-created worktrees, so this branch
   *  renders an explanatory disabled state instead of the Re-run controls. */
  isPrimaryWorktree: boolean
  onReRun: () => void
  onStop: () => void
  /** Open the repo's orca.yaml in the editor (no-op until Phase 8 wires it). */
  onOpenOrcaYaml: () => void
}

function statusLabel(setupState: ScriptState | null): string {
  if (!setupState || setupState.status === 'idle') {
    return 'never run'
  }
  if (setupState.status === 'running') {
    return 'running…'
  }
  return `exited ${setupState.exitCode ?? '?'}`
}

function SetupHeader({
  setupState,
  onReRun,
  onStop
}: Pick<SetupPanelViewProps, 'setupState' | 'onReRun' | 'onStop'>): React.JSX.Element {
  const isRunning = setupState?.status === 'running'
  // Why: h-9 (36px) matches the `.titlebar` height in main.css so the setup
  // panel chrome lines up with the terminal-pane tab strip above it.
  return (
    <div className="flex h-9 items-center justify-between gap-2 px-3 border-b border-border">
      <span className="text-xs text-muted-foreground truncate">{statusLabel(setupState)}</span>
      {isRunning ? (
        <Button
          variant="ghost"
          size="xs"
          onClick={onStop}
          aria-label="Stop setup script"
          className="gap-1"
        >
          <Square size={12} />
          Stop
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="xs"
          onClick={onReRun}
          aria-label="Re-run setup script"
          className="gap-1"
        >
          <Play size={12} />
          Re-run setup
        </Button>
      )}
    </div>
  )
}

function SetupTerminalArea({ ptyId }: { ptyId: string | null }): React.JSX.Element {
  // Why: when a PTY is live, mount SidebarPtyTerminal — the same minimal
  // xterm renderer RunPanel uses. The `key={ptyId}` forces a fresh
  // Terminal + subscription pair on each re-run so leftover scrollback
  // from the previous setup attempt does not leak into the new session.
  // No-PTY case shows a generic prompt; setup has no keyboard shortcut
  // (Cmd+R is run-only), so we point users at the Re-run button instead.
  if (!ptyId) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        Click Re-run setup to start
      </div>
    )
  }
  return <SidebarPtyTerminal key={ptyId} ptyId={ptyId} />
}

function SetupPrimaryState(): React.JSX.Element {
  // Why: setup runs only for `git worktree add`-created worktrees. The
  // primary checkout has no Re-run/Stop controls — surface that visibly so
  // the missing buttons aren't mistaken for a bug.
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm font-semibold text-foreground">
        Setup runs only when creating worktrees
      </p>
      <p className="text-xs text-muted-foreground/80">
        Setup is disabled for the primary repo. Switch to a worktree to view or re-run setup.
      </p>
    </div>
  )
}

function SetupEmptyState({ onOpenOrcaYaml }: { onOpenOrcaYaml: () => void }): React.JSX.Element {
  // Why: Orca consumes scripts.setup from either orca.yaml or conductor.json,
  // so the copy mentions both options instead of nudging users toward yaml.
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm text-muted-foreground">No setup script configured for this repo.</p>
      <p className="text-xs text-muted-foreground/80">
        Add a <code className="rounded bg-muted px-1 py-0.5 text-[11px]">scripts.setup</code> entry
        to <code className="rounded bg-muted px-1 py-0.5 text-[11px]">orca.yaml</code> or{' '}
        <code className="rounded bg-muted px-1 py-0.5 text-[11px]">conductor.json</code> in this
        repo.
      </p>
      <Button variant="outline" size="sm" onClick={onOpenOrcaYaml}>
        Open config
      </Button>
    </div>
  )
}

export function SetupPanelView({
  setupScript,
  setupState,
  isPrimaryWorktree,
  onReRun,
  onStop,
  onOpenOrcaYaml
}: SetupPanelViewProps): React.JSX.Element {
  // Why: empty-state wins over primary-state — the user's first action
  // should be configuring scripts.setup, not switching worktrees.
  if (!setupScript) {
    return <SetupEmptyState onOpenOrcaYaml={onOpenOrcaYaml} />
  }
  if (isPrimaryWorktree) {
    return <SetupPrimaryState />
  }
  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <SetupHeader setupState={setupState} onReRun={onReRun} onStop={onStop} />
      <SetupTerminalArea ptyId={setupState?.ptyId ?? null} />
    </div>
  )
}

// Why: extracted from the React handlers so we can unit-test the result
// branching (ok / spawn-failed / no-setup-script / not-running) without
// rendering the component or stubbing window.api globally. `not-running`
// from a stop call is intentionally swallowed — clicking Stop on an
// already-exited PTY is a benign race, not a user-facing error.
// Exported so the grouped shell in SetupPanelGroupView.tsx can reuse the
// same branching without a circular `_testing` re-export.
export async function callSetupStart(
  args: SetupStartArgs,
  deps: {
    start: (args: SetupStartArgs) => Promise<SetupStartResult>
    toastError: (message: string) => void
  }
): Promise<SetupStartResult> {
  const result = await deps.start(args)
  if (!result.ok) {
    deps.toastError(`Failed to start setup script: ${result.reason}`)
  }
  return result
}

export async function callSetupStop(
  args: SetupStopArgs,
  deps: {
    stop: (args: SetupStopArgs) => Promise<SetupStopResult>
    toastError: (message: string) => void
  }
): Promise<SetupStopResult> {
  const result = await deps.stop(args)
  if (!result.ok && result.reason !== 'not-running') {
    deps.toastError(`Failed to stop setup script: ${result.reason}`)
  }
  return result
}

export const _testing = { callSetupStart, callSetupStop }

export default function SetupPanel(): React.JSX.Element {
  const activeWorktree = useActiveWorktree()
  const repo = useRepoById(activeWorktree?.repoId ?? null)
  const setupState = useAppStore((s) =>
    activeWorktree ? (s.scriptsByWorktree[activeWorktree.id]?.setup ?? null) : null
  )
  // Why: detect whether the active worktree belongs to a group; if so we
  // render the segmented per-member shell instead of the single-worktree
  // panel. The members list is resolved through the same selectors used by
  // the workspace tree so ordering matches.
  const group = useAppStore((s) =>
    activeWorktree ? getGroupByWorktreeId(s, activeWorktree.id) : null
  )
  const groupMembers = useAppStore((s) => (group ? getMemberWorktreesForGroup(s, group.id) : null))
  const repoMap = useAppStore((s) => getRepoMapFromState(s))
  const memberSetupStates = useAppStore((s) => {
    if (!groupMembers) {
      return null
    }
    return groupMembers.map((wt) => s.scriptsByWorktree[wt.id]?.setup ?? null)
  })

  // Why: `orca.yaml` is parsed in main; we read it via the existing
  // hooks:check IPC and cache the trimmed setup script in local state.
  // Re-fetched whenever the active repo changes so switching repos picks
  // up their own scripts.setup.
  const [setupScript, setSetupScript] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!repo?.id) {
      setSetupScript(undefined)
      return
    }
    let cancelled = false
    void window.api.hooks
      .check({ repoId: repo.id })
      .then((result) => {
        if (cancelled) {
          return
        }
        const hooks = (result.hooks as OrcaHooks | null) ?? null
        const trimmed = hooks?.scripts?.setup?.trim()
        setSetupScript(trimmed && trimmed.length > 0 ? trimmed : undefined)
      })
      .catch(() => {
        if (!cancelled) {
          setSetupScript(undefined)
        }
      })
    return () => {
      cancelled = true
    }
  }, [repo?.id])

  const worktreeId = activeWorktree?.id ?? null

  const onReRun = useCallback(() => {
    if (!worktreeId) {
      return
    }
    void callSetupStart(
      { worktreeId },
      { start: window.api.setupScript.start, toastError: toast.error }
    )
  }, [worktreeId])

  const onStop = useCallback(() => {
    if (!worktreeId) {
      return
    }
    void callSetupStop(
      { worktreeId },
      { stop: window.api.setupScript.stop, toastError: toast.error }
    )
  }, [worktreeId])

  // TODO(phase-8): wire onOpenOrcaYaml — needs a renderer file-open helper
  // (or a new IPC) to surface orca.yaml in the editor. Left as a no-op so
  // the empty-state CTA is visible but inert until that infra exists.
  const onOpenOrcaYaml = useCallback(() => {}, [])

  // Why: branch AFTER all hooks fire so React's rule-of-hooks isn't
  // violated when the active worktree toggles between grouped and ungrouped.
  // The group container then takes over the per-member hooks-check + state
  // wiring on its own.
  if (group && groupMembers && groupMembers.length > 0) {
    return (
      <SetupPanelGroupContainer
        members={groupMembers}
        memberSetupStates={memberSetupStates ?? []}
        repoMap={repoMap}
        defaultActiveWorktreeId={activeWorktree?.id ?? null}
      />
    )
  }

  return (
    <SetupPanelView
      setupScript={setupScript}
      setupState={setupState}
      isPrimaryWorktree={activeWorktree?.isMainWorktree ?? false}
      onReRun={onReRun}
      onStop={onStop}
      onOpenOrcaYaml={onOpenOrcaYaml}
    />
  )
}
