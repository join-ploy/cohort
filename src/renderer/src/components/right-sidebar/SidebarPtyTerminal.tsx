import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
// Why: xterm.css is imported globally from src/renderer/src/assets/main.css,
// so we don't repeat the import here — Vite would dedupe but the explicit
// duplicate has caused phantom-style ordering bugs in the past.
import { buildDefaultTerminalOptions } from '@/lib/pane-manager/pane-terminal-options'
import { subscribeToPtyData, subscribeToPtyExit } from '@/components/terminal-pane/pty-dispatcher'

// Why: minimal xterm renderer used by the right-sidebar Run/Setup panels to
// stream output of a single, eagerly-spawned PTY (the per-repo run/setup
// script). The full TerminalPane requires tabId + PaneManager + layout
// snapshot machinery — far too much for a single-PTY view. We reuse the
// canonical building blocks (`buildDefaultTerminalOptions`, the singleton
// pty dispatcher) so behaviour stays consistent with multi-pane terminals.
//
// Subscribing via `subscribeToPtyData` (sidecar API) is intentional: the
// script PTY does not go through `createIpcPtyTransport`, so there is no
// primary `ptyDataHandlers` entry to collide with. Sidecars receive every
// `pty:data` payload for the id and remove cleanly on unsubscribe.

export type SidebarPtyTerminalProps = {
  /** PTY identifier returned by `runScript.start` / `setupScript.start`. */
  ptyId: string
}

export default function SidebarPtyTerminal({ ptyId }: SidebarPtyTerminalProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const term = new Terminal(buildDefaultTerminalOptions())
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)

    // Why: the container's real size is laid out a frame after `term.open`,
    // so a synchronous `fit()` would compute against zero/stale dimensions
    // and ship `pty.resize(id, 0, 0)`. Defer to the next animation frame.
    let pendingFitRaf: number | null = requestAnimationFrame(() => {
      pendingFitRaf = null
      runFit()
    })

    function runFit(): void {
      try {
        fit.fit()
      } catch {
        // Why: fit() throws when the container has no rendered geometry yet
        // (e.g. the panel is collapsed or the tab is not visible). Skipping
        // the resize lets the next ResizeObserver tick recover automatically
        // once layout settles.
        return
      }
      const cols = term.cols
      const rows = term.rows
      if (cols > 0 && rows > 0) {
        window.api.pty.resize(ptyId, cols, rows)
      }
    }

    // Why: ResizeObserver fires synchronously on layout changes (panel
    // resize, window resize, sidebar collapse). Coalesce into rAF so a
    // burst of size events triggers exactly one fit per frame.
    let resizeRaf: number | null = null
    const ro = new ResizeObserver(() => {
      if (resizeRaf !== null) {
        return
      }
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null
        runFit()
      })
    })
    ro.observe(container)

    const offData = subscribeToPtyData(ptyId, (data) => {
      term.write(data)
    })
    const offExit = subscribeToPtyExit(ptyId, () => {
      // Why: when the script exits we keep the final output on screen so
      // the user can read the failure / completion banner. The store's
      // `handleRunExited` (driven by the run:exited IPC, see useIpcEvents)
      // updates the panel header; we don't need to react here.
    })

    const onInput = term.onData((data) => {
      // Why: forward keystrokes (incl. Ctrl+C) so the user can interrupt
      // the running script directly from the sidebar terminal.
      window.api.pty.write(ptyId, data)
    })

    return () => {
      if (pendingFitRaf !== null) {
        cancelAnimationFrame(pendingFitRaf)
      }
      if (resizeRaf !== null) {
        cancelAnimationFrame(resizeRaf)
      }
      ro.disconnect()
      onInput.dispose()
      offData()
      offExit()
      try {
        fit.dispose()
      } catch {
        /* ignore */
      }
      try {
        term.dispose()
      } catch {
        /* ignore */
      }
    }
  }, [ptyId])

  // Why: `min-h-0` lets this flex child shrink below its content height so
  // the parent's flex column can size the terminal area to remaining space
  // instead of overflowing. `overflow-hidden` keeps xterm's render surface
  // from leaking past the rounded panel container.
  return <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden" />
}
