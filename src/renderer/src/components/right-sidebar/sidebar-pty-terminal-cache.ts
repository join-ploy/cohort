import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import {
  applyTerminalOptionsToTerminal,
  buildTerminalOptionsFromSettings,
  resolveTerminalThemeFromSettings,
  type TerminalOptionDeps
} from '@/lib/pane-manager/build-terminal-options'
import { subscribeToPtyData, subscribeToPtyExit } from '@/components/terminal-pane/pty-dispatcher'
import type { GlobalSettings } from '../../../../shared/types'

// Why: the gutter around xterm replaces the prior `px-2 pt-2` Tailwind
// wrapper. Top + side padding only — no bottom — so the cursor row sits
// flush with the panel base, matching how the regular pane is framed.
const TERMINAL_GUTTER_CSS = '24px 24px 0 24px'

// Why: the right-sidebar Run/Setup terminals live inside the React tree
// (RunPanel / SetupPanel), which unmounts whenever the user navigates to
// Settings, switches activity-bar tabs, or closes the right sidebar.
// If we created the xterm `Terminal` inside the component's effect, that
// unmount disposed the buffer and lost every byte the script printed.
//
// This module-scoped cache keeps the Terminal + its container DOM node +
// the IPC subscriptions alive across React unmounts, keyed by ptyId.
// The component is then a pure attach/detach surface: it appends the
// cached container to its host on mount and removes it on cleanup —
// without disposing the Terminal. PTY data continues writing into the
// offscreen buffer while the panel is hidden, so the user sees the same
// scrollback when they come back.
//
// Disposal happens explicitly: when a script restart produces a new
// ptyId for the same worktree (the prior cached entry is now orphaned)
// or when a worktree is deleted (handled by useIpcEvents). See
// docs/plans/2026-05-14-per-repo-run-script-design.md.

export type AttachOptions = {
  /** Current renderer settings; settings can be `null` during the brief
   *  pre-hydration window, in which case xterm defaults apply. */
  settings: GlobalSettings | null
  systemPrefersDark: boolean
  effectiveMacOptionAsAlt: TerminalOptionDeps['effectiveMacOptionAsAlt']
}

export type CachedTerminal = {
  ptyId: string
  /** Persistent outer DOM node moved between hosts on attach/detach
   *  without ever being disposed. Painted with the terminal theme's
   *  background so the gutter blends with xterm's canvas. */
  container: HTMLDivElement
  /** Inner padded wrapper xterm rendered into. Lives inside `container`
   *  and provides the visible gutter; also painted with the theme
   *  background so opacity/transparency settings can stack cleanly. */
  inner: HTMLDivElement
  term: Terminal
  fit: FitAddon
}

type CacheEntry = CachedTerminal & {
  host: HTMLElement | null
  observer: ResizeObserver | null
  pendingFitRaf: number | null
  resizeRaf: number | null
  inputDisposable: { dispose: () => void }
  offData: () => void
  offExit: () => void
}

const cache = new Map<string, CacheEntry>()

function buildContainer(): { container: HTMLDivElement; inner: HTMLDivElement } {
  // Why: xterm requires a single host for `term.open()`. We render into an
  // inner padded div so the gutter and the xterm canvas can share the same
  // background color, making the terminal feel embedded into the panel
  // rather than floating on a contrasting border. The outer container is
  // the stable handle we move between React hosts — `term.open()` is only
  // ever called on the inner div, so moving the outer doesn't tear down
  // xterm's renderer state.
  const container = document.createElement('div')
  container.style.width = '100%'
  container.style.height = '100%'
  const inner = document.createElement('div')
  inner.style.width = '100%'
  inner.style.height = '100%'
  inner.style.boxSizing = 'border-box'
  inner.style.padding = TERMINAL_GUTTER_CSS
  container.appendChild(inner)
  return { container, inner }
}

function applyContainerBackground(entry: CacheEntry, opts: AttachOptions): void {
  // Why: paint the gutter the same color xterm paints its canvas so the
  // padding is invisible to the user. When settings haven't hydrated yet,
  // leave the background unset and let the panel chrome show through —
  // the appearance-notify call will repaint as soon as settings arrive.
  if (!opts.settings) {
    return
  }
  const { theme } = resolveTerminalThemeFromSettings(opts.settings, opts.systemPrefersDark)
  const bg = theme?.background
  if (!bg) {
    return
  }
  entry.container.style.backgroundColor = bg
  entry.inner.style.backgroundColor = bg
}

function runFit(entry: CacheEntry): void {
  try {
    entry.fit.fit()
  } catch {
    // Why: fit() throws when the container has no rendered geometry yet
    // (panel collapsed, tab not visible). The next ResizeObserver tick
    // will retry once layout settles.
    return
  }
  const { cols, rows } = entry.term
  if (cols > 0 && rows > 0) {
    window.api.pty.resize(entry.ptyId, cols, rows)
  }
}

function scheduleFit(entry: CacheEntry): void {
  if (entry.pendingFitRaf !== null) {
    return
  }
  entry.pendingFitRaf = requestAnimationFrame(() => {
    entry.pendingFitRaf = null
    runFit(entry)
  })
}

function observeHost(entry: CacheEntry, host: HTMLElement): void {
  // Why: ResizeObserver coalesces a burst of size events into one fit
  // per frame so panel-resize / window-resize storms don't ship dozens
  // of pty.resize() calls.
  const ro = new ResizeObserver(() => {
    if (entry.resizeRaf !== null) {
      return
    }
    entry.resizeRaf = requestAnimationFrame(() => {
      entry.resizeRaf = null
      runFit(entry)
    })
  })
  ro.observe(host)
  entry.observer = ro
}

function teardownObserver(entry: CacheEntry): void {
  if (entry.observer) {
    entry.observer.disconnect()
    entry.observer = null
  }
  if (entry.resizeRaf !== null) {
    cancelAnimationFrame(entry.resizeRaf)
    entry.resizeRaf = null
  }
}

function createEntry(ptyId: string, opts: AttachOptions): CacheEntry {
  // Why: same builder the regular pane uses so the sidebar terminal looks
  // identical at first paint (font, theme, cursor, scrollback, opacity,
  // Option-as-Alt). When `settings` is null (pre-hydration), pass an
  // empty options bag and let xterm fall back to its defaults — the
  // notify-appearance call from the React effect will reapply once
  // settings hydrate.
  const initialOptions = opts.settings
    ? buildTerminalOptionsFromSettings(opts.settings, {
        effectiveMacOptionAsAlt: opts.effectiveMacOptionAsAlt,
        systemPrefersDark: opts.systemPrefersDark
        // Why: sidebar has no zoom UI; let the global terminalFontSize win.
      })
    : {}
  const term = new Terminal(initialOptions)
  const fit = new FitAddon()
  term.loadAddon(fit)
  const { container, inner } = buildContainer()
  // Why: xterm renders into the inner padded div, not the outer
  // container — the gutter (TERMINAL_GUTTER_CSS) sits between the two.
  term.open(inner)

  const offData = subscribeToPtyData(ptyId, (data) => {
    term.write(data)
  })
  const offExit = subscribeToPtyExit(ptyId, () => {
    // Why: keep the final output on screen so the user can read the exit
    // banner. The store mirror (handleRunExited / handleSetupExited)
    // updates the panel header — no per-cache work needed here.
  })
  const inputDisposable = term.onData((data) => {
    // Why: forward keystrokes (incl. Ctrl+C) so the user can interrupt
    // the running script directly from the sidebar terminal.
    window.api.pty.write(ptyId, data)
  })

  const entry: CacheEntry = {
    ptyId,
    container,
    inner,
    term,
    fit,
    host: null,
    observer: null,
    pendingFitRaf: null,
    resizeRaf: null,
    inputDisposable,
    offData,
    offExit
  }
  // Why: seed the gutter color from initial settings so the first paint
  // (before the first appearance-notify) already blends with xterm.
  applyContainerBackground(entry, opts)
  return entry
}

/** Attach the cached terminal for `ptyId` to `host`, creating the entry
 *  on first call. Subsequent calls with the same `ptyId` reuse the same
 *  Terminal and move its container to the new host. */
export function attachCachedTerminal(
  ptyId: string,
  host: HTMLElement,
  opts: AttachOptions
): CachedTerminal {
  let entry = cache.get(ptyId)
  if (!entry) {
    entry = createEntry(ptyId, opts)
    cache.set(ptyId, entry)
  } else {
    // Why: clean up an in-flight observer before swapping hosts so the
    // detach path's invariants hold even when React's mount lifecycle
    // didn't run cleanup (re-attach without explicit detach).
    teardownObserver(entry)
    if (entry.host && entry.host !== host && entry.host.contains(entry.container)) {
      entry.host.removeChild(entry.container)
    }
  }
  if (entry.container.parentNode !== host) {
    host.appendChild(entry.container)
  }
  entry.host = host
  observeHost(entry, host)
  // Why: the new host's dimensions may differ from the prior one; defer
  // to next frame so layout has a chance to settle before we measure.
  scheduleFit(entry)
  return entry
}

/** Detach the cached container from `host` without disposing the
 *  Terminal. Subscriptions stay alive so PTY data keeps writing into
 *  the cached buffer while the panel is offscreen. */
export function detachCachedTerminal(ptyId: string, host: HTMLElement): void {
  const entry = cache.get(ptyId)
  if (!entry) {
    return
  }
  teardownObserver(entry)
  if (entry.pendingFitRaf !== null) {
    cancelAnimationFrame(entry.pendingFitRaf)
    entry.pendingFitRaf = null
  }
  // Why: only remove if the container is still inside this host. If
  // another mount has already moved it elsewhere, we mustn't yank it
  // back out from under the new owner.
  if (entry.host === host && host.contains(entry.container)) {
    host.removeChild(entry.container)
  }
  if (entry.host === host) {
    entry.host = null
  }
}

/** Re-apply settings + theme to the existing terminal without recreating
 *  it. Called from the component when settings, system theme, or the
 *  resolved Option-as-Alt change. */
export function notifyCachedTerminalAppearance(ptyId: string, opts: AttachOptions): void {
  const entry = cache.get(ptyId)
  if (!entry || !opts.settings) {
    return
  }
  applyTerminalOptionsToTerminal(entry.term, opts.settings, {
    effectiveMacOptionAsAlt: opts.effectiveMacOptionAsAlt,
    systemPrefersDark: opts.systemPrefersDark
  })
  // Why: keep the gutter color synced with the just-applied theme so a
  // light/dark toggle or theme swap doesn't leave a stale background
  // band around the freshly recolored xterm canvas.
  applyContainerBackground(entry, opts)
}

/** Tear down the cached entry: disposes Terminal + FitAddon, releases
 *  IPC subscriptions, removes the container from its host. Idempotent —
 *  unknown ptyIds are silent no-ops so callers (script-restart, worktree
 *  delete) can fire-and-forget. */
export function disposeCachedTerminal(ptyId: string): void {
  const entry = cache.get(ptyId)
  if (!entry) {
    return
  }
  cache.delete(ptyId)
  teardownObserver(entry)
  if (entry.pendingFitRaf !== null) {
    cancelAnimationFrame(entry.pendingFitRaf)
    entry.pendingFitRaf = null
  }
  if (entry.host && entry.host.contains(entry.container)) {
    entry.host.removeChild(entry.container)
  }
  entry.host = null
  try {
    entry.inputDisposable.dispose()
  } catch {
    /* ignore */
  }
  entry.offData()
  entry.offExit()
  try {
    entry.fit.dispose()
  } catch {
    /* ignore */
  }
  try {
    entry.term.dispose()
  } catch {
    /* ignore */
  }
}

/** Test/debug helper. Not exported through `index.ts`. */
export const _testing = {
  cache,
  clear(): void {
    for (const id of Array.from(cache.keys())) {
      disposeCachedTerminal(id)
    }
  }
}
