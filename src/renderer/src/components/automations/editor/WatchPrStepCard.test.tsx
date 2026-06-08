// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WatchPrStepCard } from './WatchPrStepCard'
import type { Step, WatchPrConfig } from '../../../../../shared/automations-types'
import type { AvailableVariables } from '../../../lib/template-dry-run'

const EMPTY_AVAIL: AvailableVariables = { automation: {}, trigger: {}, steps: {} }

function makeConfig(overrides: Partial<WatchPrConfig> = {}): WatchPrConfig {
  return {
    worktreeRef: '{{steps.cw.worktreeId}}',
    paneRef: '{{steps.rp.paneKey}}',
    events: { changesRequested: true, newReviewComments: false, anyReview: false },
    pollIntervalSeconds: 30,
    agentIdleDebounceSeconds: 5,
    failedCycleHaltsLoop: false,
    branchSteps: [],
    ...overrides
  }
}

function makeStep(configOverrides: Partial<WatchPrConfig> = {}): Step {
  return {
    id: 'watch-1',
    kind: 'watch-pr',
    config: makeConfig(configOverrides),
    onFailure: 'halt',
    timeoutSeconds: null
  }
}

function renderCard(step: Step, onConfigChange: (config: WatchPrConfig) => void = () => {}): void {
  render(
    <WatchPrStepCard
      step={step}
      stepIndex={0}
      available={EMPTY_AVAIL}
      repos={[]}
      reviewCommands={[]}
      createPrCommands={[]}
      httpConnections={[]}
      onIdChange={() => {}}
      onConfigChange={onConfigChange}
      onOnFailureChange={() => {}}
      onTimeoutChange={() => {}}
      onDelete={() => {}}
    />
  )
}

afterEach(() => {
  cleanup()
})

describe('WatchPrStepCard', () => {
  it('renders the worktree and pane ref fields with current values', () => {
    const markup = renderToStaticMarkup(
      <WatchPrStepCard
        step={makeStep()}
        stepIndex={0}
        available={EMPTY_AVAIL}
        repos={[]}
        reviewCommands={[]}
        createPrCommands={[]}
        httpConnections={[]}
        onIdChange={() => {}}
        onConfigChange={() => {}}
        onOnFailureChange={() => {}}
        onTimeoutChange={() => {}}
        onDelete={() => {}}
      />
    )
    expect(markup).toMatch(/aria-label=["']Worktree ref["']/)
    expect(markup).toMatch(/aria-label=["']Pane ref["']/)
    expect(markup).toContain('steps.cw.worktreeId')
    expect(markup).toContain('steps.rp.paneKey')
    // The Watch PR kind badge from StepCardChrome.
    expect(markup).toContain('Watch PR')
    // The embedded branch editor's Add step affordance.
    expect(markup).toMatch(/aria-label=["']Add step["']/)
  })

  it('defaults to changes-requested checked and the other events unchecked', () => {
    renderCard(makeStep())
    expect((screen.getByLabelText('Changes requested') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('New review comments') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText('Any review activity') as HTMLInputElement).checked).toBe(false)
  })

  it('toggling New review comments updates the events config', () => {
    const onConfigChange = vi.fn()
    renderCard(makeStep(), onConfigChange)
    fireEvent.click(screen.getByLabelText('New review comments'))
    expect(onConfigChange).toHaveBeenCalledTimes(1)
    const next = onConfigChange.mock.calls[0][0] as WatchPrConfig
    expect(next.events).toEqual({
      changesRequested: true,
      newReviewComments: true,
      anyReview: false
    })
  })

  it('editing the poll interval updates pollIntervalSeconds', () => {
    const onConfigChange = vi.fn()
    renderCard(makeStep(), onConfigChange)
    fireEvent.change(screen.getByLabelText('Poll interval seconds'), { target: { value: '60' } })
    expect((onConfigChange.mock.calls[0][0] as WatchPrConfig).pollIntervalSeconds).toBe(60)
  })

  it('toggling the halt-on-failed-cycle checkbox updates failedCycleHaltsLoop', () => {
    const onConfigChange = vi.fn()
    renderCard(makeStep(), onConfigChange)
    fireEvent.click(screen.getByLabelText('Halt the loop if a response cycle fails'))
    expect((onConfigChange.mock.calls[0][0] as WatchPrConfig).failedCycleHaltsLoop).toBe(true)
  })

  it('toggling the run-in-background checkbox updates detached', () => {
    const onConfigChange = vi.fn()
    renderCard(makeStep(), onConfigChange)
    fireEvent.click(screen.getByLabelText("Run in the background (don't block the chain)"))
    expect((onConfigChange.mock.calls[0][0] as WatchPrConfig).detached).toBe(true)
  })
})
