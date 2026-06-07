// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HttpEndpointItemPicker } from './HttpEndpointItemPicker'
import type { HttpEndpointItem } from '../../../../../shared/automations-types'

// Why: cmdk (used by the picker) instantiates a ResizeObserver on mount; jsdom
// doesn't provide one. Stub it before any component renders.
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

const itemA: HttpEndpointItem = {
  key: 'k1',
  label: 'First item',
  subtitle: 'subtitle one',
  vars: { id: 1, title: 'First item' }
}
const itemB: HttpEndpointItem = {
  key: 'k2',
  label: 'Second item',
  subtitle: 'subtitle two',
  vars: { id: 2, title: 'Second item' }
}

function stubFetchItems(impl: () => Promise<HttpEndpointItem[]>): ReturnType<typeof vi.fn> {
  const fetchItems = vi.fn(impl)
  // Why: assign onto the existing jsdom window so testing-library's document
  // stays intact (vs. replacing window wholesale).
  ;(globalThis.window as unknown as { api: unknown }).api = {
    httpEndpoint: { fetchItems }
  }
  return fetchItems
}

afterEach(() => {
  cleanup()
})

describe('HttpEndpointItemPicker', () => {
  it('fetches items on mount and renders label + subtitle for each', async () => {
    const fetchItems = stubFetchItems(async () => [itemA, itemB])
    render(<HttpEndpointItemPicker automationId="auto-1" autoTriggerId="t1" onSelect={() => {}} />)
    expect(fetchItems).toHaveBeenCalledWith({ automationId: 'auto-1', autoTriggerId: 't1' })
    expect(await screen.findByText('First item')).toBeTruthy()
    expect(screen.getByText('subtitle one')).toBeTruthy()
    expect(screen.getByText('Second item')).toBeTruthy()
    expect(screen.getByText('subtitle two')).toBeTruthy()
  })

  it('calls onSelect with the whole picked item', async () => {
    stubFetchItems(async () => [itemA, itemB])
    const onSelect = vi.fn()
    render(<HttpEndpointItemPicker automationId="auto-1" autoTriggerId="t1" onSelect={onSelect} />)
    const row = (await screen.findByText('Second item')).closest('[data-http-item-key]')
    expect(row).not.toBeNull()
    fireEvent.click(row!)
    expect(onSelect).toHaveBeenCalledWith(itemB)
  })

  it('shows a loading state before the fetch resolves', async () => {
    let resolveFetch!: (value: HttpEndpointItem[]) => void
    stubFetchItems(() => new Promise<HttpEndpointItem[]>((r) => (resolveFetch = r)))
    render(<HttpEndpointItemPicker automationId="a" autoTriggerId="t" onSelect={() => {}} />)
    expect(screen.getByRole('status')).toBeTruthy()
    resolveFetch([itemA])
    expect(await screen.findByText('First item')).toBeTruthy()
  })

  it('shows an empty state when no items are returned', async () => {
    stubFetchItems(async () => [])
    render(<HttpEndpointItemPicker automationId="a" autoTriggerId="t" onSelect={() => {}} />)
    expect(await screen.findByText(/No items/i)).toBeTruthy()
  })

  it('filters items client-side by the search query', async () => {
    stubFetchItems(async () => [itemA, itemB])
    render(<HttpEndpointItemPicker automationId="a" autoTriggerId="t" onSelect={() => {}} />)
    await screen.findByText('First item')
    fireEvent.change(screen.getByLabelText('Filter endpoint items'), {
      target: { value: 'second' }
    })
    await waitFor(() => expect(screen.queryByText('First item')).toBeNull())
    expect(screen.getByText('Second item')).toBeTruthy()
  })

  it('shows an error state when the fetch rejects', async () => {
    stubFetchItems(async () => {
      throw new Error('boom')
    })
    render(<HttpEndpointItemPicker automationId="a" autoTriggerId="t" onSelect={() => {}} />)
    expect(await screen.findByText(/Failed to load/i)).toBeTruthy()
  })

  it('recovers via the Retry button after a failed fetch', async () => {
    let calls = 0
    const fetchItems = stubFetchItems(async () => {
      calls += 1
      if (calls === 1) {
        throw new Error('boom')
      }
      return [itemA, itemB]
    })
    render(<HttpEndpointItemPicker automationId="a" autoTriggerId="t" onSelect={() => {}} />)
    // First fetch rejects → error branch with a Retry control.
    expect(await screen.findByText(/Failed to load/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    // Retry bumps the reload key, re-runs the fetch, and the items render.
    expect(await screen.findByText('First item')).toBeTruthy()
    expect(screen.getByText('Second item')).toBeTruthy()
    expect(fetchItems).toHaveBeenCalledTimes(2)
  })
})
