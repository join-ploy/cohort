import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetOpenPromptPaneDedupeForTests,
  evictOpenPromptPaneDedupeForPane,
  rememberOpenPromptPane
} from './open-prompt-pane-dedupe'

afterEach(() => {
  __resetOpenPromptPaneDedupeForTests()
})

describe('open-prompt-pane dedupe', () => {
  it('collapses concurrent opens of the same key into one launch', async () => {
    const launch = vi.fn(async () => ({ ok: true, paneKey: 'tabA:0' }) as const)
    const a = rememberOpenPromptPane('run1:stepA', launch)
    const b = rememberOpenPromptPane('run1:stepA', launch)
    expect(a).toBe(b)
    expect(launch).toHaveBeenCalledTimes(1)
    await expect(a).resolves.toEqual({ ok: true, paneKey: 'tabA:0' })
  })

  it('relaunches a fresh pane after the cached pane is closed (retry of same run-step)', async () => {
    // Why: this is the bug. A "Retry all" re-runs the same runId:stepId, so
    // without eviction the cache would hand the retry the prior attempt's
    // (now-closed) paneKey and the chain would reuse a dead agent's output.
    const launch1 = vi.fn(async () => ({ ok: true, paneKey: 'tabOld:0' }) as const)
    const first = await rememberOpenPromptPane('run1:stepA', launch1)
    expect(first).toEqual({ ok: true, paneKey: 'tabOld:0' })

    // The executor closes the prior pane as part of the retry teardown.
    evictOpenPromptPaneDedupeForPane('tabOld:0')

    const launch2 = vi.fn(async () => ({ ok: true, paneKey: 'tabNew:0' }) as const)
    const second = await rememberOpenPromptPane('run1:stepA', launch2)
    expect(launch2).toHaveBeenCalledTimes(1)
    expect(second).toEqual({ ok: true, paneKey: 'tabNew:0' })
  })

  it('keeps deduping a still-open pane (no close → no relaunch)', async () => {
    const launch1 = vi.fn(async () => ({ ok: true, paneKey: 'tabA:0' }) as const)
    await rememberOpenPromptPane('run1:stepA', launch1)
    const launch2 = vi.fn(async () => ({ ok: true, paneKey: 'tabB:0' }) as const)
    const again = await rememberOpenPromptPane('run1:stepA', launch2)
    expect(launch2).not.toHaveBeenCalled()
    expect(again).toEqual({ ok: true, paneKey: 'tabA:0' })
  })

  it('evicting an unknown paneKey is a no-op', () => {
    expect(() => evictOpenPromptPaneDedupeForPane('nope:0')).not.toThrow()
  })
})
