import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect, vi } from 'vitest'
import { VariablePickerPopover } from './VariablePickerPopover'
import type { AvailableVariables } from '../../../lib/template-dry-run'

const SCHEMA: AvailableVariables = {
  automation: { projectId: 'string', workspaceId: 'string' },
  trigger: { firedAt: 'number', actorEmail: 'string' },
  steps: {
    cw1: { worktreeId: 'string', path: 'string', branch: 'string' }
  }
}

const FAKE_ANCHOR = {
  getBoundingClientRect: () => ({
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
    width: 0,
    height: 0
  })
} as unknown as HTMLElement

describe('VariablePickerPopover', () => {
  it('renders nothing when closed', () => {
    const markup = renderToStaticMarkup(
      <VariablePickerPopover
        open={false}
        anchor={FAKE_ANCHOR}
        available={SCHEMA}
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(markup).toBe('')
  })

  it('renders all variables when open', () => {
    const markup = renderToStaticMarkup(
      <VariablePickerPopover
        open={true}
        anchor={FAKE_ANCHOR}
        available={SCHEMA}
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(markup).toContain('automation.projectId')
    expect(markup).toContain('automation.workspaceId')
    expect(markup).toContain('trigger.firedAt')
    expect(markup).toContain('trigger.actorEmail')
    expect(markup).toContain('steps.cw1.worktreeId')
    expect(markup).toContain('steps.cw1.path')
    expect(markup).toContain('steps.cw1.branch')
  })

  it('renders the type alongside each leaf', () => {
    const markup = renderToStaticMarkup(
      <VariablePickerPopover
        open={true}
        anchor={FAKE_ANCHOR}
        available={SCHEMA}
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(markup).toMatch(/projectId.*string/)
    expect(markup).toMatch(/firedAt.*number/)
  })

  it('groups variables by namespace (Automation, Trigger, Steps)', () => {
    const markup = renderToStaticMarkup(
      <VariablePickerPopover
        open={true}
        anchor={FAKE_ANCHOR}
        available={SCHEMA}
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(markup).toMatch(/Automation/i)
    expect(markup).toMatch(/Trigger/i)
    expect(markup).toMatch(/Steps/i)
  })

  it('renders one subsection per step id', () => {
    const schema: AvailableVariables = {
      ...SCHEMA,
      steps: {
        cw1: { worktreeId: 'string' },
        cw2: { worktreeId: 'string' }
      }
    }
    const markup = renderToStaticMarkup(
      <VariablePickerPopover
        open={true}
        anchor={FAKE_ANCHOR}
        available={schema}
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(markup).toMatch(/cw1/)
    expect(markup).toMatch(/cw2/)
  })

  it('fuzzy-filters variables by query', () => {
    const markup = renderToStaticMarkup(
      <VariablePickerPopover
        open={true}
        anchor={FAKE_ANCHOR}
        available={SCHEMA}
        query="gro"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(markup).not.toContain('automation.projectId')
    expect(markup).not.toContain('trigger.firedAt')
  })

  it('matches fuzzy substrings across dots', () => {
    const markup = renderToStaticMarkup(
      <VariablePickerPopover
        open={true}
        anchor={FAKE_ANCHOR}
        available={SCHEMA}
        query="cwwt"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(markup).toContain('steps.cw1.worktreeId')
  })

  it('returns nothing when query matches no variables', () => {
    const markup = renderToStaticMarkup(
      <VariablePickerPopover
        open={true}
        anchor={FAKE_ANCHOR}
        available={SCHEMA}
        query="zzzzz"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(markup).toBe('')
  })
})
