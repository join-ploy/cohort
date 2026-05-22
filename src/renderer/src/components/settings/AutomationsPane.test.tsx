// AutomationsPane tests. The contract pinned here:
//
//   1. `hasAnyEnabledLinearIssueTrigger` — pure helper that decides whether
//      the "Linear not connected" banner is worth showing.
//   2. `AutomationsPaneView` render markup:
//      - shows the poll-interval input with the current value
//      - shows the banner iff (linear disconnected) AND any enabled
//        linear-issue auto-trigger exists
//      - hides the banner when connected, or when no linear-issue trigger.
//
// `AutomationsPaneView` is the presentational seam: the container
// `AutomationsPane` loads automations via window.api on mount, which doesn't
// fire under renderToStaticMarkup. Tests render the view directly to cover
// every banner branch without needing act()/effect flushing.

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Automation, AutoTrigger } from '../../../../shared/automations-types'

// Why: SearchableSetting (used by AutomationsPaneView) reads the search query
// from useAppStore. Stub the store so the search filter passes through.
vi.mock('@/store', () => ({
  useAppStore: (selector?: (state: Record<string, unknown>) => unknown) =>
    selector ? selector({ settingsSearchQuery: '' }) : {}
}))

import { AutomationsPaneView, hasAnyEnabledLinearIssueTrigger } from './AutomationsPane'

function buildLinearTrigger(overrides: Partial<AutoTrigger> = {}): AutoTrigger {
  return {
    id: 't1',
    source: 'linear-issue',
    enabled: true,
    enabledAt: 0,
    rules: [],
    ...overrides
  }
}

function buildAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    name: 'a',
    prompt: '',
    agentId: 'claude',
    projectId: 'p1',
    executionTargetType: 'local',
    executionTargetId: '',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'existing',
    workspaceId: null,
    baseBranch: null,
    timezone: 'UTC',
    rrule: '',
    dtstart: 0,
    enabled: true,
    nextRunAt: 0,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  } as Automation
}

describe('hasAnyEnabledLinearIssueTrigger', () => {
  it('returns false for an empty list', () => {
    expect(hasAnyEnabledLinearIssueTrigger([])).toBe(false)
  })

  it('returns false when no automation has autoTriggers', () => {
    expect(hasAnyEnabledLinearIssueTrigger([buildAutomation()])).toBe(false)
  })

  it('returns false when a linear-issue trigger exists but is disabled', () => {
    const automation = buildAutomation({
      autoTriggers: [buildLinearTrigger({ enabled: false })]
    })
    expect(hasAnyEnabledLinearIssueTrigger([automation])).toBe(false)
  })

  it('returns true when at least one enabled linear-issue trigger exists', () => {
    const automation = buildAutomation({
      autoTriggers: [buildLinearTrigger({ enabled: true })]
    })
    expect(hasAnyEnabledLinearIssueTrigger([automation])).toBe(true)
  })

  it('returns true when any automation across the list has an enabled linear-issue trigger', () => {
    const automations = [
      buildAutomation({ id: 'a1' }),
      buildAutomation({
        id: 'a2',
        autoTriggers: [buildLinearTrigger({ enabled: true })]
      })
    ]
    expect(hasAnyEnabledLinearIssueTrigger(automations)).toBe(true)
  })
})

describe('AutomationsPaneView — poll interval input', () => {
  it('renders the Linear poll interval field with the current value', () => {
    const markup = renderToStaticMarkup(
      React.createElement(AutomationsPaneView, {
        pollIntervalSeconds: 120,
        linearConnected: true,
        hasEnabledLinearTrigger: false,
        onCommitPollInterval: vi.fn()
      })
    )
    expect(markup).toContain('value="120"')
    expect(markup).toContain('type="number"')
    expect(markup).toContain('min="15"')
    expect(markup).toContain('max="600"')
  })
})

describe('AutomationsPaneView — Linear not connected banner', () => {
  it('renders the banner when Linear is disconnected AND a linear-issue trigger is enabled', () => {
    const markup = renderToStaticMarkup(
      React.createElement(AutomationsPaneView, {
        pollIntervalSeconds: 60,
        linearConnected: false,
        hasEnabledLinearTrigger: true,
        onCommitPollInterval: vi.fn()
      })
    )
    expect(markup).toContain('Linear not connected')
    expect(markup).toContain('auto triggers paused')
  })

  it('does NOT render the banner when Linear is connected', () => {
    const markup = renderToStaticMarkup(
      React.createElement(AutomationsPaneView, {
        pollIntervalSeconds: 60,
        linearConnected: true,
        hasEnabledLinearTrigger: true,
        onCommitPollInterval: vi.fn()
      })
    )
    expect(markup).not.toContain('Linear not connected')
  })

  it('does NOT render the banner when disconnected but no enabled linear-issue trigger exists', () => {
    const markup = renderToStaticMarkup(
      React.createElement(AutomationsPaneView, {
        pollIntervalSeconds: 60,
        linearConnected: false,
        hasEnabledLinearTrigger: false,
        onCommitPollInterval: vi.fn()
      })
    )
    expect(markup).not.toContain('Linear not connected')
  })
})
