/* eslint-disable max-lines -- Why: xterm + pty-dispatcher mocks plus the
   full attach/detach/dispose/notify lifecycle assertions land just over
   the default 300-line threshold. Splitting would scatter the shared
   mock state across files. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttachOptions } from './sidebar-pty-terminal-cache'

// Why: vitest runs in `node` (no jsdom + no real xterm). Mock xterm and
// the pty-dispatcher, then drive the cache through its public lifecycle
// to assert the invariants that protect the right-sidebar Run/Setup
// terminals from losing scrollback when React unmounts them.

type MockTerm = {
  loadAddon: ReturnType<typeof vi.fn>
  open: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  onData: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  cols: number
  rows: number
  options: Record<string, unknown>
}
type MockFit = { fit: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }

const createdTerms: MockTerm[] = []
const createdFits: MockFit[] = []
const inputDisposers: ReturnType<typeof vi.fn>[] = []
const dataSubs: { ptyId: string; cb: (d: string) => void; off: ReturnType<typeof vi.fn> }[] = []
const exitSubs: { ptyId: string; cb: (c: number) => void; off: ReturnType<typeof vi.fn> }[] = []

vi.mock('@xterm/xterm', () => {
  class Terminal {
    loadAddon = vi.fn()
    open = vi.fn()
    write = vi.fn()
    onData: ReturnType<typeof vi.fn>
    dispose = vi.fn()
    cols = 100
    rows = 30
    options: Record<string, unknown> = {}
    constructor() {
      const onInputDispose = vi.fn()
      inputDisposers.push(onInputDispose)
      this.onData = vi.fn().mockReturnValue({ dispose: onInputDispose })
      createdTerms.push(this as unknown as MockTerm)
    }
  }
  return { Terminal }
})

vi.mock('@xterm/addon-fit', () => {
  class FitAddon {
    fit = vi.fn()
    dispose = vi.fn()
    constructor() {
      createdFits.push(this as unknown as MockFit)
    }
  }
  return { FitAddon }
})

const buildOptionsCalls: { settings: unknown; deps: unknown }[] = []
const applyOptionsCalls: { terminal: unknown; settings: unknown; deps: unknown }[] = []
const resolveThemeCalls: { settings: unknown; systemPrefersDark: unknown }[] = []
let nextResolvedBackground: string | undefined = '#101820'
vi.mock('@/lib/pane-manager/build-terminal-options', () => ({
  buildTerminalOptionsFromSettings: (settings: unknown, deps: unknown) => {
    buildOptionsCalls.push({ settings, deps })
    return { fontSize: 14 }
  },
  applyTerminalOptionsToTerminal: (terminal: unknown, settings: unknown, deps: unknown) => {
    applyOptionsCalls.push({ terminal, settings, deps })
  },
  resolveTerminalThemeFromSettings: (settings: unknown, systemPrefersDark: unknown) => {
    resolveThemeCalls.push({ settings, systemPrefersDark })
    return {
      theme: nextResolvedBackground ? { background: nextResolvedBackground } : null,
      allowTransparency: false
    }
  }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  subscribeToPtyData: (ptyId: string, cb: (d: string) => void) => {
    const off = vi.fn()
    dataSubs.push({ ptyId, cb, off })
    return off
  },
  subscribeToPtyExit: (ptyId: string, cb: (c: number) => void) => {
    const off = vi.fn()
    exitSubs.push({ ptyId, cb, off })
    return off
  }
}))

const ptyResize = vi.fn()
const ptyWrite = vi.fn()

beforeEach(() => {
  for (const arr of [createdTerms, createdFits, inputDisposers, dataSubs, exitSubs]) {
    arr.length = 0
  }
  for (const arr of [buildOptionsCalls, applyOptionsCalls, resolveThemeCalls]) {
    arr.length = 0
  }
  nextResolvedBackground = '#101820'
  ptyResize.mockClear()
  ptyWrite.mockClear()
  ;(globalThis as unknown as { window: { api: unknown } }).window = {
    api: { pty: { resize: ptyResize, write: ptyWrite } }
  }
  // Why: cache.buildContainer() calls document.createElement to mint
  // the persistent xterm host div. Stub a minimal document with the
  // appendChild/removeChild/contains/parentNode surface the cache uses.
  ;(globalThis as unknown as { document: unknown }).document = {
    createElement: (_tag: string) => {
      const children: unknown[] = []
      const node: Record<string, unknown> = {
        style: {},
        children,
        parentNode: null,
        appendChild(child: unknown) {
          children.push(child)
          ;(child as { parentNode: unknown }).parentNode = node
          return child
        },
        removeChild(child: unknown) {
          const i = children.indexOf(child)
          if (i !== -1) {
            children.splice(i, 1)
          }
          ;(child as { parentNode: unknown }).parentNode = null
          return child
        },
        contains(child: unknown) {
          return children.includes(child)
        }
      }
      return node
    }
  }
  // Why: ResizeObserver / requestAnimationFrame are missing in node.
  // Provide minimal shims so the deferred-fit branch executes.
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  }
  let nextRafId = 1
  const rafCallbacks = new Map<number, FrameRequestCallback>()
  ;(
    globalThis as unknown as { requestAnimationFrame: typeof requestAnimationFrame }
  ).requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = nextRafId++
    rafCallbacks.set(id, cb)
    queueMicrotask(() => {
      const fn = rafCallbacks.get(id)
      if (fn) {
        rafCallbacks.delete(id)
        fn(performance.now())
      }
    })
    return id
  }) as typeof requestAnimationFrame
  ;(
    globalThis as unknown as { cancelAnimationFrame: typeof cancelAnimationFrame }
  ).cancelAnimationFrame = ((id: number) => {
    rafCallbacks.delete(id)
  }) as typeof cancelAnimationFrame
})

afterEach(async () => {
  // Why: cache is module-scoped — clear between tests so a stale entry
  // from one case can't leak through to the next.
  const mod = await import('./sidebar-pty-terminal-cache')
  mod._testing.clear()
})

function makeHost(): HTMLElement {
  const children: HTMLElement[] = []
  const host = {
    children,
    appendChild(child: HTMLElement): HTMLElement {
      children.push(child)
      ;(child as unknown as { parentNode: unknown }).parentNode = host
      return child
    },
    removeChild(child: HTMLElement): HTMLElement {
      const i = children.indexOf(child)
      if (i !== -1) {
        children.splice(i, 1)
      }
      ;(child as unknown as { parentNode: unknown }).parentNode = null
      return child
    },
    contains(child: HTMLElement): boolean {
      return children.includes(child)
    }
  } as unknown as HTMLElement
  return host
}

const fakeSettings = {
  theme: 'system',
  terminalFontSize: 14,
  terminalFontFamily: 'JetBrainsMono Nerd Font'
}

function attachOpts(systemPrefersDark = true): AttachOptions {
  // Why: cache only forwards `settings` to the (mocked) builder, so a
  // structural stand-in is enough — the cast keeps the signature happy
  // without dragging the full GlobalSettings shape into the test.
  return {
    settings: fakeSettings as unknown as AttachOptions['settings'],
    systemPrefersDark,
    effectiveMacOptionAsAlt: 'true'
  }
}

describe('sidebar-pty-terminal-cache — first attach', () => {
  it('creates one Terminal + FitAddon and appends a persistent container', async () => {
    const { attachCachedTerminal } = await import('./sidebar-pty-terminal-cache')
    const host = makeHost()
    const entry = attachCachedTerminal('pty-A', host, attachOpts())
    expect(createdTerms).toHaveLength(1)
    expect(createdFits).toHaveLength(1)
    expect(entry.ptyId).toBe('pty-A')
    expect(entry.term).toBe(createdTerms[0])
    expect(entry.fit).toBe(createdFits[0])
    expect(host.contains(entry.container)).toBe(true)
    // Why: xterm renders into the inner padded wrapper so the gutter
    // and the canvas can share the resolved theme background. The outer
    // container is the stable handle moved between hosts.
    expect(createdTerms[0].open).toHaveBeenCalledWith(entry.inner)
    expect(createdTerms[0].loadAddon).toHaveBeenCalledWith(createdFits[0])
  })

  it('subscribes to pty data + exit, writes incoming data into the cached terminal', async () => {
    const { attachCachedTerminal } = await import('./sidebar-pty-terminal-cache')
    attachCachedTerminal('pty-A', makeHost(), attachOpts())
    expect(dataSubs).toHaveLength(1)
    expect(dataSubs[0].ptyId).toBe('pty-A')
    expect(exitSubs).toHaveLength(1)
    expect(exitSubs[0].ptyId).toBe('pty-A')
    dataSubs[0].cb('hello\r\n')
    expect(createdTerms[0].write).toHaveBeenCalledWith('hello\r\n')
  })

  it('forwards user keystrokes through window.api.pty.write', async () => {
    const { attachCachedTerminal } = await import('./sidebar-pty-terminal-cache')
    attachCachedTerminal('pty-A', makeHost(), attachOpts())
    const onDataCalls = createdTerms[0].onData.mock.calls
    expect(onDataCalls).toHaveLength(1)
    ;(onDataCalls[0][0] as (d: string) => void)('\x03')
    expect(ptyWrite).toHaveBeenCalledWith('pty-A', '\x03')
  })

  it('builds initial xterm options from the supplied settings + theme deps', async () => {
    const { attachCachedTerminal } = await import('./sidebar-pty-terminal-cache')
    attachCachedTerminal('pty-A', makeHost(), attachOpts())
    expect(buildOptionsCalls).toHaveLength(1)
    expect(buildOptionsCalls[0].settings).toBe(fakeSettings)
    expect(buildOptionsCalls[0].deps).toMatchObject({
      effectiveMacOptionAsAlt: 'true',
      systemPrefersDark: true
    })
  })
})

describe('sidebar-pty-terminal-cache — re-attach after detach', () => {
  it('reuses the cached Terminal and moves the container to the new host', async () => {
    const m = await import('./sidebar-pty-terminal-cache')
    const hostA = makeHost()
    const first = m.attachCachedTerminal('pty-A', hostA, attachOpts())
    const containerRef = first.container
    m.detachCachedTerminal('pty-A', hostA)
    expect(hostA.contains(containerRef)).toBe(false)
    // Subscriptions stay alive while detached so PTY data keeps writing
    // into the offscreen Terminal's scrollback buffer.
    expect(dataSubs[0].off).not.toHaveBeenCalled()
    expect(exitSubs[0].off).not.toHaveBeenCalled()
    const hostB = makeHost()
    const second = m.attachCachedTerminal('pty-A', hostB, attachOpts())
    expect(second).toBe(first)
    expect(createdTerms).toHaveLength(1)
    expect(hostB.contains(containerRef)).toBe(true)
  })

  it('keeps subscriptions delivering data to the cached terminal across a detach', async () => {
    const m = await import('./sidebar-pty-terminal-cache')
    const hostA = makeHost()
    m.attachCachedTerminal('pty-A', hostA, attachOpts())
    m.detachCachedTerminal('pty-A', hostA)
    // Output that arrives while the panel is offscreen must still land
    // in the cached Terminal's buffer — that's the whole point.
    dataSubs[0].cb('arrived offscreen\n')
    expect(createdTerms[0].write).toHaveBeenCalledWith('arrived offscreen\n')
  })
})

describe('sidebar-pty-terminal-cache — disposal', () => {
  it('disposes Terminal + addon + subscriptions and removes the cache entry', async () => {
    const m = await import('./sidebar-pty-terminal-cache')
    m.attachCachedTerminal('pty-A', makeHost(), attachOpts())
    expect(m._testing.cache.has('pty-A')).toBe(true)
    m.disposeCachedTerminal('pty-A')
    expect(m._testing.cache.has('pty-A')).toBe(false)
    expect(createdTerms[0].dispose).toHaveBeenCalledOnce()
    expect(createdFits[0].dispose).toHaveBeenCalledOnce()
    expect(dataSubs[0].off).toHaveBeenCalledOnce()
    expect(exitSubs[0].off).toHaveBeenCalledOnce()
    expect(inputDisposers[0]).toHaveBeenCalledOnce()
  })

  it('disposeCachedTerminal is a no-op for an unknown ptyId', async () => {
    const m = await import('./sidebar-pty-terminal-cache')
    expect(() => m.disposeCachedTerminal('pty-unknown')).not.toThrow()
  })

  it('removes the cached container from its current host on dispose', async () => {
    const m = await import('./sidebar-pty-terminal-cache')
    const host = makeHost()
    const entry = m.attachCachedTerminal('pty-A', host, attachOpts())
    m.disposeCachedTerminal('pty-A')
    expect(host.contains(entry.container)).toBe(false)
  })
})

describe('sidebar-pty-terminal-cache — keyed by ptyId', () => {
  it('different ptyIds get independent Terminal instances', async () => {
    const m = await import('./sidebar-pty-terminal-cache')
    const a = m.attachCachedTerminal('pty-A', makeHost(), attachOpts())
    const b = m.attachCachedTerminal('pty-B', makeHost(), attachOpts())
    expect(a.term).not.toBe(b.term)
    expect(createdTerms).toHaveLength(2)
    expect(dataSubs).toHaveLength(2)
    expect(dataSubs.map((s) => s.ptyId).sort()).toEqual(['pty-A', 'pty-B'])
  })
})

describe('sidebar-pty-terminal-cache — settings + theme reactivity', () => {
  it('notifyAppearance reapplies options to the cached terminal without recreating it', async () => {
    const m = await import('./sidebar-pty-terminal-cache')
    m.attachCachedTerminal('pty-A', makeHost(), attachOpts())
    // Mid-session theme/font swap: a single notify call must reach the
    // existing terminal via applyTerminalOptionsToTerminal.
    m.notifyCachedTerminalAppearance('pty-A', { ...attachOpts(), systemPrefersDark: false })
    expect(applyOptionsCalls).toHaveLength(1)
    expect(applyOptionsCalls[0].terminal).toBe(createdTerms[0])
    expect(applyOptionsCalls[0].deps).toMatchObject({
      systemPrefersDark: false,
      effectiveMacOptionAsAlt: 'true'
    })
    // The terminal must NOT have been recreated — that would lose scrollback.
    expect(createdTerms).toHaveLength(1)
  })

  it('notifyAppearance is a no-op for an unknown ptyId', async () => {
    const m = await import('./sidebar-pty-terminal-cache')
    expect(() => m.notifyCachedTerminalAppearance('pty-missing', attachOpts())).not.toThrow()
    expect(applyOptionsCalls).toHaveLength(0)
  })
})

describe('sidebar-pty-terminal-cache — gutter background syncing', () => {
  it('paints both container and inner with the resolved theme background on first attach', async () => {
    const { attachCachedTerminal } = await import('./sidebar-pty-terminal-cache')
    nextResolvedBackground = '#101820'
    const entry = attachCachedTerminal('pty-A', makeHost(), attachOpts())
    // Why: the gutter (outer) and the xterm-host (inner) must share the
    // terminal theme's background so the padding is invisible — anything
    // else makes the terminal look framed.
    expect(
      (entry.container as unknown as { style: { backgroundColor: string } }).style.backgroundColor
    ).toBe('#101820')
    expect(
      (entry.inner as unknown as { style: { backgroundColor: string } }).style.backgroundColor
    ).toBe('#101820')
  })

  it('applies the gutter padding to the inner wrapper, not the outer container', async () => {
    const { attachCachedTerminal } = await import('./sidebar-pty-terminal-cache')
    const entry = attachCachedTerminal('pty-A', makeHost(), attachOpts())
    // Why: padding lives on the inner div so xterm's measurement sees a
    // smaller box and fits its grid inside the visible canvas area.
    expect((entry.inner as unknown as { style: { padding: string } }).style.padding).toBe(
      '8px 8px 0 8px'
    )
    expect(
      (entry.container as unknown as { style: { padding?: string } }).style.padding
    ).toBeUndefined()
  })

  it('notifyAppearance re-paints the gutter when the theme background changes', async () => {
    const m = await import('./sidebar-pty-terminal-cache')
    nextResolvedBackground = '#101820'
    const entry = m.attachCachedTerminal('pty-A', makeHost(), attachOpts())
    // Theme swap: subsequent resolve returns a different background.
    nextResolvedBackground = '#fafafa'
    m.notifyCachedTerminalAppearance('pty-A', { ...attachOpts(), systemPrefersDark: false })
    expect(
      (entry.container as unknown as { style: { backgroundColor: string } }).style.backgroundColor
    ).toBe('#fafafa')
    expect(
      (entry.inner as unknown as { style: { backgroundColor: string } }).style.backgroundColor
    ).toBe('#fafafa')
  })

  it('leaves the gutter background unset when settings have not hydrated yet', async () => {
    const m = await import('./sidebar-pty-terminal-cache')
    // Why: pre-hydration the resolver isn't trustworthy — let the panel
    // chrome show through until settings arrive, then notifyAppearance
    // paints the gutter once everything is real.
    const entry = m.attachCachedTerminal('pty-A', makeHost(), {
      settings: null,
      systemPrefersDark: true,
      effectiveMacOptionAsAlt: 'true'
    })
    expect(
      (entry.container as unknown as { style: { backgroundColor?: string } }).style.backgroundColor
    ).toBeUndefined()
    expect(
      (entry.inner as unknown as { style: { backgroundColor?: string } }).style.backgroundColor
    ).toBeUndefined()
    expect(resolveThemeCalls).toHaveLength(0)
  })

  it('skips repainting when the resolved theme has no background', async () => {
    const m = await import('./sidebar-pty-terminal-cache')
    nextResolvedBackground = '#101820'
    const entry = m.attachCachedTerminal('pty-A', makeHost(), attachOpts())
    // Resolver returns no theme — keep the prior color rather than wiping
    // it to an empty string and exposing a transparent gutter.
    nextResolvedBackground = undefined
    m.notifyCachedTerminalAppearance('pty-A', attachOpts())
    expect(
      (entry.container as unknown as { style: { backgroundColor: string } }).style.backgroundColor
    ).toBe('#101820')
    expect(
      (entry.inner as unknown as { style: { backgroundColor: string } }).style.backgroundColor
    ).toBe('#101820')
  })
})
