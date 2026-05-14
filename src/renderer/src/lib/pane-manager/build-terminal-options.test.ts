import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import {
  applyTerminalOptionsToTerminal,
  buildTerminalOptionsFromSettings
} from './build-terminal-options'

// Why: a minimal settings stub keyed only on the fields the builder reads.
// The builder owns the merge with `buildDefaultTerminalOptions()`, so a
// partial GlobalSettings cast is safe — anything outside terminal styling is
// untouched by the helper. Cast through `unknown` so TS does not need the
// full GlobalSettings shape (which has 80+ unrelated fields).
function settingsFixture(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  const base = {
    theme: 'dark',
    terminalFontSize: 14,
    terminalFontFamily: 'JetBrainsMono Nerd Font',
    terminalFontWeight: 400,
    terminalLineHeight: 1.2,
    terminalCursorStyle: 'block',
    terminalCursorBlink: false,
    terminalWordSeparator: ' ./()',
    terminalScrollbackBytes: 5_000_000,
    terminalGpuAcceleration: 'auto',
    terminalLigatures: 'auto',
    terminalThemeDark: 'Ghostty Default Style Dark',
    terminalDividerColorDark: '#3f3f46',
    terminalUseSeparateLightTheme: true,
    terminalThemeLight: 'Builtin Tango Light',
    terminalDividerColorLight: '#d4d4d8',
    terminalInactivePaneOpacity: 0.8,
    terminalActivePaneOpacity: 1,
    terminalPaneOpacityTransitionMs: 140,
    terminalDividerThicknessPx: 3,
    terminalFocusFollowsMouse: false
  }
  return { ...base, ...overrides } as unknown as GlobalSettings
}

describe('buildTerminalOptionsFromSettings', () => {
  it('returns the full xterm option bundle merged on top of defaults', () => {
    const opts = buildTerminalOptionsFromSettings(settingsFixture(), {
      effectiveMacOptionAsAlt: 'true',
      systemPrefersDark: true
    })
    // Defaults preserved (the kitty-keyboard handshake lives in defaults).
    expect(opts.vtExtensions?.kittyKeyboard).toBe(true)
    // Settings applied on top.
    expect(opts.fontSize).toBe(14)
    expect(opts.cursorStyle).toBe('block')
    expect(opts.cursorBlink).toBe(false)
    expect(opts.lineHeight).toBe(1.2)
    expect(opts.wordSeparator).toBe(' ./()')
    expect(opts.macOptionIsMeta).toBe(true)
    // FontFamily is built via `buildFontFamily` and includes the user's
    // primary face plus the cross-platform fallback chain, so just check
    // both ends are present.
    expect(opts.fontFamily).toContain('"JetBrainsMono Nerd Font"')
    expect(opts.fontFamily).toContain('monospace')
  })

  it('honors the optional paneSize override (per-pane Cmd+= zoom)', () => {
    const opts = buildTerminalOptionsFromSettings(settingsFixture({ terminalFontSize: 12 }), {
      effectiveMacOptionAsAlt: 'false',
      systemPrefersDark: true,
      paneSize: 18
    })
    expect(opts.fontSize).toBe(18)
    expect(opts.macOptionIsMeta).toBe(false)
  })

  it('clamps scrollback bytes into the xterm row budget', () => {
    // 200_000_000 / 200 = 1_000_000 → clamped to 50_000 ceiling.
    const high = buildTerminalOptionsFromSettings(
      settingsFixture({ terminalScrollbackBytes: 200_000_000 }),
      { effectiveMacOptionAsAlt: 'false', systemPrefersDark: true }
    )
    expect(high.scrollback).toBe(50_000)

    // 10_000 / 200 = 50 → clamped up to 1000 floor.
    const low = buildTerminalOptionsFromSettings(
      settingsFixture({ terminalScrollbackBytes: 10_000 }),
      { effectiveMacOptionAsAlt: 'false', systemPrefersDark: true }
    )
    expect(low.scrollback).toBe(1000)
  })

  it('resolves the dark theme colors when system prefers dark and theme is system', () => {
    const opts = buildTerminalOptionsFromSettings(settingsFixture({ theme: 'system' }), {
      effectiveMacOptionAsAlt: 'false',
      systemPrefersDark: true
    })
    expect(opts.theme).toBeTruthy()
    // Sanity: dark backgrounds are dark — Ghostty Default Style Dark is
    // #1d1f21. Don't pin the exact value (themes evolve), just assert it is
    // not the light tango background `#ffffff`.
    expect(opts.theme?.background?.toLowerCase()).not.toBe('#ffffff')
  })

  it('resolves the light theme colors when system prefers light and a separate light theme is enabled', () => {
    const opts = buildTerminalOptionsFromSettings(
      settingsFixture({ theme: 'system', terminalUseSeparateLightTheme: true }),
      { effectiveMacOptionAsAlt: 'false', systemPrefersDark: false }
    )
    expect(opts.theme).toBeTruthy()
    // Builtin Tango Light has a white-ish background.
    expect(opts.theme?.background?.toLowerCase()).toBe('#ffffff')
  })

  it('merges terminalColorOverrides on top of the resolved theme', () => {
    const opts = buildTerminalOptionsFromSettings(
      settingsFixture({ terminalColorOverrides: { background: '#abcdef', foreground: '#123456' } }),
      { effectiveMacOptionAsAlt: 'false', systemPrefersDark: true }
    )
    expect(opts.theme?.background).toBe('#abcdef')
    expect(opts.theme?.foreground).toBe('#123456')
  })

  it('applies background opacity by converting to rgba and enabling allowTransparency', () => {
    const opts = buildTerminalOptionsFromSettings(
      settingsFixture({
        terminalColorOverrides: { background: '#1a1a1a' },
        terminalBackgroundOpacity: 0.5
      }),
      { effectiveMacOptionAsAlt: 'false', systemPrefersDark: true }
    )
    expect(opts.allowTransparency).toBe(true)
    expect(opts.theme?.background).toBe('rgba(26, 26, 26, 0.5)')
  })

  it('keeps allowTransparency false when no opacity override is set', () => {
    const opts = buildTerminalOptionsFromSettings(settingsFixture(), {
      effectiveMacOptionAsAlt: 'false',
      systemPrefersDark: true
    })
    expect(opts.allowTransparency).toBe(false)
  })

  it('applies cursor opacity to a hex cursor color', () => {
    const opts = buildTerminalOptionsFromSettings(
      settingsFixture({
        terminalColorOverrides: { cursor: '#ff8800' },
        terminalCursorOpacity: 0.25
      }),
      { effectiveMacOptionAsAlt: 'false', systemPrefersDark: true }
    )
    expect(opts.theme?.cursor).toBe('rgba(255, 136, 0, 0.25)')
  })

  it('resolves font weights via shared/terminal-fonts so bold is derived', () => {
    const opts = buildTerminalOptionsFromSettings(settingsFixture({ terminalFontWeight: 300 }), {
      effectiveMacOptionAsAlt: 'false',
      systemPrefersDark: true
    })
    expect(opts.fontWeight).toBe(300)
    // resolveTerminalFontWeights bumps bold to max(700, weight + 200) = 700.
    expect(opts.fontWeightBold).toBe(700)
  })
})

describe('applyTerminalOptionsToTerminal', () => {
  // Why: drive a minimal terminal stub instead of @xterm/headless — we only
  // need to assert that the helper writes through the right keys onto
  // `terminal.options`. A full headless terminal would also test xterm's
  // setter validation, which is xterm's job, not ours.
  type FakeTerm = {
    options: Record<string, unknown>
  }

  function fakeTerm(): FakeTerm {
    return { options: {} }
  }

  it('writes fontSize, fontFamily, weights, cursor, lineHeight, theme, and macOptionIsMeta', () => {
    const term = fakeTerm()
    applyTerminalOptionsToTerminal(
      term as unknown as Parameters<typeof applyTerminalOptionsToTerminal>[0],
      settingsFixture({ terminalFontSize: 16, terminalCursorStyle: 'underline' }),
      { effectiveMacOptionAsAlt: 'true', systemPrefersDark: true }
    )
    expect(term.options.fontSize).toBe(16)
    expect(term.options.cursorStyle).toBe('underline')
    expect(term.options.cursorBlink).toBe(false)
    expect(term.options.lineHeight).toBe(1.2)
    expect(term.options.macOptionIsMeta).toBe(true)
    expect(term.options.fontWeight).toBe(400)
    expect(term.options.fontFamily).toContain('"JetBrainsMono Nerd Font"')
    expect((term.options.theme as { background?: string } | undefined)?.background).toBeTruthy()
  })

  it('honors the paneSize override on re-apply (per-pane Cmd+= zoom)', () => {
    const term = fakeTerm()
    applyTerminalOptionsToTerminal(
      term as unknown as Parameters<typeof applyTerminalOptionsToTerminal>[0],
      settingsFixture({ terminalFontSize: 12 }),
      { effectiveMacOptionAsAlt: 'false', systemPrefersDark: true, paneSize: 22 }
    )
    expect(term.options.fontSize).toBe(22)
  })

  it('clears allowTransparency when opacity is full or unset', () => {
    const term = fakeTerm()
    // Pre-set to true to simulate a stale value from a prior opacity setting.
    term.options.allowTransparency = true
    applyTerminalOptionsToTerminal(
      term as unknown as Parameters<typeof applyTerminalOptionsToTerminal>[0],
      settingsFixture(),
      { effectiveMacOptionAsAlt: 'false', systemPrefersDark: true }
    )
    expect(term.options.allowTransparency).toBe(false)
  })
})
