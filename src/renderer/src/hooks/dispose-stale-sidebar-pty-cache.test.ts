import { describe, expect, it, vi } from 'vitest'
import {
  disposePriorScriptCachedTerminal,
  disposeWorktreeCachedSidebarTerminals
} from './dispose-stale-sidebar-pty-cache'
import type { WorktreeScriptsEntry } from '@/store/slices/scripts'

// Why: the cache is the renderer's source of truth for sidebar Run/Setup
// xterm Terminals. The two disposal triggers (script restart, worktree
// delete) are the only paths that should evict cached entries. These
// helpers isolate that decision so useIpcEvents can stay thin and the
// branching is unit-testable without touching the heavy IPC stubs.

const idle = { ptyId: null, status: 'idle', exitCode: null, startedAt: null } as const

function entry(over: Partial<WorktreeScriptsEntry> = {}): WorktreeScriptsEntry {
  return { run: { ...idle }, setup: { ...idle }, ...over }
}

describe('disposePriorScriptCachedTerminal', () => {
  it('disposes the prior ptyId when a new run replaces it for the same worktree', () => {
    const dispose = vi.fn()
    disposePriorScriptCachedTerminal({
      kind: 'run',
      worktreeId: 'wt-1',
      newPtyId: 'pty-new',
      scriptsByWorktree: {
        'wt-1': entry({
          run: { ptyId: 'pty-old', status: 'running', exitCode: null, startedAt: 1 }
        })
      },
      dispose
    })
    expect(dispose).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledWith('pty-old')
  })

  it('is a no-op when there is no prior ptyId for the worktree', () => {
    const dispose = vi.fn()
    disposePriorScriptCachedTerminal({
      kind: 'run',
      worktreeId: 'wt-1',
      newPtyId: 'pty-new',
      scriptsByWorktree: {},
      dispose
    })
    expect(dispose).not.toHaveBeenCalled()
  })

  it('is a no-op when the prior ptyId equals the new ptyId (idempotent restart event)', () => {
    const dispose = vi.fn()
    disposePriorScriptCachedTerminal({
      kind: 'run',
      worktreeId: 'wt-1',
      newPtyId: 'pty-same',
      scriptsByWorktree: {
        'wt-1': entry({
          run: { ptyId: 'pty-same', status: 'running', exitCode: null, startedAt: 1 }
        })
      },
      dispose
    })
    expect(dispose).not.toHaveBeenCalled()
  })

  it('does not touch the OTHER kind (setup is independent of run)', () => {
    // Prior setup ptyId for the same worktree must not be disposed when a
    // run script restarts; they own different cached terminals.
    const dispose = vi.fn()
    disposePriorScriptCachedTerminal({
      kind: 'run',
      worktreeId: 'wt-1',
      newPtyId: 'pty-run-new',
      scriptsByWorktree: {
        'wt-1': entry({
          run: { ptyId: 'pty-run-old', status: 'running', exitCode: null, startedAt: 1 },
          setup: { ptyId: 'pty-setup', status: 'running', exitCode: null, startedAt: 2 }
        })
      },
      dispose
    })
    expect(dispose).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledWith('pty-run-old')
    expect(dispose).not.toHaveBeenCalledWith('pty-setup')
  })

  it('disposes the setup ptyId on a setup restart (kind: "setup")', () => {
    const dispose = vi.fn()
    disposePriorScriptCachedTerminal({
      kind: 'setup',
      worktreeId: 'wt-1',
      newPtyId: 'pty-setup-new',
      scriptsByWorktree: {
        'wt-1': entry({
          setup: { ptyId: 'pty-setup-old', status: 'running', exitCode: null, startedAt: 1 }
        })
      },
      dispose
    })
    expect(dispose).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledWith('pty-setup-old')
  })
})

describe('disposeWorktreeCachedSidebarTerminals', () => {
  it('disposes both run + setup cached ptyIds for every removed worktree', () => {
    const dispose = vi.fn()
    disposeWorktreeCachedSidebarTerminals({
      worktreeIds: ['wt-1', 'wt-2'],
      scriptsByWorktree: {
        'wt-1': entry({
          run: { ptyId: 'pty-r1', status: 'running', exitCode: null, startedAt: 1 },
          setup: { ptyId: 'pty-s1', status: 'running', exitCode: null, startedAt: 1 }
        }),
        'wt-2': entry({
          run: { ptyId: 'pty-r2', status: 'exited-success', exitCode: 0, startedAt: 1 }
        }),
        'wt-other': entry({
          run: { ptyId: 'pty-untouched', status: 'running', exitCode: null, startedAt: 1 }
        })
      },
      dispose
    })
    const disposed = dispose.mock.calls.map((call) => call[0]).sort()
    expect(disposed).toEqual(['pty-r1', 'pty-r2', 'pty-s1'])
    expect(dispose).not.toHaveBeenCalledWith('pty-untouched')
  })

  it('skips worktrees with no scripts entry', () => {
    const dispose = vi.fn()
    disposeWorktreeCachedSidebarTerminals({
      worktreeIds: ['wt-missing'],
      scriptsByWorktree: {},
      dispose
    })
    expect(dispose).not.toHaveBeenCalled()
  })

  it('skips entries whose ptyId is null (script never ran)', () => {
    const dispose = vi.fn()
    disposeWorktreeCachedSidebarTerminals({
      worktreeIds: ['wt-1'],
      scriptsByWorktree: { 'wt-1': entry() },
      dispose
    })
    expect(dispose).not.toHaveBeenCalled()
  })
})
