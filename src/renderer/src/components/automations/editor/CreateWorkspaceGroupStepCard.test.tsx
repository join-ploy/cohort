// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CreateWorkspaceGroupStepCard } from './CreateWorkspaceGroupStepCard'
import { ChainEditorStepCardRouter } from './ChainEditorStepCardRouter'
import type { CreateWorkspaceGroupConfig, Step } from '../../../../../shared/automations-types'
import type { Repo } from '../../../../../shared/types'
import type { AvailableVariables } from '../../../lib/template-dry-run'

// Why: Radix Popover internals reach for ResizeObserver / hasPointerCapture /
// scrollIntoView in jsdom — install minimal no-op polyfills so RepoMultiCombobox
// (which the card embeds) can mount without crashing during tests.
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

const EMPTY_AVAIL: AvailableVariables = { automation: {}, trigger: {}, steps: {} }

const REPOS: Repo[] = [
  {
    id: 'repo-a',
    path: '/tmp/a',
    displayName: 'Repo A',
    badgeColor: '#aabbcc',
    addedAt: 0
  },
  {
    id: 'repo-b',
    path: '/tmp/b',
    displayName: 'Repo B',
    badgeColor: '#ddeeff',
    addedAt: 0
  },
  {
    id: 'repo-c',
    path: '/tmp/c',
    displayName: 'Repo C',
    badgeColor: '#112233',
    addedAt: 0
  }
]

function makeStep(overrides: Partial<CreateWorkspaceGroupConfig> = {}): Step {
  const config: CreateWorkspaceGroupConfig = {
    members: [
      { repoId: 'repo-a', baseBranch: 'main' },
      { repoId: 'repo-b', baseBranch: 'develop' }
    ],
    branchName: 'feature/x',
    displayName: 'My Group',
    linkLinearIssue: true,
    ...overrides
  }
  return {
    id: 'cwg-1',
    kind: 'create-workspace-group',
    config,
    onFailure: 'halt',
    timeoutSeconds: 60
  }
}

afterEach(() => cleanup())

describe('CreateWorkspaceGroupStepCard', () => {
  it('renders all the fields', () => {
    const markup = renderToStaticMarkup(
      <CreateWorkspaceGroupStepCard
        step={makeStep()}
        stepIndex={0}
        available={EMPTY_AVAIL}
        repos={REPOS}
        onIdChange={() => {}}
        onConfigChange={() => {}}
        onOnFailureChange={() => {}}
        onTimeoutChange={() => {}}
        onDelete={() => {}}
      />
    )
    // Kind badge label from StepCardChrome
    expect(markup).toContain('Create workspace group')
    // Branch + display name templated inputs
    expect(markup).toMatch(/aria-label=["']Branch name["']/)
    expect(markup).toMatch(/value=["']feature\/x["']/)
    expect(markup).toMatch(/aria-label=["']Display name["']/)
    expect(markup).toMatch(/value=["']My Group["']/)
    // Per-member base-branch inputs are keyed by repo displayName
    expect(markup).toMatch(/aria-label=["']Base branch for Repo A["']/)
    expect(markup).toMatch(/aria-label=["']Base branch for Repo B["']/)
    expect(markup).toMatch(/value=["']develop["']/)
    // Linear-link checkbox and members combobox trigger
    expect(markup).toMatch(/aria-label=["']Link Linear issue["'][^>]*checked/)
    expect(markup).toContain('Members')
  })

  it('calls onConfigChange with the new value when the branch-name field is edited', () => {
    const onConfigChange = vi.fn()
    render(
      <CreateWorkspaceGroupStepCard
        step={makeStep()}
        stepIndex={0}
        available={EMPTY_AVAIL}
        repos={REPOS}
        onIdChange={() => {}}
        onConfigChange={onConfigChange}
        onOnFailureChange={() => {}}
        onTimeoutChange={() => {}}
        onDelete={() => {}}
      />
    )
    const input = screen.getByLabelText('Branch name') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'feature/y' } })
    expect(onConfigChange).toHaveBeenCalledTimes(1)
    const next = onConfigChange.mock.calls[0][0] as CreateWorkspaceGroupConfig
    expect(next.branchName).toBe('feature/y')
    // Other fields preserved
    expect(next.displayName).toBe('My Group')
    expect(next.members).toHaveLength(2)
  })

  it('updates members when a per-repo base-branch input changes', () => {
    const onConfigChange = vi.fn()
    render(
      <CreateWorkspaceGroupStepCard
        step={makeStep()}
        stepIndex={0}
        available={EMPTY_AVAIL}
        repos={REPOS}
        onIdChange={() => {}}
        onConfigChange={onConfigChange}
        onOnFailureChange={() => {}}
        onTimeoutChange={() => {}}
        onDelete={() => {}}
      />
    )
    const baseInput = screen.getByLabelText('Base branch for Repo A') as HTMLInputElement
    fireEvent.change(baseInput, { target: { value: 'release/2026' } })
    expect(onConfigChange).toHaveBeenCalledTimes(1)
    const next = onConfigChange.mock.calls[0][0] as CreateWorkspaceGroupConfig
    expect(next.members).toEqual([
      { repoId: 'repo-a', baseBranch: 'release/2026' },
      { repoId: 'repo-b', baseBranch: 'develop' }
    ])
  })

  it('renders within the chain editor when routed via ChainEditorStepCardRouter', () => {
    const markup = renderToStaticMarkup(
      <ChainEditorStepCardRouter
        step={makeStep()}
        index={0}
        available={EMPTY_AVAIL}
        repos={REPOS}
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
    expect(markup).toContain('Create workspace group')
    expect(markup).toMatch(/aria-label=["']Branch name["']/)
  })
})
