// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HTTP_SECRET_MASK, type HttpConnection } from '../../../../shared/automations-types'

// Why: SearchableSetting reads the search query from useAppStore — stub it so the
// empty query passes the filter and the section's children actually render.
vi.mock('@/store', () => ({
  useAppStore: (selector?: (state: Record<string, unknown>) => unknown) =>
    selector ? selector({ settingsSearchQuery: '' }) : {}
}))

import { HttpConnectionsSection } from './HttpConnectionsSection'

// Why: jsdom auto-cleanup is off (no setupFiles), so accumulated DOM would make
// role/label queries ambiguous between tests.
afterEach(() => cleanup())

function conn(overrides: Partial<HttpConnection> = {}): HttpConnection {
  return {
    id: 'c1',
    displayName: 'Prod API',
    baseUrl: '',
    headers: [],
    ...overrides
  }
}

describe('HttpConnectionsSection', () => {
  it('adds a connection with an id and empty headers when Add is clicked', () => {
    const onChange = vi.fn()
    render(<HttpConnectionsSection httpConnections={[]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    const next = onChange.mock.calls[0][0] as HttpConnection[]
    expect(next).toHaveLength(1)
    expect(typeof next[0].id).toBe('string')
    expect(next[0].headers).toEqual([])
  })

  it('commits an edited name on blur', () => {
    const onChange = vi.fn()
    const existing = conn({ displayName: 'Old' })
    render(<HttpConnectionsSection httpConnections={[existing]} onChange={onChange} />)
    const name = screen.getByPlaceholderText('Production API') as HTMLInputElement
    fireEvent.change(name, { target: { value: 'New name' } })
    fireEvent.blur(name)
    expect(onChange).toHaveBeenCalledWith([{ ...existing, displayName: 'New name' }])
  })

  it('renders a masked secret header as set with Replace (no editable value), and Replace clears it', () => {
    const onChange = vi.fn()
    const existing = conn({
      headers: [
        {
          id: 'h1',
          key: 'Authorization',
          value: HTTP_SECRET_MASK,
          secret: true
        }
      ]
    })
    render(<HttpConnectionsSection httpConnections={[existing]} onChange={onChange} />)
    expect(screen.getByText('•••• (set)')).toBeTruthy()
    expect(screen.queryByLabelText('Header value')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    expect(onChange).toHaveBeenCalledWith([
      { ...existing, headers: [{ ...existing.headers[0], value: '' }] }
    ])
  })

  it('clears the mask sentinel when a sealed header is un-secreted (no literal mask persisted)', () => {
    const onChange = vi.fn()
    const existing = conn({
      headers: [{ id: 'h1', key: 'Authorization', value: HTTP_SECRET_MASK, secret: true }]
    })
    render(<HttpConnectionsSection httpConnections={[existing]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Header secret' }))
    // Why: un-secreting must NOT persist value '••••••••' as a non-secret — that
    // would destroy the ciphertext and send the sentinel as a real header.
    expect(onChange).toHaveBeenCalledWith([
      { ...existing, headers: [{ ...existing.headers[0], secret: false, value: '' }] }
    ])
  })

  it('removes a connection when its delete button is clicked', () => {
    const onChange = vi.fn()
    const existing = conn({ displayName: 'Prod API' })
    render(<HttpConnectionsSection httpConnections={[existing]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Prod API' }))
    expect(onChange).toHaveBeenCalledWith([])
  })

  // Why: user-event (not fireEvent) simulates the blur-before-click focus shift
  // that triggers the clobber bug — the toggle's payload must fold the live
  // valueDraft so the just-typed value survives the discrete action.
  it('preserves a typed header value when the secret toggle is clicked', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const existing = conn({
      headers: [{ id: 'h1', key: 'Authorization', value: '', secret: false }]
    })
    render(<HttpConnectionsSection httpConnections={[existing]} onChange={onChange} />)

    await user.type(screen.getByLabelText('Header value'), 'sk-123')
    await user.click(screen.getByRole('button', { name: 'Toggle Header secret' }))

    // The controlled spy never re-feeds props, so find the call that flipped
    // secret on (the toggle's payload) and assert it kept the typed value.
    const toggleCall = [...onChange.mock.calls]
      .reverse()
      .map((c) => c[0] as HttpConnection[])
      .find((next) => next[0].headers[0].secret === true)
    expect(toggleCall).toBeTruthy()
    expect(toggleCall![0].headers[0].value).toBe('sk-123')
    expect(toggleCall![0].headers[0].secret).toBe(true)
  })

  it('appends a header with an id when Add header is clicked', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const existing = conn({ headers: [] })
    render(<HttpConnectionsSection httpConnections={[existing]} onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: 'Add header' }))

    const next = onChange.mock.calls.at(-1)![0] as HttpConnection[]
    expect(next[0].headers).toHaveLength(1)
    expect(typeof next[0].headers[0].id).toBe('string')
  })
})
