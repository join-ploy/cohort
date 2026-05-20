import { describe, it, expect } from 'vitest'
import { dryRunTemplate, type AvailableVariables } from './template-dry-run'

const SCHEMA: AvailableVariables = {
  automation: {
    projectId: 'string',
    workspaceId: 'string'
  },
  trigger: {
    firedAt: 'number',
    actorEmail: 'string'
  },
  steps: {
    'create-worktree-1': {
      worktreeId: 'string',
      path: 'string',
      branch: 'string'
    }
  }
}

describe('dryRunTemplate', () => {
  it('returns no errors for a template with all valid references', () => {
    expect(dryRunTemplate('hello {{trigger.actorEmail}}', SCHEMA)).toEqual([])
    expect(dryRunTemplate('wt={{steps.create-worktree-1.worktreeId}}', SCHEMA)).toEqual([])
  })

  it('returns no errors for templates with no tokens', () => {
    expect(dryRunTemplate('plain text', SCHEMA)).toEqual([])
  })

  it('flags unknown top-level paths', () => {
    const errors = dryRunTemplate('{{foo}}', SCHEMA)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ path: 'foo', code: 'unknown-path' })
  })

  it('flags unknown nested paths', () => {
    const errors = dryRunTemplate('{{automation.foo}}', SCHEMA)
    expect(errors[0]).toMatchObject({ path: 'automation.foo', code: 'unknown-path' })
  })

  it('flags unknown step output keys', () => {
    const errors = dryRunTemplate('{{steps.create-worktree-1.foo}}', SCHEMA)
    expect(errors[0]).toMatchObject({
      path: 'steps.create-worktree-1.foo',
      code: 'unknown-path'
    })
  })

  it('flags references to a step not in scope', () => {
    const errors = dryRunTemplate('{{steps.run-prompt-2.paneKey}}', SCHEMA)
    expect(errors[0]).toMatchObject({
      path: 'steps.run-prompt-2.paneKey',
      code: 'unknown-step'
    })
  })

  it('flags empty tokens', () => {
    const errors = dryRunTemplate('hello {{}} world', SCHEMA)
    expect(errors[0]).toMatchObject({ code: 'empty-token' })
  })

  it('flags whitespace-only tokens with the same error', () => {
    const errors = dryRunTemplate('{{   }}', SCHEMA)
    expect(errors[0]).toMatchObject({ code: 'empty-token' })
  })

  it('returns ALL errors, not just the first', () => {
    const errors = dryRunTemplate('{{foo}} {{bar.baz}}', SCHEMA)
    expect(errors).toHaveLength(2)
  })

  it('respects the escape sequence — \\{{ is a literal', () => {
    expect(dryRunTemplate('\\{{not-a-token}}', SCHEMA)).toEqual([])
  })
})
