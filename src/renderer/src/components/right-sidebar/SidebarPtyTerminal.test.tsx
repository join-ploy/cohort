import { renderToStaticMarkup } from 'react-dom/server'
import type * as ReactNS from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: vitest runs in `node` (no jsdom), so we cannot actually mount the
// real cache here either — instead we mock the cache module and assert
// the component is now a pure attach/detach surface: it calls
// attachCachedTerminal on mount, detachCachedTerminal on cleanup, and
// notifyCachedTerminalAppearance on settings/theme change. The cache
// itself is covered by sidebar-pty-terminal-cache.test.ts.

const attachCalls: { ptyId: string; host: unknown; opts: unknown }[] = []
const detachCalls: { ptyId: string; host: unknown }[] = []
const notifyCalls: { ptyId: string; opts: unknown }[] = []
const disposeCalls: string[] = []

vi.mock('./sidebar-pty-terminal-cache', () => ({
  attachCachedTerminal: (ptyId: string, host: unknown, opts: unknown) => {
    attachCalls.push({ ptyId, host, opts })
    return { ptyId, container: {}, term: {}, fit: {} }
  },
  detachCachedTerminal: (ptyId: string, host: unknown) => {
    detachCalls.push({ ptyId, host })
  },
  notifyCachedTerminalAppearance: (ptyId: string, opts: unknown) => {
    notifyCalls.push({ ptyId, opts })
  },
  // Why: spy on dispose so the "component never disposes" test can
  // verify mount → unmount keeps the cached terminal alive.
  disposeCachedTerminal: (ptyId: string) => {
    disposeCalls.push(ptyId)
  }
}))

const fakeSettings = {
  theme: 'system',
  terminalFontSize: 14,
  terminalFontFamily: 'JetBrainsMono Nerd Font'
}
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({ settings: fakeSettings })
}))
vi.mock('@/components/terminal-pane/use-system-prefers-dark', () => ({
  useSystemPrefersDark: () => true
}))
vi.mock('@/lib/keyboard-layout/use-effective-mac-option-as-alt', () => ({
  useEffectiveMacOptionAsAlt: () => 'true'
}))

// Why: capture the effect bodies so tests can run them explicitly with a
// non-null containerRef. React's static renderer otherwise skips effects.
type EffectRecord = { fn: () => void | (() => void); cleanup: (() => void) | void }
const recordedEffects: EffectRecord[] = []
function runEffect(idx: number): void {
  const eff = recordedEffects[idx]
  if (!eff) {
    throw new Error(`no effect recorded at index ${idx}`)
  }
  const cleanup = eff.fn()
  eff.cleanup = typeof cleanup === 'function' ? cleanup : undefined
}
function cleanupEffect(idx: number): void {
  const eff = recordedEffects[idx]
  if (eff?.cleanup) {
    eff.cleanup()
  }
}

const fakeHost = { tagName: 'DIV', _id: 'host' } as unknown as HTMLDivElement
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof ReactNS>('react')
  return {
    ...actual,
    useRef: <T,>(_initial: T) => ({ current: fakeHost as unknown as T }),
    useEffect: (fn: () => void | (() => void)) => {
      recordedEffects.push({ fn, cleanup: undefined })
    }
  }
})

beforeEach(() => {
  attachCalls.length = 0
  detachCalls.length = 0
  notifyCalls.length = 0
  disposeCalls.length = 0
  recordedEffects.length = 0
})

afterEach(() => {
  recordedEffects.length = 0
})

describe('SidebarPtyTerminal', () => {
  it('calls attachCachedTerminal on mount with the host ref and current settings', async () => {
    const { default: SidebarPtyTerminal } = await import('./SidebarPtyTerminal')
    renderToStaticMarkup(<SidebarPtyTerminal ptyId="pty-A" />)
    runEffect(0)

    expect(attachCalls).toHaveLength(1)
    expect(attachCalls[0].ptyId).toBe('pty-A')
    expect(attachCalls[0].host).toBe(fakeHost)
    expect(attachCalls[0].opts).toMatchObject({
      settings: fakeSettings,
      systemPrefersDark: true,
      effectiveMacOptionAsAlt: 'true'
    })
  })

  it('calls detachCachedTerminal on cleanup with the same ptyId + host', async () => {
    const { default: SidebarPtyTerminal } = await import('./SidebarPtyTerminal')
    renderToStaticMarkup(<SidebarPtyTerminal ptyId="pty-1" />)
    runEffect(0)
    cleanupEffect(0)

    expect(detachCalls).toHaveLength(1)
    expect(detachCalls[0].ptyId).toBe('pty-1')
    expect(detachCalls[0].host).toBe(fakeHost)
  })

  it('does not dispose the Terminal on cleanup — the cache survives unmount', async () => {
    // Disposal is the cache's call, never the component's. The whole
    // point of the cache is that React unmount must NOT kill scrollback.
    const { default: SidebarPtyTerminal } = await import('./SidebarPtyTerminal')
    renderToStaticMarkup(<SidebarPtyTerminal ptyId="pty-1" />)
    runEffect(0)
    cleanupEffect(0)
    expect(disposeCalls).toHaveLength(0)
  })

  it('attaches with the new ptyId when remounted with a different id', async () => {
    const { default: SidebarPtyTerminal } = await import('./SidebarPtyTerminal')
    renderToStaticMarkup(<SidebarPtyTerminal ptyId="pty-old" />)
    runEffect(0)
    expect(attachCalls).toHaveLength(1)
    expect(attachCalls[0].ptyId).toBe('pty-old')
    cleanupEffect(0)
    expect(detachCalls[0].ptyId).toBe('pty-old')

    recordedEffects.length = 0
    renderToStaticMarkup(<SidebarPtyTerminal ptyId="pty-new" />)
    runEffect(0)
    expect(attachCalls).toHaveLength(2)
    expect(attachCalls[1].ptyId).toBe('pty-new')
  })

  it('reapplies settings + theme via notifyCachedTerminalAppearance when reactive effect runs', async () => {
    // Settings + theme can change mid-session. The reactive effect must
    // call the cache's notify helper so the live PTY view picks up the
    // change without recreating the terminal.
    const { default: SidebarPtyTerminal } = await import('./SidebarPtyTerminal')
    renderToStaticMarkup(<SidebarPtyTerminal ptyId="pty-react" />)
    runEffect(0)
    runEffect(1)

    expect(notifyCalls).toHaveLength(1)
    expect(notifyCalls[0].ptyId).toBe('pty-react')
    expect(notifyCalls[0].opts).toMatchObject({
      settings: fakeSettings,
      systemPrefersDark: true,
      effectiveMacOptionAsAlt: 'true'
    })
  })
})
