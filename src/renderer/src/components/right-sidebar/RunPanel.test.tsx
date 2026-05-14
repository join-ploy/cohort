import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ScriptState } from '@/store/slices/scripts'

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
