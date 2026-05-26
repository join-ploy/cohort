import { describe, it, expect } from 'vitest'
import {
  generateDefaultStepId,
  isValidStepId,
  renameStepWithRewrites,
  reorderSteps,
  detectFutureReferences,
  flattenSteps,
  groupStepAt,
  ungroupStep,
  reorderWithinGroup,
  type ChainDraft
} from './chain-editor-state'
import type { Step, StepOrGroup } from '../../../shared/automations-types'

const baseDraft: ChainDraft = {
  id: 'a1',
  name: 'test',
  projectId: 'p',
  trigger: { kind: 'manual' },
  enabled: true,
  steps: [],
  autoTriggers: []
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
    expect((next[0] as Step).id).toBe('create-wt')
    expect(((next[1] as Step).config as { worktreeRef: string }).worktreeRef).toBe(
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
    expect(reorderSteps(steps, 0, 2).map((s) => (s as Step).id)).toEqual(['b', 'c', 'a'])
    expect(reorderSteps(steps, 2, 0).map((s) => (s as Step).id)).toEqual(['c', 'a', 'b'])
  })

  it('returns a new array (does not mutate the input)', () => {
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
    const next = reorderSteps(steps, 0, 1)
    expect(next).not.toBe(steps)
    expect(steps.map((s) => s.id)).toEqual(['a', 'b'])
  })

  // Why: reorder doesn't try to rewrite template references — instead the
  // editor's validator (detectFutureReferences via computeAllErrors) must
  // surface the now-invalid forward reference so the chain can't be saved
  // silently. Asserting that contract here keeps the two functions honest as
  // a unit, since a future refactor to either side could break it.
  it('after reorder, detectFutureReferences flags a now-invalid forward reference', () => {
    const steps: Step[] = [
      {
        id: 'producer',
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
        id: 'consumer',
        kind: 'run-prompt',
        config: {
          worktreeRef: '{{steps.producer.worktreeId}}',
          agentId: 'claude',
          prompt: '',
          doneDebounceSeconds: 15
        } as never,
        onFailure: 'halt',
        timeoutSeconds: null
      }
    ]
    // Initial order: consumer is after producer → no violations.
    expect(detectFutureReferences(steps)).toEqual([])

    // Move consumer to index 0 → producer now follows it → forward reference.
    const reordered = reorderSteps(steps, 1, 0)
    const violations = detectFutureReferences(reordered)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ fromStepId: 'consumer', toStepId: 'producer' })
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

describe('detectFutureReferences with parallel groups', () => {
  it('flags a sibling reference within a parallel group', () => {
    const a: Step = {
      id: 'a',
      kind: 'run-prompt',
      config: {
        worktreeRef: '{{steps.b.paneKey}}',
        agentId: 'claude',
        prompt: '',
        doneDebounceSeconds: 5
      } as never,
      onFailure: 'halt',
      timeoutSeconds: null
    }
    const b: Step = {
      id: 'b',
      kind: 'run-prompt',
      config: {} as never,
      onFailure: 'halt',
      timeoutSeconds: null
    }
    const steps: StepOrGroup[] = [[a, b]]
    const violations = detectFutureReferences(steps)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ fromStepId: 'a', toStepId: 'b' })
  })

  it('allows referencing a group member from a step after the group', () => {
    const a: Step = {
      id: 'a',
      kind: 'run-prompt',
      config: {} as never,
      onFailure: 'halt',
      timeoutSeconds: null
    }
    const b: Step = {
      id: 'b',
      kind: 'run-prompt',
      config: {} as never,
      onFailure: 'halt',
      timeoutSeconds: null
    }
    const c: Step = {
      id: 'c',
      kind: 'run-prompt',
      config: {
        worktreeRef: '{{steps.a.paneKey}}',
        agentId: 'claude',
        prompt: '',
        doneDebounceSeconds: 5
      } as never,
      onFailure: 'halt',
      timeoutSeconds: null
    }
    const steps: StepOrGroup[] = [[a, b], c]
    expect(detectFutureReferences(steps)).toEqual([])
  })
})

describe('flattenSteps', () => {
  const makeStep = (id: string): Step => ({
    id,
    kind: 'run-prompt',
    config: {} as never,
    onFailure: 'halt',
    timeoutSeconds: null
  })

  it('returns the same steps for a flat array (no groups)', () => {
    const a = makeStep('a')
    const b = makeStep('b')
    const input: StepOrGroup[] = [a, b]
    expect(flattenSteps(input)).toEqual([a, b])
  })

  it('flattens parallel groups', () => {
    const a = makeStep('a')
    const b = makeStep('b')
    const c = makeStep('c')
    const d = makeStep('d')
    const input: StepOrGroup[] = [a, [b, c], d]
    expect(flattenSteps(input)).toEqual([a, b, c, d])
  })

  it('handles empty groups', () => {
    const a = makeStep('a')
    const b = makeStep('b')
    const input: StepOrGroup[] = [a, [], b]
    expect(flattenSteps(input)).toEqual([a, b])
  })

  it('returns empty for empty input', () => {
    expect(flattenSteps([])).toEqual([])
  })
})

// Shared factory for the parallel-group helpers below.
const makeStep = (id: string): Step => ({
  id,
  kind: 'run-prompt',
  config: {} as never,
  onFailure: 'halt',
  timeoutSeconds: null
})

describe('groupStepAt', () => {
  it('wraps a solo step into a parallel group with a new step', () => {
    const a = makeStep('a')
    const b = makeStep('b')
    const n = makeStep('n')
    const input: StepOrGroup[] = [a, b]
    const result = groupStepAt(input, 0, n)
    expect(result).toEqual([[a, n], b])
  })

  it('appends to an existing parallel group', () => {
    const a = makeStep('a')
    const b = makeStep('b')
    const n = makeStep('n')
    const input: StepOrGroup[] = [[a, b]]
    const result = groupStepAt(input, 0, n)
    expect(result).toEqual([[a, b, n]])
  })

  it('does not mutate the input array', () => {
    const a = makeStep('a')
    const b = makeStep('b')
    const n = makeStep('n')
    const input: StepOrGroup[] = [a, b]
    const result = groupStepAt(input, 0, n)
    expect(result).not.toBe(input)
    expect(input).toEqual([a, b])
  })
})

describe('ungroupStep', () => {
  it('removes a step from a 2-step group and auto-unwraps to solo', () => {
    const a = makeStep('a')
    const b = makeStep('b')
    const input: StepOrGroup[] = [[a, b]]
    const result = ungroupStep(input, 0, 0)
    expect(result).toEqual([b])
  })

  it('keeps group intact if 2+ siblings remain after removal', () => {
    const a = makeStep('a')
    const b = makeStep('b')
    const c = makeStep('c')
    const input: StepOrGroup[] = [[a, b, c]]
    const result = ungroupStep(input, 0, 1)
    expect(result).toEqual([[a, c]])
  })

  it('no-op if target is not a group', () => {
    const a = makeStep('a')
    const input: StepOrGroup[] = [a]
    const result = ungroupStep(input, 0, 0)
    expect(result).toEqual([a])
  })

  it('does not mutate the input array', () => {
    const a = makeStep('a')
    const b = makeStep('b')
    const input: StepOrGroup[] = [[a, b]]
    const result = ungroupStep(input, 0, 0)
    expect(result).not.toBe(input)
    expect(input).toEqual([[a, b]])
  })
})

describe('reorderWithinGroup', () => {
  it('reorders siblings within a parallel group', () => {
    const a = makeStep('a')
    const b = makeStep('b')
    const c = makeStep('c')
    const input: StepOrGroup[] = [[a, b, c]]
    const result = reorderWithinGroup(input, 0, 0, 2)
    expect(result).toEqual([[b, c, a]])
  })

  it('no-op if target is not a group', () => {
    const a = makeStep('a')
    const input: StepOrGroup[] = [a]
    const result = reorderWithinGroup(input, 0, 0, 0)
    expect(result).toEqual([a])
  })

  it('does not mutate the input array', () => {
    const a = makeStep('a')
    const b = makeStep('b')
    const c = makeStep('c')
    const input: StepOrGroup[] = [[a, b, c]]
    const result = reorderWithinGroup(input, 0, 0, 2)
    expect(result).not.toBe(input)
    expect(input).toEqual([[a, b, c]])
  })
})
