import React, { useEffect, useState } from 'react'
import { Play, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { useActiveWorktree, useRepoById } from '@/store/selectors'
import type { ScriptState } from '@/store/slices/scripts'
import type { OrcaHooks } from '../../../../shared/types'

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
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border">
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

function RunTerminalPlaceholder({ ptyId }: { ptyId: string | null }): React.JSX.Element {
  // Why: Phase 6 ships the panel scaffolding; embedding the full TerminalPane
  // here requires plumbing the right-sidebar through the tab/PaneManager
  // contract that TerminalPane expects. Phase 7+ (or a later refactor) will
  // mount the xterm renderer bound to ptyId. For now the area shows a hint
  // so the user knows the run is alive even before output rendering lands.
  if (!ptyId) {
    const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
    const shortcut = isMac ? '⌘R' : 'Ctrl+R'
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        Press {shortcut} to run
      </div>
    )
  }
  return (
    <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
      Output streaming to pty {ptyId}
    </div>
  )
}

function RunEmptyState({ onOpenOrcaYaml }: { onOpenOrcaYaml: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm text-muted-foreground">No run script configured for this repo.</p>
      <p className="text-xs text-muted-foreground/80">
        Add a <code className="rounded bg-muted px-1 py-0.5 text-[11px]">scripts.run</code> entry to{' '}
        <code className="rounded bg-muted px-1 py-0.5 text-[11px]">orca.yaml</code> to enable Cmd+R.
      </p>
      <Button variant="outline" size="sm" onClick={onOpenOrcaYaml}>
        Open orca.yaml
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
      <RunTerminalPlaceholder ptyId={runState?.ptyId ?? null} />
    </div>
  )
}

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

  // TODO(phase-8): wire onOpenOrcaYaml + onReRun/onStop in Task 6.2 and
  // the Cmd+R shortcut hook.
  return (
    <RunPanelView
      runScript={runScript}
      runState={runState}
      onReRun={() => {}}
      onStop={() => {}}
      onOpenOrcaYaml={() => {}}
    />
  )
}
