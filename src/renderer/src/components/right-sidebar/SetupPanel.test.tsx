import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ScriptState } from '@/store/slices/scripts'
import type { SetupGroupMember } from './SetupPanelGroupView'

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
  useRepoById: () => ({ id: 'repo-1', kind: 'git', path: '/tmp/repo' }),
  // Why: getGroupByWorktreeId / getMemberWorktreesForGroup / getRepoMapFromState
  // are read by the default-export container only. The empty/header/wiring
  // tests in this file exercise SetupPanelView directly, so these stubs just
  // need to be present (no group) — the dedicated group-mode tests below
  // exercise SetupPanelGroupView directly without touching the store.
  getGroupByWorktreeId: () => null,
  getMemberWorktreesForGroup: () => [],
  getRepoMapFromState: () => new Map()
}))

// Why: SidebarPtyTerminal pulls in xterm + the keyboard-layout probe + the
// per-tab settings store. None of that is the subject of these tests, which
// only assert the header text and Re-run / Stop button wiring of the view
// shell. Stub it with an inert placeholder so renders complete in the
// `node` test environment (no `window`, no DOM).
vi.mock('./SidebarPtyTerminal', () => ({
  default: () => null
}))

const IDLE: ScriptState = { ptyId: null, status: 'idle', exitCode: null, startedAt: null }

describe('SetupPanelView — empty state', () => {
  it('renders the empty-state message when no setup script is configured', async () => {
    const { SetupPanelView } = await import('./SetupPanel')
    const html = renderToStaticMarkup(
      <SetupPanelView
        setupScript={undefined}
        setupState={null}
        isPrimaryWorktree={false}
        onReRun={() => {}}
        onStop={() => {}}
        onOpenOrcaYaml={() => {}}
      />
    )
    expect(html).toMatch(/no setup script configured/i)
    expect(html).toMatch(/orca\.yaml/i)
    expect(html).toMatch(/conductor\.json/i)
    expect(html).toMatch(/scripts\.setup/i)
    expect(html).toMatch(/open config/i)
  })

  it('does not render Re-run / Stop buttons in the empty state', async () => {
    const { SetupPanelView } = await import('./SetupPanel')
    const html = renderToStaticMarkup(
      <SetupPanelView
        setupScript={undefined}
        setupState={null}
        isPrimaryWorktree={false}
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
        isPrimaryWorktree={false}
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
        isPrimaryWorktree={false}
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
      isPrimaryWorktree: false,
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
      isPrimaryWorktree: false,
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
        isPrimaryWorktree={false}
        onReRun={() => {}}
        onStop={() => {}}
        onOpenOrcaYaml={() => {}}
      />
    )
    expect(html).toMatch(/exited 1/i)
    expect(html).toMatch(/aria-label="Re-run/)
  })
})

describe('SetupPanelView — primary worktree disabled state', () => {
  it('renders the primary-state copy (no Re-run/Stop) when active worktree is primary and a script is configured', async () => {
    // Why: setup is only valid for `git worktree add`-created worktrees.
    // On the primary checkout, the panel must visibly explain why the
    // re-run controls are absent rather than silently doing nothing.
    const { SetupPanelView } = await import('./SetupPanel')
    const html = renderToStaticMarkup(
      <SetupPanelView
        setupScript="pnpm install"
        setupState={IDLE}
        isPrimaryWorktree={true}
        onReRun={() => {}}
        onStop={() => {}}
        onOpenOrcaYaml={() => {}}
      />
    )
    expect(html).toMatch(/setup runs only when creating worktrees/i)
    expect(html).toMatch(/switch to a worktree/i)
    expect(html).not.toMatch(/aria-label="Re-run/)
    expect(html).not.toMatch(/aria-label="Stop/)
  })

  it('still renders the empty state when no setup script is configured even on primary', async () => {
    // Why: empty-state wins over primary-state — the user's first action
    // should be configuring scripts.setup, not switching worktrees.
    const { SetupPanelView } = await import('./SetupPanel')
    const html = renderToStaticMarkup(
      <SetupPanelView
        setupScript={undefined}
        setupState={null}
        isPrimaryWorktree={true}
        onReRun={() => {}}
        onStop={() => {}}
        onOpenOrcaYaml={() => {}}
      />
    )
    expect(html).toMatch(/no setup script configured/i)
    expect(html).not.toMatch(/setup runs only when creating worktrees/i)
  })

  it('renders the normal panel header (Re-run button) when a script is configured and worktree is not primary', async () => {
    const { SetupPanelView } = await import('./SetupPanel')
    const html = renderToStaticMarkup(
      <SetupPanelView
        setupScript="pnpm install"
        setupState={IDLE}
        isPrimaryWorktree={false}
        onReRun={() => {}}
        onStop={() => {}}
        onOpenOrcaYaml={() => {}}
      />
    )
    expect(html).toMatch(/aria-label="Re-run/)
    expect(html).not.toMatch(/setup runs only when creating worktrees/i)
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

// Why: group-mode tests exercise SetupPanelGroupView directly — the pure view
// receives already-resolved member metadata so we don't need to mock the
// hooks:check IPC or the workspace-groups store slice here.
function makeMember(overrides: {
  worktreeId: string
  repoId: string
  repoName: string
  setupScript?: string
  status?: ScriptState['status']
  isPrimaryWorktree?: boolean
}): SetupGroupMember {
  return {
    worktreeId: overrides.worktreeId,
    repoId: overrides.repoId,
    repoName: overrides.repoName,
    isPrimaryWorktree: overrides.isPrimaryWorktree ?? false,
    setupScript: overrides.setupScript ?? 'pnpm install',
    setupState: {
      ptyId: null,
      status: overrides.status ?? 'idle',
      exitCode: null,
      startedAt: null
    }
  }
}

describe('SetupPanelGroupView — segmented mode', () => {
  it('renders one segment per member when the workspace is grouped', async () => {
    const { SetupPanelGroupView } = await import('./SetupPanelGroupView')
    const members = [
      makeMember({ worktreeId: 'wt-a', repoId: 'repo-a', repoName: 'frontend' }),
      makeMember({ worktreeId: 'wt-b', repoId: 'repo-b', repoName: 'backend' }),
      makeMember({ worktreeId: 'wt-c', repoId: 'repo-c', repoName: 'shared' })
    ]
    const html = renderToStaticMarkup(
      <SetupPanelGroupView
        members={members}
        activeRepoId="repo-a"
        onSelectRepo={() => {}}
        onReRun={() => {}}
        onStop={() => {}}
        onOpenOrcaYaml={() => {}}
      />
    )
    expect(html).toContain('frontend')
    expect(html).toContain('backend')
    expect(html).toContain('shared')
  })

  it('switching segments via activeRepoId shows that member’s setup state', async () => {
    const { SetupPanelGroupView } = await import('./SetupPanelGroupView')
    // Why: each member carries a distinct setup state — the running one
    // must be the rendered body when its repoId is active, not the idle
    // one. Header text "running…" vs "never run" disambiguates.
    const members = [
      makeMember({
        worktreeId: 'wt-a',
        repoId: 'repo-a',
        repoName: 'alpha',
        status: 'idle'
      }),
      makeMember({
        worktreeId: 'wt-b',
        repoId: 'repo-b',
        repoName: 'bravo',
        status: 'running'
      })
    ]
    const htmlA = renderToStaticMarkup(
      <SetupPanelGroupView
        members={members}
        activeRepoId="repo-a"
        onSelectRepo={() => {}}
        onReRun={() => {}}
        onStop={() => {}}
        onOpenOrcaYaml={() => {}}
      />
    )
    expect(htmlA).toMatch(/never run/i)
    const htmlB = renderToStaticMarkup(
      <SetupPanelGroupView
        members={members}
        activeRepoId="repo-b"
        onSelectRepo={() => {}}
        onReRun={() => {}}
        onStop={() => {}}
        onOpenOrcaYaml={() => {}}
      />
    )
    expect(htmlB).toMatch(/running/i)
  })

  it('Re-run on the selected segment fires with that member’s worktreeId', async () => {
    const { SetupPanelGroupView } = await import('./SetupPanelGroupView')
    const members = [
      makeMember({ worktreeId: 'wt-a', repoId: 'repo-a', repoName: 'alpha' }),
      makeMember({ worktreeId: 'wt-b', repoId: 'repo-b', repoName: 'bravo' })
    ]
    const onReRun = vi.fn()
    const element = SetupPanelGroupView({
      members,
      activeRepoId: 'repo-b',
      onSelectRepo: () => {},
      onReRun,
      onStop: () => {},
      onOpenOrcaYaml: () => {}
    })
    const button = findByAriaLabel(element, 'Re-run setup script')
    ;(button.props.onClick as () => void)()
    expect(onReRun).toHaveBeenCalledOnce()
    expect(onReRun).toHaveBeenCalledWith('wt-b')
  })
})

describe('aggregateGroupSetupStatus', () => {
  it('returns failed when any member failed', async () => {
    const { aggregateGroupSetupStatus } = await import('./SetupPanelGroupView')
    expect(aggregateGroupSetupStatus(['done', 'failed', 'running'])).toBe('failed')
  })
  it('returns running when none failed but at least one is running', async () => {
    const { aggregateGroupSetupStatus } = await import('./SetupPanelGroupView')
    expect(aggregateGroupSetupStatus(['idle', 'running', 'done'])).toBe('running')
  })
  it('returns done only when every member finished successfully', async () => {
    const { aggregateGroupSetupStatus } = await import('./SetupPanelGroupView')
    expect(aggregateGroupSetupStatus(['done', 'done'])).toBe('done')
    expect(aggregateGroupSetupStatus(['done', 'idle'])).toBe('idle')
  })
  it('returns idle for an empty member list', async () => {
    const { aggregateGroupSetupStatus } = await import('./SetupPanelGroupView')
    expect(aggregateGroupSetupStatus([])).toBe('idle')
  })
})
