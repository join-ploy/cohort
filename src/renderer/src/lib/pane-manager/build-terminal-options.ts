import type { ITerminalOptions, ITheme, Terminal } from '@xterm/xterm'
import type { GlobalSettings } from '../../../../shared/types'
import { resolveTerminalFontWeights } from '../../../../shared/terminal-fonts'
import { HEX_COLOR_RE } from '../../../../shared/color-validation'
import { getBuiltinTheme, resolveEffectiveTerminalAppearance } from '../terminal-theme'
import { buildFontFamily } from '../../components/terminal-pane/layout-serialization'
import type { EffectiveMacOptionAsAlt } from '../keyboard-layout/detect-option-as-alt'
import { buildDefaultTerminalOptions } from './pane-terminal-options'

// Why colocated here (instead of a separate color/ module): hexToRgba is the
// only color helper we need, it has exactly two callers (this file +
// terminal-appearance.ts re-export for test compat), and breaking it out
// would just push the import cycle one level deeper. The function is small
// and pure — keeping it next to the only consumer that drives it (the
// theme-resolution helper below) is the simpler arrangement.
export function hexToRgba(hex: string, alpha: number): string {
  let clean = hex.replace('#', '')
  if (clean.length === 3) {
    clean = clean
      .split('')
      .map((c) => c + c)
      .join('')
  }
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// Why: shared "compute terminal options from settings" helper used at both
// construction time (regular pane + sidebar PTY) and on-the-fly settings
// changes. Centralising means the two code paths cannot drift on font,
// theme, opacity, or cursor styling.

export type TerminalOptionDeps = {
  /** Resolved Option-as-Alt value: `'auto'` has already been mapped to
   *  `'true' | 'false'` via the keyboard-layout probe. */
  effectiveMacOptionAsAlt: EffectiveMacOptionAsAlt
  /** Mirrors `(prefers-color-scheme: dark)` from the OS / browser. Drives
   *  `theme: 'system'` resolution into the dark or light variant. */
  systemPrefersDark: boolean
  /** Per-pane font-size override (Cmd+= zoom). When `undefined`, the global
   *  `terminalFontSize` is used. The sidebar terminal has no zoom UI and
   *  always passes `undefined`. */
  paneSize?: number
}

function isHexColor(value: string): boolean {
  return HEX_COLOR_RE.test(value)
}

/** Resolve the theme + opacity + override stack into the final xterm
 *  `ITheme`. Mirrors the per-pane block of `applyTerminalAppearance`. */
export function resolveTerminalThemeFromSettings(
  settings: GlobalSettings,
  systemPrefersDark: boolean
): { theme: ITheme | null; allowTransparency: boolean } {
  const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
  let theme: ITheme | null = appearance.theme ?? getBuiltinTheme(appearance.themeName)

  // Why: merge user-imported Ghostty color overrides on top of the resolved
  // base theme so individual colors can be tweaked without losing the rest.
  if (theme && settings.terminalColorOverrides) {
    theme = { ...theme, ...settings.terminalColorOverrides }
  }

  // Why: Ghostty's background-opacity controls the terminal's base alpha.
  // We convert the hex background to rgba and enable xterm transparency.
  const opacityActive =
    settings.terminalBackgroundOpacity !== undefined && settings.terminalBackgroundOpacity < 1
  if (settings.terminalBackgroundOpacity !== undefined && theme?.background) {
    theme = {
      ...theme,
      background: hexToRgba(theme.background, settings.terminalBackgroundOpacity)
    }
  }

  // Why: Ghostty's cursor-opacity applies alpha to the cursor color. We only
  // convert when the resolved cursor is a hex value; named CSS colors are
  // left untouched because hexToRgba expects a hex input.
  if (settings.terminalCursorOpacity !== undefined && theme?.cursor && isHexColor(theme.cursor)) {
    theme = { ...theme, cursor: hexToRgba(theme.cursor, settings.terminalCursorOpacity) }
  }

  return { theme, allowTransparency: opacityActive }
}

/** Why 200: the rough byte-per-row factor xterm uses to budget scrollback
 *  rows from a byte ceiling. Floor of 1000 keeps short shells useful;
 *  ceiling of 50_000 caps memory growth on very large `terminalScrollbackBytes`. */
function clampScrollbackRowsFromBytes(bytes: number | undefined): number {
  return Math.min(50_000, Math.max(1000, Math.round((bytes ?? 10_000_000) / 200)))
}

/** Build the full xterm option bundle for a fresh `new Terminal(...)` call.
 *  Both the regular pane (via `terminalOptions()` in PaneManager) and the
 *  sidebar PTY use this so styling cannot drift between them. */
export function buildTerminalOptionsFromSettings(
  settings: GlobalSettings,
  deps: TerminalOptionDeps
): ITerminalOptions {
  const fontWeights = resolveTerminalFontWeights(settings.terminalFontWeight)
  const { theme, allowTransparency } = resolveTerminalThemeFromSettings(
    settings,
    deps.systemPrefersDark
  )
  return {
    ...buildDefaultTerminalOptions(),
    fontSize: deps.paneSize ?? settings.terminalFontSize,
    fontFamily: buildFontFamily(settings.terminalFontFamily ?? ''),
    fontWeight: fontWeights.fontWeight,
    fontWeightBold: fontWeights.fontWeightBold,
    scrollback: clampScrollbackRowsFromBytes(settings.terminalScrollbackBytes),
    cursorStyle: settings.terminalCursorStyle,
    cursorBlink: settings.terminalCursorBlink,
    macOptionIsMeta: deps.effectiveMacOptionAsAlt === 'true',
    lineHeight: settings.terminalLineHeight,
    wordSeparator: settings.terminalWordSeparator,
    // Why explicit even when null: a stale `theme` from defaults would mask
    // a settings-driven theme reset. Setting `theme: null` would also mask
    // built-in defaults — pass through the resolved value (or omit when
    // null) and let xterm hold its default palette.
    ...(theme ? { theme } : {}),
    allowTransparency
  }
}

/** Apply settings-derived options to a single live terminal. Used for
 *  settings/theme reactions on both the regular per-pane terminals and the
 *  single sidebar PTY terminal. The per-pane manager's
 *  `applyTerminalAppearance` is a wrapper that loops over panes and calls
 *  this helper for each one. */
export function applyTerminalOptionsToTerminal(
  terminal: Terminal,
  settings: GlobalSettings,
  deps: TerminalOptionDeps
): void {
  const fontWeights = resolveTerminalFontWeights(settings.terminalFontWeight)
  const { theme, allowTransparency } = resolveTerminalThemeFromSettings(
    settings,
    deps.systemPrefersDark
  )
  if (theme) {
    terminal.options.theme = theme
  }
  // Why: xterm's allowTransparency has measurable rendering cost, so clear
  // it explicitly when opacity is at (or above) 1 to avoid a stale `true`
  // bleeding in from a prior opacity setting that has since been reset.
  terminal.options.allowTransparency = allowTransparency
  terminal.options.cursorStyle = settings.terminalCursorStyle
  terminal.options.cursorBlink = settings.terminalCursorBlink
  terminal.options.fontSize = deps.paneSize ?? settings.terminalFontSize
  terminal.options.fontFamily = buildFontFamily(settings.terminalFontFamily ?? '')
  terminal.options.fontWeight = fontWeights.fontWeight
  terminal.options.fontWeightBold = fontWeights.fontWeightBold
  // Why: xterm's macOptionIsMeta only flips on the 'true' mode. 'left' and
  // 'right' are handled in the keydown policy (terminal-shortcut-policy).
  terminal.options.macOptionIsMeta = deps.effectiveMacOptionAsAlt === 'true'
  terminal.options.lineHeight = settings.terminalLineHeight
}
