import { describe, it, expect } from 'vitest'
import {
  generateDefaultStepId,
  isValidStepId,
  renameStepWithRewrites,
  reorderSteps,
  detectFutureReferences,
  type ChainDraft
} from './chain-editor-state'
import type { Step } from '../../../shared/automations-types'

const baseDraft: ChainDraft = {
  id: 'a1',
  name: 'test',
  projectId: 'p',
  trigger: { kind: 'manual' },
  enabled: true,
  steps: []
}

// Reference baseDraft so the unused-var lint stays quiet — the const is here
// to document the shape the editor reducer seeds from.
void baseDraft

describe('generateDefaultStepId', () => {
  it('uses kind + counter starting at 1 in an empty chain', () => {
    expect(generateDefaultStepId('create-worktree', [])).toBe('create-worktree-1')
  })

  it('increments past existing ids of the same kind', () => {
    const steps: Step[] = [
      {
        id: 'create-worktree-1',
        kind: 'create-worktree',
        config: {} as never,
        onFailure: 'halt',
        timeoutSeconds: null
      },
      {
        id: 'create-worktree-2',
        kind: 'create-worktree',
        config: {} as never,
        onFailure: 'halt',
        timeoutSeconds: null
      }
    ]
    expect(generateDefaultStepId('create-worktree', steps)).toBe('create-worktree-3')
  })

  it('does not collide with renamed step ids of the same prefix', () => {
    const steps: Step[] = [
      {
        id: 'create-worktree-1',
        kind: 'run-prompt',
        config: {} as never,
        onFailure: 'halt',
        timeoutSeconds: null
      }
    ]
    expect(generateDefaultStepId('create-worktree', steps)).toBe('create-worktree-2')
  })
})

describe('isValidStepId', () => {
  it('accepts kebab-case', () => {
    expect(isValidStepId('create-worktree-1')).toBe(true)
    expect(isValidStepId('foo')).toBe(true)
  })
  it('rejects empty / whitespace / spaces / underscores / uppercase', () => {
    expect(isValidStepId('')).toBe(false)
    expect(isValidStepId(' foo')).toBe(false)
    expect(isValidStepId('foo bar')).toBe(false)
    expect(isValidStepId('foo_bar')).toBe(false)
    expect(isValidStepId('FooBar')).toBe(false)
  })
})

describe('renameStepWithRewrites', () => {
  it('rewrites template references in downstream steps', () => {
    const steps: Step[] = [
      {
        id: 'cw1',
        kind: 'create-worktree',
        config: {
          baseBranch: 'main',
          branchName: 'b',
          displayName: 'd',
          linkLinearIssue: false
        } as never,
        onFailure: 'halt',
        timeoutSeconds: null
      },
      {
        id: 'rp1',
        kind: 'run-prompt',
        config: {
          worktreeRef: '{{steps.cw1.worktreeId}}',
          agentId: 'claude',
          prompt: 'p',
          doneDebounceSeconds: 15
        } as never,
        onFailure: 'halt',
        timeoutSeconds: null
      }
    ]
    const next = renameStepWithRewrites(steps, 'cw1', 'create-wt')
    expect(next[0].id).toBe('create-wt')
    expect((next[1].config as { worktreeRef: string }).worktreeRef).toBe(
      '{{steps.create-wt.worktreeId}}'
    )
  })
  it('throws if the new id is invalid', () => {
    expect(() => renameStepWithRewrites([], 'cw1', 'Bad ID')).toThrow(/invalid/i)
  })
  it('throws if the new id collides with another step', () => {
    const steps: Step[] = [
      {
        id: 'a',
        kind: 'create-worktree',
        config: {} as never,
        onFailure: 'halt',
        timeoutSeconds: null
      },
      {
        id: 'b',
        kind: 'run-prompt',
        config: {} as never,
        onFailure: 'halt',
        timeoutSeconds: null
      }
    ]
    expect(() => renameStepWithRewrites(steps, 'a', 'b')).toThrow(/already in use/i)
  })
})

describe('reorderSteps', () => {
  it('moves a step from one index to another', () => {
    const steps: Step[] = [
      {
        id: 'a',
        kind: 'create-worktree',
        config: {} as never,
        onFailure: 'halt',
        timeoutSeconds: null
      },
      {
        id: 'b',
        kind: 'run-prompt',
        config: {} as never,
        onFailure: 'halt',
        timeoutSeconds: null
      },
      {
        id: 'c',
        kind: 'run-command',
        config: {} as never,
        onFailure: 'halt',
        timeoutSeconds: null
      }
    ]
    expect(reorderSteps(steps, 0, 2).map((s) => s.id)).toEqual(['b', 'c', 'a'])
    expect(reorderSteps(steps, 2, 0).map((s) => s.id)).toEqual(['c', 'a', 'b'])
  })
})

describe('detectFutureReferences', () => {
  it('returns empty for a chain with no future references', () => {
    const steps: Step[] = [
      {
        id: 'a',
        kind: 'create-worktree',
        config: {
          baseBranch: '{{trigger.actorEmail}}',
          branchName: 'b',
          displayName: 'd',
          linkLinearIssue: false
        } as never,
        onFailure: 'halt',
        timeoutSeconds: null
      },
      {
        id: 'b',
        kind: 'run-prompt',
        config: {
          worktreeRef: '{{steps.a.worktreeId}}',
          agentId: 'claude',
          prompt: '',
          doneDebounceSeconds: 15
        } as never,
        onFailure: 'halt',
        timeoutSeconds: null
      }
    ]
    expect(detectFutureReferences(steps)).toEqual([])
  })

  it('finds a step that references a later step', () => {
    const steps: Step[] = [
      {
        id: 'a',
        kind: 'create-worktree',
        config: {
          baseBranch: '{{steps.b.worktreeId}}',
          branchName: '',
          displayName: '',
          linkLinearIssue: false
        } as never,
        onFailure: 'halt',
        timeoutSeconds: null
      },
      {
        id: 'b',
        kind: 'create-worktree',
        config: {} as never,
        onFailure: 'halt',
        timeoutSeconds: null
      }
    ]
    const violations = detectFutureReferences(steps)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ fromStepId: 'a', toStepId: 'b' })
  })
})
