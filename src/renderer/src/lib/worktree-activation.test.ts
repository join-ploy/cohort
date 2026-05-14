import { describe, expect, it, vi } from 'vitest'
import { ensureWorktreeHasInitialTerminal } from './worktree-activation'

// Why: Phase 7 removed the renderer-side setup-PTY mount from
// ensureWorktreeHasInitialTerminal. The setup PTY is now spawned by
// main's per-worktree setup-script registry and surfaced in the
// right-sidebar Setup tab via setup:started/exited events; no
// regular terminal tab is created or split for it. The setup-tab /
// setup-split assertions that used to live here have been removed
// alongside that production behaviour. Issue-command splits are still
// owned by this helper and remain covered.

function createMockStore(overrides: Record<string, unknown> = {}) {
  return {
    tabsByWorktree: {} as Record<string, { id: string }[]>,
    createTab: vi.fn(() => ({ id: 'tab-1' })),
    setActiveTab: vi.fn(),
    setTabCustomTitle: vi.fn(),
    reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 0 })),
    queueTabStartupCommand: vi.fn(),
    queueTabIssueCommandSplit: vi.fn(),
    ...overrides
  }
}

describe('ensureWorktreeHasInitialTerminal', () => {
  it('creates a single tab when no startup or issue command is provided', () => {
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(store, 'wt-1')

    expect(store.createTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      pendingActivationSpawn: true
    })
    expect(store.setActiveTab).toHaveBeenCalledWith('tab-1')
    expect(store.queueTabStartupCommand).not.toHaveBeenCalled()
    expect(store.queueTabIssueCommandSplit).not.toHaveBeenCalled()
  })

  it('does not create or queue anything when the worktree already has renderable content', () => {
    const store = createMockStore({
      reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 1 }))
    })

    ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, {
      runnerScriptPath: '/tmp/repo/.git/orca/issue-command-runner.sh',
      envVars: {}
    })

    expect(store.createTab).not.toHaveBeenCalled()
    expect(store.setActiveTab).not.toHaveBeenCalled()
    expect(store.queueTabStartupCommand).not.toHaveBeenCalled()
    expect(store.queueTabIssueCommandSplit).not.toHaveBeenCalled()
  })

  it('queues a startup command when agent launch is provided', () => {
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(store, 'wt-1', { command: 'claude "Fix this bug"' })

    expect(store.createTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      pendingActivationSpawn: true
    })
    expect(store.setActiveTab).toHaveBeenCalledWith('tab-1')
    expect(store.queueTabStartupCommand).toHaveBeenCalledWith('tab-1', {
      command: 'claude "Fix this bug"'
    })
    expect(store.queueTabIssueCommandSplit).not.toHaveBeenCalled()
  })

  it('forwards telemetry on the queued startup so main can fire agent_started', () => {
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(store, 'wt-1', {
      command: 'claude',
      telemetry: {
        agent_kind: 'claude-code',
        launch_source: 'new_workspace_composer',
        request_kind: 'new'
      }
    })

    expect(store.queueTabStartupCommand).toHaveBeenCalledWith('tab-1', {
      command: 'claude',
      telemetry: {
        agent_kind: 'claude-code',
        launch_source: 'new_workspace_composer',
        request_kind: 'new'
      }
    })
  })

  it('does not create a terminal just because the legacy terminal slice is empty', () => {
    const store = createMockStore({
      tabsByWorktree: { 'wt-1': [] },
      reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 2 }))
    })

    ensureWorktreeHasInitialTerminal(store, 'wt-1')

    expect(store.createTab).not.toHaveBeenCalled()
    expect(store.setActiveTab).not.toHaveBeenCalled()
  })

  it('queues an issue command split when issueCommand is provided as a runner script', () => {
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, {
      runnerScriptPath: '/tmp/repo/.git/orca/issue-command-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/worktrees/wt-1'
      }
    })

    expect(store.createTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      pendingActivationSpawn: true
    })
    expect(store.setActiveTab).toHaveBeenCalledWith('tab-1')
    expect(store.queueTabIssueCommandSplit).toHaveBeenCalledWith('tab-1', {
      command: 'bash /tmp/repo/.git/orca/issue-command-runner.sh',
      env: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/worktrees/wt-1'
      }
    })
  })

  it('queues an issue command split when issueCommand is a direct command string', () => {
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, {
      command: 'gh issue view 123 --comments',
      env: { GH_TOKEN: 'x' }
    })

    expect(store.queueTabIssueCommandSplit).toHaveBeenCalledWith('tab-1', {
      command: 'gh issue view 123 --comments',
      env: { GH_TOKEN: 'x' }
    })
  })

  it('does not queue issue command split when issueCommand is not provided', () => {
    const store = createMockStore()

    ensureWorktreeHasInitialTerminal(store, 'wt-1')

    expect(store.queueTabStartupCommand).not.toHaveBeenCalled()
    expect(store.queueTabIssueCommandSplit).not.toHaveBeenCalled()
  })
})
