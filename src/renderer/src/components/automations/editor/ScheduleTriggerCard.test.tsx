// @vitest-environment jsdom
import * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ScheduleTriggerCard } from './ScheduleTriggerCard'
import { recurrenceFromCron } from '../../../../../shared/schedule-cron'
import type { AutoTrigger } from '../../../../../shared/automations-types'

const mkTrigger = (over: Partial<AutoTrigger> = {}): AutoTrigger => ({
  id: 't1',
  source: 'schedule',
  enabled: true,
  enabledAt: 0,
  rules: [],
  schedule: { cron: '0 9 * * *', timezone: 'UTC' },
  ...over
})

// Drive the card through a stateful parent so onChange round-trips into the
// trigger prop, mirroring how TriggersModal owns the draft.
function Harness({
  initial,
  onEmit
}: {
  initial: AutoTrigger
  onEmit?: (t: AutoTrigger) => void
}): React.JSX.Element {
  const [t, setT] = React.useState(initial)
  return (
    <ScheduleTriggerCard
      trigger={t}
      onChange={(next) => {
        setT(next)
        onEmit?.(next)
      }}
      onRemove={() => {}}
    />
  )
}

afterEach(() => {
  cleanup()
})

describe('ScheduleTriggerCard', () => {
  it('renders the default daily card with a non-empty Next runs list', () => {
    render(<Harness initial={mkTrigger()} />)
    expect((screen.getByLabelText('Repeat') as HTMLSelectElement).value).toBe('daily')
    const preview = screen.getByText('Next runs').parentElement as HTMLElement
    expect(within(preview).getAllByRole('listitem').length).toBeGreaterThan(0)
  })

  it('switching Repeat to Weekly surfaces weekday chips and emits a weekly cron', () => {
    const onEmit = vi.fn()
    render(<Harness initial={mkTrigger()} onEmit={onEmit} />)

    fireEvent.change(screen.getByLabelText('Repeat'), { target: { value: 'weekly' } })

    const last = onEmit.mock.calls.at(-1)?.[0] as AutoTrigger
    expect(recurrenceFromCron(last.schedule!.cron)).toEqual({
      freq: 'weekly',
      days: [1, 2, 3, 4, 5],
      hour: 9,
      minute: 0
    })
    // Weekday chips now render (queried by full-name aria-label so they don't
    // collide with the short weekday in the date preview).
    expect(screen.getByLabelText('Monday')).toBeTruthy()
    expect(screen.getByLabelText('Sunday')).toBeTruthy()
  })

  it('shows an error and hides the preview when an invalid cron is typed in Advanced', () => {
    render(<Harness initial={mkTrigger()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    fireEvent.change(screen.getByLabelText('Cron expression'), {
      target: { value: 'not a cron' }
    })

    expect(screen.getByText('Enter a valid 5-field cron expression.')).toBeTruthy()
    expect(screen.queryByText('Next runs')).toBeNull()
  })
})
