// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { HttpEndpointTriggerCard } from './HttpEndpointTriggerCard'
import { findDuplicateVariableNames } from './HttpRequestEditor'
import type {
  AutoTrigger,
  HttpConnection,
  HttpEndpointConfig,
  MappedField
} from '../../../../../shared/automations-types'

const projects = [{ id: 'p1', displayName: 'orca-repo' }]

const connections: HttpConnection[] = [
  { id: 'c1', displayName: 'Acme', baseUrl: 'https://api.acme.dev', headers: [] }
]

const mkField = (over: Partial<MappedField> = {}): MappedField => ({
  path: 'id',
  variableName: 'id',
  enabled: true,
  type: 'number',
  sampleValue: 1,
  ...over
})

const mkHttp = (over: Partial<HttpEndpointConfig> = {}): HttpEndpointConfig => ({
  request: {
    method: 'GET',
    url: 'https://api.test/items',
    headers: [],
    query: []
  },
  itemsPath: null,
  fields: [],
  dedupeFields: [],
  dateGateField: null,
  ...over
})

const mkTrigger = (
  http: Partial<HttpEndpointConfig> = {},
  top: Partial<AutoTrigger> = {}
): AutoTrigger => ({
  id: 't1',
  source: 'http-endpoint',
  enabled: true,
  enabledAt: 0,
  rules: [],
  pollingEnabled: true,
  manualEnabled: false,
  http: mkHttp(http),
  ...top
})

afterEach(() => {
  cleanup()
})

describe('findDuplicateVariableNames', () => {
  it('returns [] when enabled variable names are unique', () => {
    expect(
      findDuplicateVariableNames([
        mkField({ path: 'a', variableName: 'a' }),
        mkField({ path: 'b', variableName: 'b' })
      ])
    ).toEqual([])
  })

  it('flags a name shared by two enabled fields', () => {
    expect(
      findDuplicateVariableNames([
        mkField({ path: 'a.b', variableName: 'a_b' }),
        mkField({ path: 'a_b', variableName: 'a_b' })
      ])
    ).toEqual(['a_b'])
  })

  it('ignores disabled fields when detecting collisions', () => {
    expect(
      findDuplicateVariableNames([
        mkField({ path: 'a', variableName: 'dup', enabled: true }),
        mkField({ path: 'b', variableName: 'dup', enabled: false })
      ])
    ).toEqual([])
  })
})

describe('HttpEndpointTriggerCard rendering', () => {
  it('renders the endpoint card for a minimal http trigger', () => {
    const html = renderToStaticMarkup(
      <HttpEndpointTriggerCard
        trigger={mkTrigger()}
        onChange={() => {}}
        onRemove={() => {}}
        automationId=""
        projects={projects}
        httpConnections={[]}
      />
    )
    expect(html).toContain('HTTP endpoint')
    expect(html).toContain('Poll automatically')
    expect(html).toContain('Allow manual run')
    expect(html).toMatch(/aria-label="Method"/)
    expect(html).toMatch(/aria-label="URL"/)
    expect(html).toContain('Test')
  })

  it('renders the poll settings only when pollingEnabled', () => {
    const on = renderToStaticMarkup(
      <HttpEndpointTriggerCard
        trigger={mkTrigger({}, { pollingEnabled: true })}
        onChange={() => {}}
        onRemove={() => {}}
        automationId=""
        projects={projects}
        httpConnections={[]}
      />
    )
    expect(on).toContain('Poll settings')
    const off = renderToStaticMarkup(
      <HttpEndpointTriggerCard
        trigger={mkTrigger({}, { pollingEnabled: false, manualEnabled: true })}
        onChange={() => {}}
        onRemove={() => {}}
        automationId=""
        projects={projects}
        httpConnections={[]}
      />
    )
    expect(off).not.toContain('Poll settings')
    expect(off).toContain('Manual run picker')
  })

  it('shows a duplicate-variable warning when two enabled fields share a name', () => {
    const html = renderToStaticMarkup(
      <HttpEndpointTriggerCard
        trigger={mkTrigger({
          fields: [
            mkField({ path: 'a.b', variableName: 'a_b' }),
            mkField({ path: 'a_b', variableName: 'a_b' })
          ]
        })}
        onChange={() => {}}
        onRemove={() => {}}
        automationId=""
        projects={projects}
        httpConnections={[]}
      />
    )
    expect(html).toContain('Duplicate variable name')
    expect(html).toContain('a_b')
  })
})

describe('HttpEndpointTriggerCard interactions', () => {
  beforeEach(() => {
    // Why: assign onto the existing jsdom window so testing-library's document
    // stays intact (vs. replacing window wholesale).
    ;(globalThis.window as unknown as { api: unknown }).api = {
      httpEndpoint: {
        test: vi.fn().mockResolvedValue({
          status: 200,
          durationMs: 7,
          body: { data: [{ id: 1, name: 'x' }] }
        })
      }
    }
  })

  it('toggles pollingEnabled through the capability switch reducer', () => {
    const onChange = vi.fn()
    render(
      <HttpEndpointTriggerCard
        trigger={mkTrigger({}, { pollingEnabled: true })}
        onChange={onChange}
        onRemove={() => {}}
        automationId=""
        projects={projects}
        httpConnections={[]}
      />
    )
    fireEvent.click(screen.getByLabelText('Poll automatically'))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0].pollingEnabled).toBe(false)
  })

  it('toggles manualEnabled through the capability switch reducer', () => {
    const onChange = vi.fn()
    render(
      <HttpEndpointTriggerCard
        trigger={mkTrigger({}, { manualEnabled: false })}
        onChange={onChange}
        onRemove={() => {}}
        automationId=""
        projects={projects}
        httpConnections={[]}
      />
    )
    fireEvent.click(screen.getByLabelText('Allow manual run'))
    expect(onChange.mock.calls[0][0].manualEnabled).toBe(true)
    // enabled is derived from the two capability toggles.
    expect(onChange.mock.calls[0][0].enabled).toBe(true)
  })

  it('populates the items dropdown after clicking Test', async () => {
    render(
      <HttpEndpointTriggerCard
        trigger={mkTrigger()}
        onChange={() => {}}
        onRemove={() => {}}
        automationId="auto-1"
        projects={projects}
        httpConnections={[]}
      />
    )
    // Items dropdown is absent until a sample exists.
    expect(screen.queryByLabelText('Items path')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Test' }))

    const select = (await screen.findByLabelText('Items path')) as HTMLSelectElement
    expect(window.api.httpEndpoint.test).toHaveBeenCalledWith({
      request: mkHttp().request,
      automationId: 'auto-1',
      autoTriggerId: 't1'
    })
    // detectArrayPaths surfaced the `data` array as an option.
    expect(select.textContent).toContain('data')
  })

  it('clears a prior success badge when a later Test rejects', async () => {
    const testMock = window.api.httpEndpoint.test as ReturnType<typeof vi.fn>
    render(
      <HttpEndpointTriggerCard
        trigger={mkTrigger()}
        onChange={() => {}}
        onRemove={() => {}}
        automationId=""
        projects={projects}
        httpConnections={[]}
      />
    )
    const testButton = screen.getByRole('button', { name: 'Test' })

    // First Test resolves → success badge appears.
    fireEvent.click(testButton)
    expect(await screen.findByText(/200/)).toBeTruthy()

    // Next Test rejects → the error shows and the stale "200" badge is gone.
    testMock.mockRejectedValueOnce(new Error('boom'))
    fireEvent.click(testButton)
    expect(await screen.findByText('boom')).toBeTruthy()
    expect(screen.queryByText(/200/)).toBeNull()
  })

  it('calls onChange via applyTestMapping when an items path is chosen', () => {
    const onChange = vi.fn()
    render(
      <HttpEndpointTriggerCard
        // Seed a persisted sample so the items dropdown renders on mount.
        trigger={mkTrigger({
          sampleResponse: { data: [{ id: 1, name: 'x' }] }
        })}
        onChange={onChange}
        onRemove={() => {}}
        automationId=""
        projects={projects}
        httpConnections={[]}
      />
    )
    const select = screen.getByLabelText('Items path') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'path:data' } })

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as AutoTrigger
    expect(next.http?.itemsPath).toBe('data')
    // flattenItem(items[0]) discovers the leaf fields plus the whole-item output
    // (path '').
    expect(next.http?.fields.map((f) => f.path).sort()).toEqual(['', 'id', 'name'])
    expect(next.http?.fields.find((f) => f.path === '')?.variableName).toBe('item')
  })
})

describe('HttpEndpointTriggerCard connection picker', () => {
  it('sets http.connectionId when a connection is selected', () => {
    const onChange = vi.fn()
    render(
      <HttpEndpointTriggerCard
        trigger={mkTrigger()}
        onChange={onChange}
        onRemove={() => {}}
        automationId=""
        projects={projects}
        httpConnections={connections}
      />
    )
    fireEvent.change(screen.getByLabelText('Connection'), { target: { value: 'c1' } })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect((onChange.mock.calls[0][0] as AutoTrigger).http?.connectionId).toBe('c1')
  })

  it('labels the URL field as Path and shows the base-URL hint when a connection resolves', () => {
    render(
      <HttpEndpointTriggerCard
        trigger={mkTrigger({ connectionId: 'c1' })}
        onChange={() => {}}
        onRemove={() => {}}
        automationId=""
        projects={projects}
        httpConnections={connections}
      />
    )
    expect(screen.getByLabelText('Path')).toBeTruthy()
    expect(screen.queryByLabelText('URL')).toBeNull()
    // The hint names the connection's base URL so the user sees what Path joins to.
    expect(screen.getByText(/api\.acme\.dev/)).toBeTruthy()
  })

  it('clears http.connectionId when the picker is reset to None', () => {
    const onChange = vi.fn()
    render(
      <HttpEndpointTriggerCard
        trigger={mkTrigger({ connectionId: 'c1' })}
        onChange={onChange}
        onRemove={() => {}}
        automationId=""
        projects={projects}
        httpConnections={connections}
      />
    )
    fireEvent.change(screen.getByLabelText('Connection'), { target: { value: '' } })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect((onChange.mock.calls[0][0] as AutoTrigger).http?.connectionId).toBeUndefined()
  })
})
