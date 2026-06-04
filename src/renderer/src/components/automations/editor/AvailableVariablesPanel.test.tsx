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

  it('renders a description under each non-step variable', () => {
    const markup = renderToStaticMarkup(<AvailableVariablesPanel available={SCHEMA} />)
    expect(markup).toContain('ID of the project this automation runs in')
    expect(markup).toContain('Email of the person who triggered the run')
  })

  it('renders kind-specific descriptions for step outputs', () => {
    const schema: AvailableVariables = {
      ...SCHEMA,
      steps: { cw1: { worktreeId: 'string' } },
      stepKinds: { cw1: 'create-worktree' }
    }
    const markup = renderToStaticMarkup(<AvailableVariablesPanel available={schema} />)
    expect(markup).toContain('ID of the newly created worktree')
  })

  it('renders a Group section with member paths when the group namespace is present', () => {
    const schema: AvailableVariables = {
      automation: {},
      trigger: {},
      steps: {},
      group: {
        id: 'string',
        parentPath: 'string',
        members: {
          orca: { worktreeId: 'string', scoped: 'string' }
        }
      }
    }
    const markup = renderToStaticMarkup(<AvailableVariablesPanel available={schema} />)
    expect(markup).toMatch(/Group/)
    expect(markup).toContain('group.id')
    expect(markup).toContain('group.parentPath')
    expect(markup).toContain('group.members.orca.scoped')
    expect(markup).toContain('group.members.orca.worktreeId')
  })

  it('omits the Group section when the namespace is absent', () => {
    const markup = renderToStaticMarkup(<AvailableVariablesPanel available={SCHEMA} />)
    // Why: the SCHEMA fixture has no group key, so no Group header should render.
    expect(markup).not.toMatch(/>Group</)
  })
})
