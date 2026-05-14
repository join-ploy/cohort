import { renderToStaticMarkup } from 'react-dom/server'
import type * as ReactNS from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: vitest runs in `node` (no jsdom), so we cannot actually mount xterm.
// We mock xterm + the addon and the pty-dispatcher subscriptions so we can
// assert the wiring (subscribe on mount, write data through, unsubscribe on
// cleanup, re-subscribe on ptyId change) by invoking the effect callback
// recorded via a mocked React.useEffect.

// Per-test mutable state for the mocks. Re-built in beforeEach so cases
// don't bleed into one another.
type MockTerm = {
  loadAddon: ReturnType<typeof vi.fn>
  open: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  onData: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  cols: number
  rows: number
}

type MockFit = {
  fit: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}

const createdTerms: MockTerm[] = []
const createdFits: MockFit[] = []
const inputDisposers: ReturnType<typeof vi.fn>[] = []
const dataSubs: { ptyId: string; cb: (d: string) => void; off: ReturnType<typeof vi.fn> }[] = []
const exitSubs: { ptyId: string; cb: (c: number) => void; off: ReturnType<typeof vi.fn> }[] = []

vi.mock('@xterm/xterm', () => {
  // Why: vi.fn().mockImplementation does not produce a callable constructor in
  // node — `new MockFn()` throws "is not a constructor". A real class works.
  class Terminal {
    loadAddon = vi.fn()
    open = vi.fn()
    write = vi.fn()
    onData: ReturnType<typeof vi.fn>
    dispose = vi.fn()
    cols = 100
    rows = 30
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

vi.mock('@/lib/pane-manager/pane-terminal-options', () => ({
  buildDefaultTerminalOptions: () => ({})
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

// Why: capture the effect body so the test can run it explicitly with a
// non-null containerRef. React's static renderer otherwise skips effects.
type EffectRecord = { run: () => void; cleanup: (() => void) | void }
let recordedEffect: EffectRecord | null = null

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof ReactNS>('react')
  return {
    ...actual,
    useRef: <T,>(_initial: T) => ({ current: { tagName: 'DIV' } as unknown as T }),
    useEffect: (fn: () => void | (() => void)) => {
      recordedEffect = {
        run: () => {
          const cleanup = fn()
          recordedEffect = { run: recordedEffect!.run, cleanup }
        },
        cleanup: undefined
      }
    }
  }
})

const ptyResize = vi.fn()
const ptyWrite = vi.fn()

beforeEach(() => {
  createdTerms.length = 0
  createdFits.length = 0
  inputDisposers.length = 0
  dataSubs.length = 0
  exitSubs.length = 0
  ptyResize.mockClear()
  ptyWrite.mockClear()
  recordedEffect = null

  // Why: window.api is the preload bridge. Stub the two methods the
  // component calls directly (resize after fit, write on user keystrokes).
  ;(globalThis as unknown as { window: { api: unknown } }).window = {
    api: {
      pty: {
        resize: ptyResize,
        write: ptyWrite
      }
    }
  }

  // Why: ResizeObserver / requestAnimationFrame are DOM APIs missing in node.
  // Provide noop / immediate shims so the component's deferred fit branch can
  // execute without throwing.
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

afterEach(() => {
  recordedEffect = null
})

describe('SidebarPtyTerminal', () => {
  it('subscribes to pty data + exit on mount with the given ptyId', async () => {
    const { default: SidebarPtyTerminal } = await import('./SidebarPtyTerminal')
    renderToStaticMarkup(<SidebarPtyTerminal ptyId="pty-A" />)
    expect(recordedEffect).not.toBeNull()
    recordedEffect!.run()

    expect(createdTerms).toHaveLength(1)
    expect(createdFits).toHaveLength(1)
    expect(dataSubs).toHaveLength(1)
    expect(dataSubs[0].ptyId).toBe('pty-A')
    expect(exitSubs).toHaveLength(1)
    expect(exitSubs[0].ptyId).toBe('pty-A')
    expect(createdTerms[0].loadAddon).toHaveBeenCalledWith(createdFits[0])
  })

  it('forwards pty data to terminal.write and unsubscribes on cleanup', async () => {
    const { default: SidebarPtyTerminal } = await import('./SidebarPtyTerminal')
    renderToStaticMarkup(<SidebarPtyTerminal ptyId="pty-1" />)
    recordedEffect!.run()

    // Push a data chunk through the recorded callback and confirm it lands on
    // the (mocked) terminal.
    dataSubs[0].cb('hello\r\n')
    expect(createdTerms[0].write).toHaveBeenCalledWith('hello\r\n')

    // Cleanup: every subscription + addon must be released.
    recordedEffect!.cleanup?.()
    expect(dataSubs[0].off).toHaveBeenCalledOnce()
    expect(exitSubs[0].off).toHaveBeenCalledOnce()
    expect(inputDisposers[0]).toHaveBeenCalledOnce()
    expect(createdFits[0].dispose).toHaveBeenCalledOnce()
    expect(createdTerms[0].dispose).toHaveBeenCalledOnce()
  })

  it('forwards user keystrokes through window.api.pty.write', async () => {
    const { default: SidebarPtyTerminal } = await import('./SidebarPtyTerminal')
    renderToStaticMarkup(<SidebarPtyTerminal ptyId="pty-2" />)
    recordedEffect!.run()

    // term.onData is the input subscription. Replay the registered callback
    // to simulate the user typing Ctrl+C (\x03).
    const onDataCalls = createdTerms[0].onData.mock.calls
    expect(onDataCalls).toHaveLength(1)
    const inputCb = onDataCalls[0][0] as (d: string) => void
    inputCb('\x03')
    expect(ptyWrite).toHaveBeenCalledWith('pty-2', '\x03')
  })

  it('re-subscribes with the new ptyId when remounted with a different id', async () => {
    const { default: SidebarPtyTerminal } = await import('./SidebarPtyTerminal')

    renderToStaticMarkup(<SidebarPtyTerminal ptyId="pty-old" />)
    recordedEffect!.run()
    expect(dataSubs).toHaveLength(1)
    expect(dataSubs[0].ptyId).toBe('pty-old')

    // Tear down the first subscription as React would on a key/dep change.
    recordedEffect!.cleanup?.()
    expect(dataSubs[0].off).toHaveBeenCalledOnce()

    // Re-mount with a new id; the new effect must subscribe to the new id.
    renderToStaticMarkup(<SidebarPtyTerminal ptyId="pty-new" />)
    recordedEffect!.run()
    expect(dataSubs).toHaveLength(2)
    expect(dataSubs[1].ptyId).toBe('pty-new')
    expect(createdTerms).toHaveLength(2)
  })
})
