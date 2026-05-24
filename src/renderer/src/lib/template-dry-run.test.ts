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

  it('walks nested trigger paths correctly', () => {
    const schema: AvailableVariables = {
      automation: {},
      trigger: {
        firedAt: 'number',
        linear: { issue: { id: 'string', title: 'string' } }
      },
      steps: {}
    }
    expect(dryRunTemplate('{{trigger.linear.issue.title}}', schema)).toEqual([])
    expect(dryRunTemplate('{{trigger.firedAt}}', schema)).toEqual([])
  })

  it('flags traversal past a leaf in trigger', () => {
    const schema: AvailableVariables = {
      automation: {},
      trigger: { firedAt: 'number' },
      steps: {}
    }
    const errors = dryRunTemplate('{{trigger.firedAt.foo}}', schema)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'unknown-path' })
  })

  it('flags unknown nested key in trigger', () => {
    const schema: AvailableVariables = {
      automation: {},
      trigger: { linear: { issue: { id: 'string' } } },
      steps: {}
    }
    const errors = dryRunTemplate('{{trigger.linear.issue.missing}}', schema)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'unknown-path' })
  })

  describe('group namespace', () => {
    const WITH_GROUP: AvailableVariables = {
      automation: {},
      trigger: {},
      steps: {},
      group: {
        id: 'string',
        parentPath: 'string',
        members: {
          orca: {
            worktreeId: 'string',
            path: 'string',
            repoId: 'string',
            scoped: 'string'
          }
        }
      }
    }

    it('accepts top-level group paths when the namespace is in scope', () => {
      expect(dryRunTemplate('{{group.id}}', WITH_GROUP)).toEqual([])
      expect(dryRunTemplate('{{group.parentPath}}', WITH_GROUP)).toEqual([])
    })

    it('accepts per-member group paths when the namespace is in scope', () => {
      expect(dryRunTemplate('{{group.members.orca.scoped}}', WITH_GROUP)).toEqual([])
      expect(dryRunTemplate('{{group.members.orca.worktreeId}}', WITH_GROUP)).toEqual([])
    })

    it('rejects group paths when the namespace is absent', () => {
      const schema: AvailableVariables = {
        automation: {},
        trigger: {},
        steps: {}
      }
      const errors = dryRunTemplate('{{group.members.orca.scoped}}', schema)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({ code: 'unknown-path' })
    })

    it('flags an unknown member key under group.members', () => {
      const errors = dryRunTemplate('{{group.members.unknown.scoped}}', WITH_GROUP)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({ code: 'unknown-path' })
    })

    it('flags an unknown leaf on a known member', () => {
      const errors = dryRunTemplate('{{group.members.orca.bogus}}', WITH_GROUP)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({ code: 'unknown-path' })
    })

    it('flags bare {{group}} as not a leaf', () => {
      const errors = dryRunTemplate('{{group}}', WITH_GROUP)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({ code: 'unknown-path' })
    })
  })
})
