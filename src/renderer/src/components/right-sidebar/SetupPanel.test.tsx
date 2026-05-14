import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ScriptState } from '@/store/slices/scripts'

// Why: mirrors RunPanel.test.tsx — the test env is `node` (no jsdom), so
// we render the pure-view sibling SetupPanelView and walk the React
// element tree to find inner buttons by their aria-label. The default
// SetupPanel container hits useEffect-driven hooks-check IPC that the
// node env can never resolve in time for renderToStaticMarkup.

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  cb(element)
  if (
    typeof element.type === 'function' &&
    !isImportedComponent(element.type as { displayName?: string; name?: string })
  ) {
    try {
      const expanded = (element.type as (props: unknown) => unknown)(element.props ?? {})
      visit(expanded, cb)
      return
    } catch {
      // Why: shadcn primitives reach into context (Tooltip etc.); their
      // props are still on the JSX node so aria-label assertions don't
      // need the expansion to succeed.
    }
  }
  if (element.props?.children) {
    visit(element.props.children, cb)
  }
}

function isImportedComponent(type: { displayName?: string; name?: string }): boolean {
  const name = type.displayName ?? type.name ?? ''
  return name === 'Button'
}

function findByAriaLabel(node: unknown, label: string): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.props?.['aria-label'] === label) {
      found = entry
    }
  })
  if (!found) {
    throw new Error(`element with aria-label="${label}" not found`)
  }
  return found
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({ scriptsByWorktree: {} })
}))

vi.mock('@/store/selectors', () => ({
  useActiveWorktree: () => ({ id: 'wt-1', repoId: 'repo-1', branch: 'main' }),
  useRepoById: () => ({ id: 'repo-1', kind: 'git', path: '/tmp/repo' })
}))

const IDLE: ScriptState = { ptyId: null, status: 'idle', exitCode: null, startedAt: null }

describe('SetupPanelView — empty state', () => {
  it('renders the empty-state message when no setup script is configured', async () => {
    const { SetupPanelView } = await import('./SetupPanel')
    const html = renderToStaticMarkup(
      <SetupPanelView
        setupScript={undefined}
        setupState={null}
        onReRun={() => {}}
        onStop={() => {}}
        onOpenOrcaYaml={() => {}}
      />
    )
    expect(html).toMatch(/no setup script configured/i)
    expect(html).toMatch(/orca\.yaml/i)
    expect(html).toMatch(/scripts\.setup/i)
  })

  it('does not render Re-run / Stop buttons in the empty state', async () => {
    const { SetupPanelView } = await import('./SetupPanel')
    const html = renderToStaticMarkup(
      <SetupPanelView
        setupScript={undefined}
        setupState={null}
        onReRun={() => {}}
        onStop={() => {}}
        onOpenOrcaYaml={() => {}}
      />
    )
    expect(html).not.toMatch(/aria-label="Re-run/)
    expect(html).not.toMatch(/aria-label="Stop/)
  })

  it('shows "never run" status text and a Re-run button when no PTY exists yet', async () => {
    const { SetupPanelView } = await import('./SetupPanel')
    const html = renderToStaticMarkup(
      <SetupPanelView
        setupScript="pnpm install"
        setupState={IDLE}
        onReRun={() => {}}
        onStop={() => {}}
        onOpenOrcaYaml={() => {}}
      />
    )
    expect(html).toMatch(/never run/i)
    expect(html).toMatch(/aria-label="Re-run/)
  })

  it('does NOT show a Cmd+R / Ctrl+R hint (Cmd+R is for run only)', async () => {
    // Why: per Phase 7 plan — setup has no keyboard shortcut.
    // Cmd+R triggers `runScript.start`, never `setupScript.start`.
    const { SetupPanelView } = await import('./SetupPanel')
    const html = renderToStaticMarkup(
      <SetupPanelView
        setupScript="pnpm install"
        setupState={IDLE}
        onReRun={() => {}}
        onStop={() => {}}
        onOpenOrcaYaml={() => {}}
      />
    )
    expect(html).not.toMatch(/⌘R/)
    expect(html).not.toMatch(/Ctrl\+R/)
  })
})

describe('SetupPanelView — Re-run / Stop buttons', () => {
  it('Re-run button onClick fires the onReRun callback', async () => {
    const { SetupPanelView } = await import('./SetupPanel')
    const onReRun = vi.fn()
    const onStop = vi.fn()
    const element = SetupPanelView({
      setupScript: 'pnpm install',
      setupState: IDLE,
      onReRun,
      onStop,
      onOpenOrcaYaml: () => {}
    })
    const button = findByAriaLabel(element, 'Re-run setup script')
    ;(button.props.onClick as () => void)()
    expect(onReRun).toHaveBeenCalledOnce()
    expect(onStop).not.toHaveBeenCalled()
  })

  it('Stop button onClick fires the onStop callback while running', async () => {
    const { SetupPanelView } = await import('./SetupPanel')
    const onReRun = vi.fn()
    const onStop = vi.fn()
    const element = SetupPanelView({
      setupScript: 'pnpm install',
      setupState: { ...IDLE, status: 'running', ptyId: 'p-1', startedAt: 1 },
      onReRun,
      onStop,
      onOpenOrcaYaml: () => {}
    })
    const button = findByAriaLabel(element, 'Stop setup script')
    ;(button.props.onClick as () => void)()
    expect(onStop).toHaveBeenCalledOnce()
    expect(onReRun).not.toHaveBeenCalled()
  })

  it('shows the exit code in the header after the setup exits', async () => {
    const { SetupPanelView } = await import('./SetupPanel')
    const html = renderToStaticMarkup(
      <SetupPanelView
        setupScript="pnpm install"
        setupState={{ ...IDLE, status: 'exited-failure', ptyId: 'p-1', exitCode: 1 }}
        onReRun={() => {}}
        onStop={() => {}}
        onOpenOrcaYaml={() => {}}
      />
    )
    expect(html).toMatch(/exited 1/i)
    expect(html).toMatch(/aria-label="Re-run/)
  })
})

describe('SetupPanel default export — start/stop wiring', () => {
  it('callSetupStart routes ok:true responses without a toast', async () => {
    const { _testing } = await import('./SetupPanel')
    const start = vi.fn().mockResolvedValue({ ok: true, ptyId: 'p-1' })
    const toastError = vi.fn()
    await _testing.callSetupStart({ worktreeId: 'wt-1' }, { start, toastError })
    expect(start).toHaveBeenCalledWith({ worktreeId: 'wt-1' })
    expect(toastError).not.toHaveBeenCalled()
  })

  it('callSetupStart surfaces ok:false reasons via toast.error', async () => {
    const { _testing } = await import('./SetupPanel')
    const start = vi.fn().mockResolvedValue({ ok: false, reason: 'spawn-failed' as const })
    const toastError = vi.fn()
    await _testing.callSetupStart({ worktreeId: 'wt-1' }, { start, toastError })
    expect(toastError).toHaveBeenCalledOnce()
    expect(toastError.mock.calls[0][0]).toMatch(/spawn-failed/i)
  })

  it('callSetupStart toasts when the no-setup-script reason comes back', async () => {
    const { _testing } = await import('./SetupPanel')
    const start = vi.fn().mockResolvedValue({ ok: false, reason: 'no-setup-script' as const })
    const toastError = vi.fn()
    await _testing.callSetupStart({ worktreeId: 'wt-1' }, { start, toastError })
    expect(toastError).toHaveBeenCalledOnce()
  })

  it('callSetupStop ignores not-running responses (no toast)', async () => {
    const { _testing } = await import('./SetupPanel')
    const stop = vi.fn().mockResolvedValue({ ok: false, reason: 'not-running' as const })
    const toastError = vi.fn()
    await _testing.callSetupStop({ worktreeId: 'wt-1' }, { stop, toastError })
    expect(stop).toHaveBeenCalledWith({ worktreeId: 'wt-1' })
    expect(toastError).not.toHaveBeenCalled()
  })

  it('callSetupStop surfaces non-trivial failure reasons via toast.error', async () => {
    const { _testing } = await import('./SetupPanel')
    const stop = vi.fn().mockResolvedValue({ ok: false, reason: 'no-provider' as const })
    const toastError = vi.fn()
    await _testing.callSetupStop({ worktreeId: 'wt-1' }, { stop, toastError })
    expect(toastError).toHaveBeenCalledOnce()
  })
})
