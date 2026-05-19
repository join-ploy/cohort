import React, { useCallback, useEffect, useState } from 'react'
import { Play, Square } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { useActiveWorktree, useRepoById } from '@/store/selectors'
import type { ScriptState } from '@/store/slices/scripts'
import SidebarPtyTerminal from './SidebarPtyTerminal'
import type { OrcaHooks } from '../../../../shared/types'
import type {
  RunStartArgs,
  RunStartResult,
  RunStopArgs,
  RunStopResult
} from '../../../../shared/script-types'

// Why: header lives next to the terminal output area inside the same
// flex column so the terminal area can grow to fill remaining space.
// The view is exported separately from the default container so tests can
// render the empty / configured branches directly without depending on the
// async hooks-check IPC, which a `node`-environment vitest run can never
// resolve in time for renderToStaticMarkup.

export type RunPanelViewProps = {
  /** Trimmed run script body from `orca.yaml`. `undefined` → empty state. */
  runScript: string | undefined
  /** Per-worktree run state mirrored from the scripts slice. */
  runState: ScriptState | null
  onReRun: () => void
  onStop: () => void
  /** Open the repo's orca.yaml in the editor (no-op until Phase 8 wires it). */
  onOpenOrcaYaml: () => void
}

function statusLabel(runState: ScriptState | null): string {
  if (!runState || runState.status === 'idle') {
    return 'never run'
  }
  if (runState.status === 'running') {
    return 'running…'
  }
  return `exited ${runState.exitCode ?? '?'}`
}

function RunHeader({
  runState,
  onReRun,
  onStop
}: Pick<RunPanelViewProps, 'runState' | 'onReRun' | 'onStop'>): React.JSX.Element {
  const isRunning = runState?.status === 'running'
  // Why: h-9 (36px) matches the `.titlebar` height in main.css so the run
  // panel chrome lines up with the terminal-pane tab strip above it.
  return (
    <div className="flex h-9 items-center justify-between gap-2 px-3 border-b border-border">
      <span className="text-xs text-muted-foreground truncate">{statusLabel(runState)}</span>
      {isRunning ? (
        <Button
          variant="ghost"
          size="xs"
          onClick={onStop}
          aria-label="Stop run script"
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
          aria-label="Re-run script"
          className="gap-1"
        >
          <Play size={12} />
          Re-run
        </Button>
      )}
    </div>
  )
}

function RunTerminalArea({ ptyId }: { ptyId: string | null }): React.JSX.Element {
  // Why: when a PTY is live, mount SidebarPtyTerminal — a minimal xterm
  // renderer that streams pty:data and forwards keystrokes (incl. Ctrl+C)
  // back via window.api.pty.write. The `key={ptyId}` forces a fresh
  // Terminal + subscription pair on each re-run so leftover scrollback
  // from the previous run does not leak into the new session.
  // No-PTY case keeps the keyboard hint so users know how to start a run.
  if (!ptyId) {
    const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
    const shortcut = isMac ? '⌘R' : 'Ctrl+R'
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        Press {shortcut} to run
      </div>
    )
  }
  // Why: small inset around the xterm canvas so output isn't flush against
  // the panel chrome. The padded area shows the panel background, framing
  // the terminal slightly without changing the terminal's own theme.
  return (
    <div className="flex flex-1 min-h-0 px-2 pt-2">
      <SidebarPtyTerminal key={ptyId} ptyId={ptyId} />
    </div>
  )
}

function RunEmptyState({ onOpenOrcaYaml }: { onOpenOrcaYaml: () => void }): React.JSX.Element {
  // Why: Orca consumes scripts.run from either orca.yaml or conductor.json,
  // so the copy mentions both options instead of nudging users toward yaml.
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm text-muted-foreground">No run script configured for this repo.</p>
      <p className="text-xs text-muted-foreground/80">
        Add a <code className="rounded bg-muted px-1 py-0.5 text-[11px]">scripts.run</code> entry to{' '}
        <code className="rounded bg-muted px-1 py-0.5 text-[11px]">orca.yaml</code> or{' '}
        <code className="rounded bg-muted px-1 py-0.5 text-[11px]">conductor.json</code> in this
        repo.
      </p>
      <Button variant="outline" size="sm" onClick={onOpenOrcaYaml}>
        Open config
      </Button>
    </div>
  )
}

export function RunPanelView({
  runScript,
  runState,
  onReRun,
  onStop,
  onOpenOrcaYaml
}: RunPanelViewProps): React.JSX.Element {
  if (!runScript) {
    return <RunEmptyState onOpenOrcaYaml={onOpenOrcaYaml} />
  }
  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <RunHeader runState={runState} onReRun={onReRun} onStop={onStop} />
      <RunTerminalArea ptyId={runState?.ptyId ?? null} />
    </div>
  )
}

// Why: extracted from the React handlers so we can unit-test the result
// branching (ok / spawn-failed / no-run-script / not-running) without
// rendering the component or stubbing window.api globally. The injected
// `start`/`stop`/`toastError` shape mirrors what the panel passes at runtime
// and is the only seam we need for branch coverage. `not-running` from a
// stop call is intentionally swallowed — clicking Stop on an already-exited
// PTY is a benign race, not a user-facing error.
async function callRunStart(
  args: RunStartArgs,
  deps: {
    start: (args: RunStartArgs) => Promise<RunStartResult>
    toastError: (message: string) => void
  }
): Promise<RunStartResult> {
  const result = await deps.start(args)
  if (!result.ok) {
    deps.toastError(`Failed to start run script: ${result.reason}`)
  }
  return result
}

async function callRunStop(
  args: RunStopArgs,
  deps: {
    stop: (args: RunStopArgs) => Promise<RunStopResult>
    toastError: (message: string) => void
  }
): Promise<RunStopResult> {
  const result = await deps.stop(args)
  if (!result.ok && result.reason !== 'not-running') {
    deps.toastError(`Failed to stop run script: ${result.reason}`)
  }
  return result
}

export const _testing = { callRunStart, callRunStop }

export default function RunPanel(): React.JSX.Element {
  const activeWorktree = useActiveWorktree()
  const repo = useRepoById(activeWorktree?.repoId ?? null)
  const runState = useAppStore((s) =>
    activeWorktree ? (s.scriptsByWorktree[activeWorktree.id]?.run ?? null) : null
  )
  // Why: `orca.yaml` is parsed in the main process; we read it via the
  // existing hooks:check IPC and cache the trimmed run script in local state.
  // Re-fetched whenever the active repo changes so switching repos picks up
  // their own scripts.run.
  const [runScript, setRunScript] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!repo?.id) {
      setRunScript(undefined)
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
        const trimmed = hooks?.scripts?.run?.trim()
        setRunScript(trimmed && trimmed.length > 0 ? trimmed : undefined)
      })
      .catch(() => {
        if (!cancelled) {
          setRunScript(undefined)
        }
      })
    return () => {
      cancelled = true
    }
  }, [repo?.id])

  const repoId = repo?.id ?? null
  const worktreeId = activeWorktree?.id ?? null

  const onReRun = useCallback(() => {
    if (!repoId || !worktreeId) {
      return
    }
    void callRunStart(
      { repoId, worktreeId },
      { start: window.api.runScript.start, toastError: toast.error }
    )
  }, [repoId, worktreeId])

  const onStop = useCallback(() => {
    if (!repoId) {
      return
    }
    void callRunStop({ repoId }, { stop: window.api.runScript.stop, toastError: toast.error })
  }, [repoId])

  // TODO(phase-8): wire onOpenOrcaYaml — needs a renderer file-open helper
  // (or a new IPC) to surface orca.yaml in the editor. Left as a no-op so
  // the empty-state CTA is visible but inert until that infra exists.
  const onOpenOrcaYaml = useCallback(() => {}, [])

  return (
    <RunPanelView
      runScript={runScript}
      runState={runState}
      onReRun={onReRun}
      onStop={onStop}
      onOpenOrcaYaml={onOpenOrcaYaml}
    />
  )
}
