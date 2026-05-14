import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ScriptState } from '@/store/slices/scripts'

// Why: ActionButton.test.tsx pattern — call the component as a function
// and walk the React element tree to find the inner <Button> by its
// aria-label so we can invoke its onClick directly. The test env is
// node (no jsdom), so we cannot dispatch real DOM events.

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

// Why: `RunPanelView` returns a tree where the inner sections (RunHeader,
// RunEmptyState) are themselves function components — their children only
// materialize when invoked. The walker calls function-component types with
// their props so we can search the fully-expanded tree for an aria-label.
// Built-in components from `@/components/ui/button` are NOT invoked because
// they touch context (Tooltip etc.) we don't want to depend on; their
// aria-label still lives on their JSX props, which is what we assert.
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
      // Fall through to children traversal if calling the component throws
      // (e.g. it depends on hooks we don't want to fire).
    }
  }
  if (element.props?.children) {
    visit(element.props.children, cb)
  }
}

function isImportedComponent(type: { displayName?: string; name?: string }): boolean {
  // The shadcn Button uses 'Button' as its function name; we don't want to
  // invoke it (it reaches into class-variance-authority + Slot). Its props
  // (including aria-label) are still on the element so we assert on those.
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

// Why: RunPanel pulls in heavy renderer state (active worktree + repo
// selectors). Tests render the pure-view sibling RunPanelView so the
// empty / configured branches can be asserted without firing useEffect-
// driven hooks loading — the env is `node` (no jsdom), so any async
// fetch wouldn't resolve before renderToStaticMarkup returns.

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({ scriptsByWorktree: {} })
}))

vi.mock('@/store/selectors', () => ({
  useActiveWorktree: () => ({ id: 'wt-1', repoId: 'repo-1', branch: 'main' }),
  useRepoById: () => ({ id: 'repo-1', kind: 'git', path: '/tmp/repo' })
}))

const IDLE: ScriptState = { ptyId: null, status: 'idle', exitCode: null, startedAt: null }

describe('RunPanelView — empty state', () => {
  it('renders the empty-state message when no run script is configured', async () => {
    const { RunPanelView } = await import('./RunPanel')
    const html = renderToStaticMarkup(
      <RunPanelView
        runScript={undefined}
        runState={null}
        onReRun={() => {}}
        onStop={() => {}}
        onOpenOrcaYaml={() => {}}
      />
    )
    expect(html).toMatch(/no run script configured/i)
    expect(html).toMatch(/orca\.yaml/i)
  })

  it('does not render Re-run / Stop buttons in the empty state', async () => {
    const { RunPanelView } = await import('./RunPanel')
    const html = renderToStaticMarkup(
      <RunPanelView
        runScript={undefined}
        runState={null}
        onReRun={() => {}}
        onStop={() => {}}
        onOpenOrcaYaml={() => {}}
      />
    )
    expect(html).not.toMatch(/aria-label="Re-run/)
    expect(html).not.toMatch(/aria-label="Stop/)
  })

  it('shows "never run" status text and a Re-run button when no PTY exists yet', async () => {
    const { RunPanelView } = await import('./RunPanel')
    const html = renderToStaticMarkup(
      <RunPanelView
        runScript="pnpm dev"
        runState={IDLE}
        onReRun={() => {}}
        onStop={() => {}}
        onOpenOrcaYaml={() => {}}
      />
    )
    expect(html).toMatch(/never run/i)
    expect(html).toMatch(/aria-label="Re-run/)
  })
})

describe('RunPanelView — Re-run / Stop buttons', () => {
  it('Re-run button onClick fires the onReRun callback', async () => {
    const { RunPanelView } = await import('./RunPanel')
    const onReRun = vi.fn()
    const onStop = vi.fn()
    const element = RunPanelView({
      runScript: 'pnpm dev',
      runState: IDLE,
      onReRun,
      onStop,
      onOpenOrcaYaml: () => {}
    })
    const button = findByAriaLabel(element, 'Re-run script')
    ;(button.props.onClick as () => void)()
    expect(onReRun).toHaveBeenCalledOnce()
    expect(onStop).not.toHaveBeenCalled()
  })

  it('Stop button onClick fires the onStop callback while running', async () => {
    const { RunPanelView } = await import('./RunPanel')
    const onReRun = vi.fn()
    const onStop = vi.fn()
    const element = RunPanelView({
      runScript: 'pnpm dev',
      runState: { ...IDLE, status: 'running', ptyId: 'p-1', startedAt: 1 },
      onReRun,
      onStop,
      onOpenOrcaYaml: () => {}
    })
    const button = findByAriaLabel(element, 'Stop run script')
    ;(button.props.onClick as () => void)()
    expect(onStop).toHaveBeenCalledOnce()
    expect(onReRun).not.toHaveBeenCalled()
  })

  it('shows the exit code in the header after the run exits', async () => {
    const { RunPanelView } = await import('./RunPanel')
    const html = renderToStaticMarkup(
      <RunPanelView
        runScript="pnpm dev"
        runState={{ ...IDLE, status: 'exited-failure', ptyId: 'p-1', exitCode: 137 }}
        onReRun={() => {}}
        onStop={() => {}}
        onOpenOrcaYaml={() => {}}
      />
    )
    expect(html).toMatch(/exited 137/i)
    expect(html).toMatch(/aria-label="Re-run/)
  })
})

describe('RunPanel default export — start/stop wiring', () => {
  it('callRunStart routes ok:true responses without a toast', async () => {
    const { _testing } = await import('./RunPanel')
    const start = vi.fn().mockResolvedValue({ ok: true, ptyId: 'p-1' })
    const toastError = vi.fn()
    await _testing.callRunStart({ repoId: 'repo-1', worktreeId: 'wt-1' }, { start, toastError })
    expect(start).toHaveBeenCalledWith({ repoId: 'repo-1', worktreeId: 'wt-1' })
    expect(toastError).not.toHaveBeenCalled()
  })

  it('callRunStart surfaces ok:false reasons via toast.error', async () => {
    const { _testing } = await import('./RunPanel')
    const start = vi.fn().mockResolvedValue({ ok: false, reason: 'spawn-failed' as const })
    const toastError = vi.fn()
    await _testing.callRunStart({ repoId: 'repo-1', worktreeId: 'wt-1' }, { start, toastError })
    expect(toastError).toHaveBeenCalledOnce()
    expect(toastError.mock.calls[0][0]).toMatch(/spawn-failed/i)
  })

  it('callRunStart toasts when the no-run-script reason comes back', async () => {
    const { _testing } = await import('./RunPanel')
    const start = vi.fn().mockResolvedValue({ ok: false, reason: 'no-run-script' as const })
    const toastError = vi.fn()
    await _testing.callRunStart({ repoId: 'repo-1', worktreeId: 'wt-1' }, { start, toastError })
    expect(toastError).toHaveBeenCalledOnce()
  })

  it('callRunStop ignores not-running responses (no toast)', async () => {
    const { _testing } = await import('./RunPanel')
    const stop = vi.fn().mockResolvedValue({ ok: false, reason: 'not-running' as const })
    const toastError = vi.fn()
    await _testing.callRunStop({ repoId: 'repo-1' }, { stop, toastError })
    expect(stop).toHaveBeenCalledWith({ repoId: 'repo-1' })
    expect(toastError).not.toHaveBeenCalled()
  })

  it('callRunStop surfaces non-trivial failure reasons via toast.error', async () => {
    const { _testing } = await import('./RunPanel')
    const stop = vi.fn().mockResolvedValue({ ok: false, reason: 'no-provider' as const })
    const toastError = vi.fn()
    await _testing.callRunStop({ repoId: 'repo-1' }, { stop, toastError })
    expect(toastError).toHaveBeenCalledOnce()
  })
})
