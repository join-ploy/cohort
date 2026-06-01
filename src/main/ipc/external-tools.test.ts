import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings, Repo, WorktreeMeta } from '../../shared/types'
import { getDefaultSettings } from '../../shared/constants'

const { handleMock, spawnMock, gitExecMock, getEffectiveHooksMock, getDefaultBaseRefMock } =
  vi.hoisted(() => ({
    handleMock: vi.fn(),
    spawnMock: vi.fn(),
    gitExecMock: vi.fn(),
    getEffectiveHooksMock: vi.fn(),
    getDefaultBaseRefMock: vi.fn()
  }))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('../git/runner', () => ({ gitExecFileAsync: gitExecMock }))
vi.mock('../hooks', () => ({ getEffectiveHooks: getEffectiveHooksMock }))
vi.mock('../git/repo', () => ({ getDefaultBaseRef: getDefaultBaseRefMock }))

import { registerExternalToolHandlers } from './external-tools'

type Handler = (event: unknown, args: unknown) => Promise<{ ok: boolean; error?: string }>

const repo = { id: 'repo-1', path: '/repo', worktreeBaseRef: undefined } as Repo

function makeStore(settings: Partial<GlobalSettings>, meta?: WorktreeMeta) {
  return {
    getSettings: () => ({ ...getDefaultSettings('/home/tester'), ...settings }),
    getRepo: (id: string) => (id === 'repo-1' ? repo : undefined),
    getWorktreeMeta: () => meta
  }
}

function makeChild() {
  const handlers: Record<string, (arg?: unknown) => void> = {}
  return {
    once(event: string, cb: (arg?: unknown) => void) {
      handlers[event] = cb
      if (event === 'spawn') {
        cb() // resolve immediately in tests
      }
      return this
    },
    unref: vi.fn()
  }
}

function getRunHandler(store: unknown): Handler {
  registerExternalToolHandlers(store as never)
  const call = handleMock.mock.calls.find((c: unknown[]) => c[0] === 'externalTool:run')
  if (!call) {
    throw new Error('externalTool:run not registered')
  }
  return call[1] as Handler
}

const baseArgs = {
  worktreeId: 'repo-1::/wt/feature',
  worktreePath: '/wt/feature',
  repoId: 'repo-1',
  workspaceName: 'wise_panther',
  displayName: 'plo-3884-feature'
}

describe('registerExternalToolHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    spawnMock.mockImplementation(() => makeChild())
    gitExecMock.mockResolvedValue({ stdout: 'sha\n', stderr: '' })
    getEffectiveHooksMock.mockReturnValue({ databaseUrl: '' })
    getDefaultBaseRefMock.mockReturnValue('main')
  })

  it('returns ok:false when no command is configured', async () => {
    const handler = getRunHandler(makeStore({ externalDiffCommand: '' }))
    await expect(handler({}, { tool: 'diff', ...baseArgs })).resolves.toEqual({
      ok: false,
      error: 'No command configured'
    })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('spawns the diff command with merge-base + head substituted, via the shell', async () => {
    gitExecMock.mockImplementation((args: string[]) =>
      Promise.resolve({
        stdout: `${args[0] === 'merge-base' ? 'mbsha' : 'headsha'}\n`,
        stderr: ''
      })
    )
    const handler = getRunHandler(
      makeStore({ externalDiffCommand: 'diff -e \'(d "${MERGE_BASE}..${HEAD}")\'' })
    )
    await expect(handler({}, { tool: 'diff', ...baseArgs })).resolves.toEqual({ ok: true })
    expect(spawnMock).toHaveBeenCalledWith('diff -e \'(d "mbsha..headsha")\'', {
      shell: true,
      detached: true,
      stdio: 'ignore'
    })
  })

  it('resolves ${DATABASE_URL} from effective hooks with the workspace name', async () => {
    getEffectiveHooksMock.mockReturnValue({
      databaseUrl: 'postgresql://localhost/${WORKSPACE_NAME}_dev'
    })
    const handler = getRunHandler(makeStore({ externalDatabaseCommand: 'db ${DATABASE_URL}' }))
    await handler({}, { tool: 'database', ...baseArgs })
    expect(spawnMock).toHaveBeenCalledWith(
      'db postgresql://localhost/wise_panther_dev',
      expect.objectContaining({ shell: true })
    )
  })
})
