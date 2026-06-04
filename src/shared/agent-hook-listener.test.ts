import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createHookListenerState,
  getEndpointFileName,
  isShellSafeEndpointValue,
  normalizeHookPayload,
  parseFormEncodedBody,
  resolveHookSource,
  writeEndpointFile,
  type HookListenerState
} from './agent-hook-listener'

describe('shared agent-hook-listener', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  it('parses form-encoded bodies', () => {
    const decoded = parseFormEncodedBody('paneKey=tab-1%3A0&worktreeId=foo')
    expect(decoded.paneKey).toBe('tab-1:0')
    expect(decoded.worktreeId).toBe('foo')
  })

  it('routes pathnames to a known source or null', () => {
    expect(resolveHookSource('/hook/claude')).toBe('claude')
    expect(resolveHookSource('/hook/cursor')).toBe('cursor')
    expect(resolveHookSource('/hook/unknown')).toBeNull()
    expect(resolveHookSource('/')).toBeNull()
  })

  it('rejects shell-unsafe endpoint values', () => {
    expect(isShellSafeEndpointValue('1234')).toBe(true)
    expect(isShellSafeEndpointValue('abc-DEF.0_1')).toBe(true)
    expect(isShellSafeEndpointValue('')).toBe(false)
    expect(isShellSafeEndpointValue('foo&bar')).toBe(false)
    expect(isShellSafeEndpointValue('foo bar')).toBe(false)
    expect(isShellSafeEndpointValue('foo;bar')).toBe(false)
  })

  it('normalizes a Claude UserPromptSubmit body to a working state', () => {
    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: 'tab-1:0',
        tabId: 'tab-1',
        worktreeId: 'wt',
        env: 'production',
        version: '1',
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'hello' }
      },
      'production'
    )
    expect(event).not.toBeNull()
    expect(event!.paneKey).toBe('tab-1:0')
    expect(event!.connectionId).toBeNull()
    expect(event!.payload.state).toBe('working')
    expect(event!.payload.prompt).toBe('hello')
    expect(event!.payload.agentType).toBe('claude')
  })

  it('trims surrounding whitespace from extracted prompt text', () => {
    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: 'tab-1:0',
        payload: { hook_event_name: 'UserPromptSubmit', prompt: '   hi   ' }
      },
      'production'
    )
    expect(event).not.toBeNull()
    expect(event!.payload.prompt).toBe('hi')
  })

  it('rejects oversized paneKey', () => {
    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: 'x'.repeat(300),
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'hi' }
      },
      'production'
    )
    expect(event).toBeNull()
  })

  it('isolates caches between listener instances', () => {
    const a = createHookListenerState()
    const b = createHookListenerState()
    normalizeHookPayload(
      a,
      'claude',
      { paneKey: 'p', payload: { hook_event_name: 'UserPromptSubmit', prompt: 'first' } },
      'production'
    )
    // The second listener has no cached prompt for this paneKey, so a tool
    // event without a fresh prompt should produce empty prompt string.
    const event = normalizeHookPayload(
      b,
      'claude',
      {
        paneKey: 'p',
        payload: {
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/etc/hosts' }
        }
      },
      'production'
    )
    expect(event).not.toBeNull()
    expect(event!.payload.prompt).toBe('')
  })

  describe('Claude Stop with pending background work', () => {
    const stopEvent = (payload: Record<string, unknown>) =>
      normalizeHookPayload(
        state,
        'claude',
        { paneKey: 'tab-1:0', payload: { hook_event_name: 'Stop', ...payload } },
        'production'
      )

    it('reports `done` when both background arrays are absent', () => {
      const event = stopEvent({ last_assistant_message: 'all set' })
      expect(event!.payload.state).toBe('done')
    })

    it('reports `done` when both background arrays are present but empty', () => {
      const event = stopEvent({ background_tasks: [], session_crons: [] })
      expect(event!.payload.state).toBe('done')
    })

    it('reports `waiting` when a background task is still in flight', () => {
      const event = stopEvent({
        background_tasks: [{ id: 'task-1', type: 'monitor', status: 'running' }]
      })
      expect(event!.payload.state).toBe('waiting')
    })

    it('reports `waiting` when a one-shot session cron is scheduled', () => {
      const event = stopEvent({
        session_crons: [{ id: 'cron-1', schedule: '0 9 * * *', recurring: false }]
      })
      expect(event!.payload.state).toBe('waiting')
    })

    it('reports `waiting` even when the only pending item is a recurring cron', () => {
      const event = stopEvent({
        session_crons: [{ id: 'cron-1', schedule: '0 9 * * 1-5', recurring: true }]
      })
      expect(event!.payload.state).toBe('waiting')
    })

    it('forces `done` (interrupted) when the user cancelled, despite pending work', () => {
      const event = stopEvent({
        is_interrupt: true,
        background_tasks: [{ id: 'task-1', type: 'monitor', status: 'running' }]
      })
      expect(event!.payload.state).toBe('done')
      expect(event!.payload.interrupted).toBe(true)
    })

    it('parks on the monitor Stop, then completes on the later empty Stop', () => {
      const claudeEvent = (payload: Record<string, unknown>) =>
        normalizeHookPayload(state, 'claude', { paneKey: 'tab-1:0', payload }, 'production')
      // Turn starts working, then a monitor parks it...
      expect(
        claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })!.payload.state
      ).toBe('working')
      expect(
        claudeEvent({
          hook_event_name: 'Stop',
          background_tasks: [{ id: 't1', type: 'monitor', status: 'running' }]
        })!.payload.state
      ).toBe('waiting')
      // ...the monitor fires and the agent resumes, then finishes cleanly.
      expect(claudeEvent({ hook_event_name: 'PreToolUse', tool_name: 'Read' })!.payload.state).toBe(
        'working'
      )
      expect(claudeEvent({ hook_event_name: 'Stop', background_tasks: [] })!.payload.state).toBe(
        'done'
      )
    })
  })

  describe('writeEndpointFile', () => {
    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'agent-hook-listener-'))
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('writes the endpoint file atomically with the right contents and mode', () => {
      const finalPath = join(dir, getEndpointFileName())
      const ok = writeEndpointFile(dir, finalPath, {
        port: 12345,
        token: 'abcdef-0123',
        env: 'production',
        version: '1'
      })
      expect(ok).toBe(true)
      const text = readFileSync(finalPath, 'utf8')
      expect(text).toContain('ORCA_AGENT_HOOK_PORT=12345')
      expect(text).toContain('ORCA_AGENT_HOOK_TOKEN=abcdef-0123')
      expect(text).toContain('ORCA_AGENT_HOOK_VERSION=1')
      // POSIX 0o600 — owner read/write only.
      if (process.platform !== 'win32') {
        const mode = statSync(finalPath).mode & 0o777
        expect(mode).toBe(0o600)
      }
    })

    it('refuses unsafe values', () => {
      const finalPath = join(dir, getEndpointFileName())
      const ok = writeEndpointFile(dir, finalPath, {
        port: 12345,
        token: 'safe-token',
        env: 'foo&bar',
        version: '1'
      })
      expect(ok).toBe(false)
    })
  })
})
