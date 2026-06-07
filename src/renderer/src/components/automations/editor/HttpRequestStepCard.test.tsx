// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { HttpRequestStepCard } from './HttpRequestStepCard'
import type {
  HttpConnection,
  HttpRequestStepConfig,
  Step
} from '../../../../../shared/automations-types'
import type { AvailableVariables } from '../../../lib/template-dry-run'

const EMPTY_AVAIL: AvailableVariables = { automation: {}, trigger: {}, steps: {} }

const CONNECTIONS: HttpConnection[] = [
  { id: 'c1', displayName: 'Acme', baseUrl: 'https://api.acme.dev', headers: [] }
]

function makeStep(overrides: Partial<HttpRequestStepConfig> = {}): Step {
  const config: HttpRequestStepConfig = {
    request: { method: 'GET', url: 'https://api.test/items', headers: [], query: [] },
    itemsPath: null,
    fields: [],
    ...overrides
  }
  return {
    id: 'http-1',
    kind: 'http-request',
    config,
    onFailure: 'halt',
    timeoutSeconds: null
  }
}

const noop = (): void => {}

afterEach(() => {
  cleanup()
})

describe('HttpRequestStepCard', () => {
  it('renders the shared HTTP request editor surface', () => {
    const markup = renderToStaticMarkup(
      <HttpRequestStepCard
        step={makeStep()}
        stepIndex={0}
        available={EMPTY_AVAIL}
        httpConnections={CONNECTIONS}
        onIdChange={noop}
        onConfigChange={noop}
        onOnFailureChange={noop}
        onTimeoutChange={noop}
        onDelete={noop}
      />
    )
    // The shared editor's connection picker, request URL, and Test affordance.
    expect(markup).toMatch(/aria-label=["']Connection["']/)
    expect(markup).toMatch(/aria-label=["']URL["']/)
    expect(markup).toContain('Acme')
    expect(markup).toContain('Test')
  })

  it('forwards editor edits to onConfigChange as a step config', () => {
    const onConfigChange = vi.fn()
    const { getByLabelText } = render(
      <HttpRequestStepCard
        step={makeStep()}
        stepIndex={0}
        available={EMPTY_AVAIL}
        httpConnections={CONNECTIONS}
        onIdChange={noop}
        onConfigChange={onConfigChange}
        onOnFailureChange={noop}
        onTimeoutChange={noop}
        onDelete={noop}
      />
    )
    fireEvent.change(getByLabelText('URL'), { target: { value: 'https://x/y' } })
    expect(onConfigChange).toHaveBeenCalledTimes(1)
    const next = onConfigChange.mock.calls[0][0] as HttpRequestStepConfig
    expect(next.request.url).toBe('https://x/y')
  })
})
