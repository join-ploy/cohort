// @vitest-environment jsdom
import * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ScheduleTriggerCard } from './ScheduleTriggerCard'
import { recurrenceFromCron } from '../../../../../shared/schedule-cron'
import type { AutoTrigger } from '../../../../../shared/automations-types'

// Why: Radix Popover + cmdk reach for ResizeObserver / hasPointerCapture /
// scrollIntoView in jsdom — install minimal no-op polyfills so the searchable
// timezone combobox can open during tests.
type ROCallback = () => void
class TestResizeObserver {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_cb: ROCallback) {
    /* no-op */
  }
  observe(): void {
    /* no-op */
  }
  unobserve(): void {
    /* no-op */
  }
  disconnect(): void {
    /* no-op */
  }
}
;(globalThis as unknown as { ResizeObserver: typeof TestResizeObserver }).ResizeObserver =
  TestResizeObserver
if (
  typeof Element !== 'undefined' &&
  typeof (Element.prototype as unknown as { hasPointerCapture?: unknown }).hasPointerCapture !==
    'function'
) {
  ;(Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture = () =>
    false
}
if (
  typeof Element !== 'undefined' &&
  typeof (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView !==
    'function'
) {
  ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
}

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

  it('toggling a weekday chip emits a cron carrying the new day set', () => {
    const onEmit = vi.fn()
    render(<Harness initial={mkTrigger()} onEmit={onEmit} />)

    // Switch to weekly (seeds Mon–Fri), then turn Saturday on.
    fireEvent.change(screen.getByLabelText('Repeat'), { target: { value: 'weekly' } })
    fireEvent.click(screen.getByLabelText('Saturday'))

    const last = onEmit.mock.calls.at(-1)?.[0] as AutoTrigger
    const r = recurrenceFromCron(last.schedule!.cron)
    expect(r).toEqual({ freq: 'weekly', days: [1, 2, 3, 4, 5, 6], hour: 9, minute: 0 })
  })

  it('selecting a timezone in the combobox emits the new zone with the cron unchanged', async () => {
    const user = userEvent.setup()
    const onEmit = vi.fn()
    render(<Harness initial={mkTrigger()} onEmit={onEmit} />)

    await user.click(screen.getByRole('combobox', { name: 'Timezone' }))
    await user.type(await screen.findByPlaceholderText('Search timezones...'), 'Tokyo')
    await user.click(await screen.findByRole('option', { name: 'Asia/Tokyo' }))

    const last = onEmit.mock.calls.at(-1)?.[0] as AutoTrigger
    expect(last.schedule!.timezone).toBe('Asia/Tokyo')
    // Changing the zone must not rewrite the schedule.
    expect(last.schedule!.cron).toBe('0 9 * * *')
  })

  it('typing a valid cron in Advanced persists it through onChange', () => {
    const onEmit = vi.fn()
    render(<Harness initial={mkTrigger()} onEmit={onEmit} />)

    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    fireEvent.change(screen.getByLabelText('Cron expression'), {
      target: { value: '15 14 * * 1' }
    })

    const last = onEmit.mock.calls.at(-1)?.[0] as AutoTrigger
    expect(last.schedule!.cron).toBe('15 14 * * 1')
    expect(recurrenceFromCron(last.schedule!.cron)).toEqual({
      freq: 'weekly',
      days: [1],
      hour: 14,
      minute: 15
    })
  })
})
