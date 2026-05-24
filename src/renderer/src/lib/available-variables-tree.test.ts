import { describe, it, expect } from 'vitest'
import { buildPaths } from './available-variables-tree'
import type { AvailableVariables } from './template-dry-run'

describe('buildPaths', () => {
  it('flattens automation and steps and walks trigger recursively', () => {
    const schema: AvailableVariables = {
      automation: { projectId: 'string' },
      trigger: {
        firedAt: 'number',
        linear: {
          issue: {
            id: 'string',
            title: 'string'
          }
        }
      },
      steps: {
        cw1: { worktreeId: 'string' }
      }
    }
    const paths = buildPaths(schema)
    const dotted = paths.map((p) => p.path)
    expect(dotted).toContain('automation.projectId')
    expect(dotted).toContain('trigger.firedAt')
    expect(dotted).toContain('trigger.linear.issue.id')
    expect(dotted).toContain('trigger.linear.issue.title')
    expect(dotted).toContain('steps.cw1.worktreeId')
  })

  it('tags every trigger entry with the trigger namespace', () => {
    const schema: AvailableVariables = {
      automation: {},
      trigger: {
        worktreeId: 'string',
        linear: { issue: { id: 'string' } }
      },
      steps: {}
    }
    const paths = buildPaths(schema)
    for (const entry of paths) {
      expect(entry.namespace).toBe('trigger')
    }
    expect(paths.map((p) => p.path).sort()).toEqual(
      ['trigger.linear.issue.id', 'trigger.worktreeId'].sort()
    )
  })

  it('exposes leaf type on nested trigger entries', () => {
    const schema: AvailableVariables = {
      automation: {},
      trigger: { linear: { issue: { priority: 'number', title: 'string' } } },
      steps: {}
    }
    const paths = buildPaths(schema)
    const priority = paths.find((p) => p.path === 'trigger.linear.issue.priority')
    const title = paths.find((p) => p.path === 'trigger.linear.issue.title')
    expect(priority?.type).toBe('number')
    expect(priority?.leaf).toBe('priority')
    expect(title?.type).toBe('string')
  })

  it('returns no trigger entries for an empty trigger schema', () => {
    const schema: AvailableVariables = {
      automation: { projectId: 'string' },
      trigger: {},
      steps: {}
    }
    const paths = buildPaths(schema)
    expect(paths.filter((p) => p.namespace === 'trigger')).toEqual([])
  })

  it('walks the optional group namespace recursively', () => {
    const schema: AvailableVariables = {
      automation: {},
      trigger: {},
      steps: {},
      group: {
        id: 'string',
        parentPath: 'string',
        members: {
          orca: {
            worktreeId: 'string',
            scoped: 'string'
          }
        }
      }
    }
    const paths = buildPaths(schema)
    const dotted = paths.map((p) => p.path).sort()
    expect(dotted).toEqual(
      [
        'group.id',
        'group.parentPath',
        'group.members.orca.worktreeId',
        'group.members.orca.scoped'
      ].sort()
    )
    for (const entry of paths) {
      expect(entry.namespace).toBe('group')
    }
  })

  it('omits the group namespace when absent', () => {
    const schema: AvailableVariables = {
      automation: {},
      trigger: {},
      steps: {}
    }
    const paths = buildPaths(schema)
    expect(paths.filter((p) => p.namespace === 'group')).toEqual([])
  })
})
