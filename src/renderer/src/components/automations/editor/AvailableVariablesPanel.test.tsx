import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import { AvailableVariablesPanel } from './AvailableVariablesPanel'
import type { AvailableVariables } from '../../../lib/template-dry-run'

const SCHEMA: AvailableVariables = {
  automation: { projectId: 'string', workspaceId: 'string' },
  trigger: { firedAt: 'number', actorEmail: 'string' },
  steps: {
    cw1: { worktreeId: 'string', path: 'string', branch: 'string' }
  }
}

describe('AvailableVariablesPanel', () => {
  it('shows a count in the header', () => {
    // automation: 2 + trigger: 2 + steps: 3 = 7
    const markup = renderToStaticMarkup(<AvailableVariablesPanel available={SCHEMA} />)
    expect(markup).toMatch(/7/)
    expect(markup).toMatch(/Available variables/i)
  })

  it('renders zero count for an empty schema', () => {
    const markup = renderToStaticMarkup(
      <AvailableVariablesPanel available={{ automation: {}, trigger: {}, steps: {} }} />
    )
    expect(markup).toMatch(/0|None/i)
  })

  it('renders every variable path when the panel content is visible', () => {
    const markup = renderToStaticMarkup(<AvailableVariablesPanel available={SCHEMA} />)
    expect(markup).toContain('automation.projectId')
    expect(markup).toContain('automation.workspaceId')
    expect(markup).toContain('trigger.firedAt')
    expect(markup).toContain('trigger.actorEmail')
    expect(markup).toContain('steps.cw1.worktreeId')
    expect(markup).toContain('steps.cw1.path')
    expect(markup).toContain('steps.cw1.branch')
  })

  it('renders the type next to each leaf', () => {
    const markup = renderToStaticMarkup(<AvailableVariablesPanel available={SCHEMA} />)
    expect(markup).toMatch(/projectId.*string/)
    expect(markup).toMatch(/firedAt.*number/)
  })
})
