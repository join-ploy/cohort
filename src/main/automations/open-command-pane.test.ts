import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { openCommandPane, OpenCommandPaneError } from './open-command-pane'

function fakeWebContents() {
  return {
    isDestroyed: vi.fn(() => false),
    send: vi.fn()
  }
}

function fakeIpc() {
  const ee = new EventEmitter()
  return {
    once: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ee.once(channel, (payload) => handler({}, payload))
    }),
    removeAllListeners: vi.fn((channel: string) => {
      ee.removeAllListeners(channel)
    }),
    emit: (channel: string, payload: unknown) => ee.emit(channel, payload),
    // Why: lets the leak-check test confirm the reply listener is gone after
    // a structured failure resolves the inner once handler.
    listenerCount: (channel: string) => ee.listenerCount(channel)
  }
}

describe('openCommandPane', () => {
  it('sends the request on automations:openCommandPane with a requestId-scoped reply channel', async () => {
    const webContents = fakeWebContents()
    const ipc = fakeIpc()
    const pending = openCommandPane(
      { worktreeId: 'wt-1', source: 'review', commandId: 'cmd-1' },
      { webContents: webContents as never, ipc: ipc as never, requestId: 'req-1' }
    )
    // Renderer responds
    ipc.emit('automations:openCommandPane:reply:req-1', {
      ok: true,
      ptyId: 'pty-9',
      paneKey: 'tab-9:1'
    })
    await expect(pending).resolves.toEqual({ ptyId: 'pty-9', paneKey: 'tab-9:1' })
    expect(webContents.send).toHaveBeenCalledWith('automations:openCommandPane', {
      requestId: 'req-1',
      worktreeId: 'wt-1',
      source: 'review',
      commandId: 'cmd-1'
    })
    expect(ipc.once).toHaveBeenCalledWith(
      'automations:openCommandPane:reply:req-1',
      expect.any(Function)
    )
  })

  it('rejects when the webContents has been destroyed', async () => {
    const webContents = fakeWebContents()
    webContents.isDestroyed.mockReturnValue(true)
    const ipc = fakeIpc()
    await expect(
      openCommandPane(
        { worktreeId: 'wt-1', source: 'custom', customCommand: 'gh pr create' },
        { webContents: webContents as never, ipc: ipc as never, requestId: 'req-2' }
      )
    ).rejects.toThrow(/no renderer/i)
    expect(webContents.send).not.toHaveBeenCalled()
  })

  it('rejects with a timeout error when the renderer does not respond within the configured window', async () => {
    vi.useFakeTimers()
    const webContents = fakeWebContents()
    const ipc = fakeIpc()
    const pending = openCommandPane(
      { worktreeId: 'wt-1', source: 'review', commandId: 'cmd-1' },
      { webContents: webContents as never, ipc: ipc as never, requestId: 'req-3', timeoutMs: 1000 }
    )
    // Why: prevent unhandled rejection while we advance the timer; the
    // assertion below still validates the rejection reason.
    pending.catch(() => {})
    vi.advanceTimersByTime(1500)
    await expect(pending).rejects.toThrow(/did not respond/i)
    expect(ipc.removeAllListeners).toHaveBeenCalledWith('automations:openCommandPane:reply:req-3')
    vi.useRealTimers()
  })

  it('rejects with OpenCommandPaneError when the renderer reports a structured failure', async () => {
    const webContents = fakeWebContents()
    const ipc = fakeIpc()
    const pending = openCommandPane(
      { worktreeId: 'wt-1', source: 'review', commandId: 'missing' },
      { webContents: webContents as never, ipc: ipc as never, requestId: 'req-4' }
    )
    ipc.emit('automations:openCommandPane:reply:req-4', {
      ok: false,
      error: 'Review command not configured.'
    })
    await expect(pending).rejects.toThrow(OpenCommandPaneError)
    await expect(pending).rejects.toThrow(/not configured/)
  })

  it('removes the reply listener after a structured failure (no leak)', async () => {
    const webContents = fakeWebContents()
    const ipc = fakeIpc()
    const channel = 'automations:openCommandPane:reply:req-5'
    const pending = openCommandPane(
      { worktreeId: 'wt-1', source: 'create-pr', commandId: 'cmd-1' },
      { webContents: webContents as never, ipc: ipc as never, requestId: 'req-5' }
    )
    // Why: listener attached after the once() call dispatched into the EE.
    expect(ipc.listenerCount(channel)).toBe(1)
    ipc.emit(channel, { ok: false, error: 'broken' })
    await expect(pending).rejects.toThrow(OpenCommandPaneError)
    // Why: EventEmitter.once auto-removes after firing, so a structured
    // failure must not leave a dangling listener for a late reply to land on.
    expect(ipc.listenerCount(channel)).toBe(0)
  })
})
