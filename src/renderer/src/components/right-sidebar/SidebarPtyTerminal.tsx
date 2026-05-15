import React, { useEffect, useRef } from 'react'
// Why: xterm.css is imported globally from src/renderer/src/assets/main.css,
// so we don't repeat the import here — Vite would dedupe but the explicit
// duplicate has caused phantom-style ordering bugs in the past.
import {
  attachCachedTerminal,
  detachCachedTerminal,
  notifyCachedTerminalAppearance
} from './sidebar-pty-terminal-cache'
import { useAppStore } from '@/store'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { useEffectiveMacOptionAsAlt } from '@/lib/keyboard-layout/use-effective-mac-option-as-alt'

// Why: thin React wrapper over the module-scoped sidebar-pty-terminal-
// cache. The cache holds the xterm Terminal + container + IPC subs alive
// across React unmounts so scrollback survives navigation (Settings,
// activity-bar tab switch, sidebar close). This component is just an
// attach/detach surface — it never creates or disposes the Terminal.
//
// Disposal of cached entries is triggered by the IPC layer:
// - script restart (new ptyId for the same worktree) → useIpcEvents
// - worktree delete → useIpcEvents (via worktrees.onChanged purge path)

export type SidebarPtyTerminalProps = {
  /** PTY identifier returned by `runScript.start` / `setupScript.start`. */
  ptyId: string
}

export default function SidebarPtyTerminal({ ptyId }: SidebarPtyTerminalProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)

  const settings = useAppStore((s) => s.settings)
  const systemPrefersDark = useSystemPrefersDark()
  // Why: 'auto' is resolved into 'true' | 'false' via the keyboard-layout
  // probe — same hook the regular pane uses so Option-as-Alt behavior
  // stays consistent (Turkish/German Option composes work in the sidebar
  // PTY too). Defaults to 'true' (US fallback) when settings haven't
  // hydrated, matching the regular pane's pre-hydration behavior.
  const effectiveMacOptionAsAlt = useEffectiveMacOptionAsAlt(settings?.terminalMacOptionAsAlt)

  useEffect(() => {
    const host = containerRef.current
    if (!host) {
      return
    }
    attachCachedTerminal(ptyId, host, {
      settings,
      systemPrefersDark,
      effectiveMacOptionAsAlt
    })
    return () => {
      detachCachedTerminal(ptyId, host)
    }
    // Why: settings/theme changes are handled by the reactive notify
    // effect below, NOT by re-running attach. Re-attaching would tear
    // down the ResizeObserver and re-fit unnecessarily on every settings
    // change. The mount-time settings snapshot is correct for first
    // paint; later changes flow through the apply effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyId])

  // Why: live re-apply of settings + system theme to the existing cached
  // terminal, mirroring how use-terminal-pane-lifecycle re-runs
  // applyTerminalAppearance on every change. The cache forwards to the
  // same applyTerminalOptionsToTerminal helper underneath, so the
  // sidebar PTY tracks the regular pane's styling exactly.
  useEffect(() => {
    notifyCachedTerminalAppearance(ptyId, {
      settings,
      systemPrefersDark,
      effectiveMacOptionAsAlt
    })
  }, [ptyId, settings, systemPrefersDark, effectiveMacOptionAsAlt])

  // Why: `min-h-0` lets this flex child shrink below its content height
  // so the parent's flex column can size the terminal area to remaining
  // space instead of overflowing. `overflow-hidden` keeps xterm's render
  // surface from leaking past the rounded panel container.
  return <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden" />
}
