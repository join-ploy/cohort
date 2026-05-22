import { describe, it, expect } from 'vitest'
import { evalCondition, evaluateRule, firstMatch } from './rule-evaluator'
import type { Condition, Rule } from '../../shared/automations-types'
import type { CandidateEvent } from './trigger-sources/types'

const C = (op: Condition['op'], value: Condition['value']): Condition => ({
  field: 'x',
  op,
  value
})

describe('evalCondition', () => {
  it('is / is-not equality and inequality', () => {
    expect(evalCondition(C('is', 'a'), 'a')).toBe(true)
    expect(evalCondition(C('is', 'a'), 'b')).toBe(false)
    expect(evalCondition(C('is-not', 'a'), 'b')).toBe(true)
    expect(evalCondition(C('is-not', 'a'), 'a')).toBe(false)
  })

  it('is / is-not against undefined/null actuals are well-behaved', () => {
    expect(evalCondition(C('is', 'a'), undefined)).toBe(false)
    expect(evalCondition(C('is', 'a'), null)).toBe(false)
    // is-not vs undefined: 'a' !== undefined is TRUE
    expect(evalCondition(C('is-not', 'a'), undefined)).toBe(true)
  })

  it('is-any-of returns true when value contains actual', () => {
    expect(evalCondition(C('is-any-of', ['a', 'b']), 'a')).toBe(true)
    expect(evalCondition(C('is-any-of', ['a', 'b']), 'c')).toBe(false)
  })

  it('is-any-of: empty value array never matches', () => {
    expect(evalCondition(C('is-any-of', []), 'a')).toBe(false)
  })

  it('is-none-of returns true when value does NOT contain actual', () => {
    expect(evalCondition(C('is-none-of', ['a', 'b']), 'c')).toBe(true)
    expect(evalCondition(C('is-none-of', ['a', 'b']), 'a')).toBe(false)
  })

  it('is-none-of: empty value array always matches (vacuously)', () => {
    expect(evalCondition(C('is-none-of', []), 'a')).toBe(true)
  })

  it('contains-any against array actuals', () => {
    expect(evalCondition(C('contains-any', ['x']), ['a', 'x'])).toBe(true)
    expect(evalCondition(C('contains-any', ['x']), ['a'])).toBe(false)
  })

  it('contains-any: non-array actual is false', () => {
    expect(evalCondition(C('contains-any', ['x']), undefined)).toBe(false)
    expect(evalCondition(C('contains-any', ['x']), 'x')).toBe(false)
    expect(evalCondition(C('contains-any', ['x']), null)).toBe(false)
  })

  it('contains-all', () => {
    expect(evalCondition(C('contains-all', ['a', 'b']), ['a', 'b', 'c'])).toBe(true)
    expect(evalCondition(C('contains-all', ['a', 'b']), ['a'])).toBe(false)
    expect(evalCondition(C('contains-all', []), ['a'])).toBe(true) // vacuous
  })

  it('contains-none', () => {
    expect(evalCondition(C('contains-none', ['x']), ['a', 'b'])).toBe(true)
    expect(evalCondition(C('contains-none', ['x']), ['a', 'x'])).toBe(false)
    expect(evalCondition(C('contains-none', []), ['a'])).toBe(true) // vacuous
  })

  it('gte / lte / eq numeric', () => {
    expect(evalCondition(C('gte', 2), 3)).toBe(true)
    expect(evalCondition(C('gte', 2), 2)).toBe(true)
    expect(evalCondition(C('gte', 2), 1)).toBe(false)
    expect(evalCondition(C('lte', 2), 2)).toBe(true)
    expect(evalCondition(C('lte', 2), 3)).toBe(false)
    expect(evalCondition(C('eq', 0), 0)).toBe(true)
    expect(evalCondition(C('eq', 0), null)).toBe(false)
  })

  it('gte / lte: non-number actuals are false (no coercion)', () => {
    expect(evalCondition(C('gte', 2), '3')).toBe(false)
    expect(evalCondition(C('gte', 2), null)).toBe(false)
    expect(evalCondition(C('gte', 2), undefined)).toBe(false)
    expect(evalCondition(C('lte', 2), '1')).toBe(false)
  })
})

const makeEvent = (fields: Record<string, unknown>): CandidateEvent => ({
  entityId: 'e',
  updatedAt: 0,
  payload: {},
  fields
})

describe('evaluateRule', () => {
  it('AND across all conditions', () => {
    const r: Rule = {
      id: 'r',
      projectId: 'p',
      conditions: [
        { field: 'a', op: 'is', value: 1 },
        { field: 'b', op: 'is', value: 2 }
      ]
    }
    expect(evaluateRule(r, makeEvent({ a: 1, b: 2 }))).toBe(true)
    expect(evaluateRule(r, makeEvent({ a: 1, b: 3 }))).toBe(false)
    expect(evaluateRule(r, makeEvent({ a: 1 }))).toBe(false)
  })

  it('empty conditions always match', () => {
    const r: Rule = { id: 'r', projectId: 'p', conditions: [] }
    expect(evaluateRule(r, makeEvent({}))).toBe(true)
  })
})

describe('firstMatch', () => {
  it('returns the first matching rule (order matters)', () => {
    const rules: Rule[] = [
      { id: 'r1', projectId: 'p1', conditions: [{ field: 'a', op: 'is', value: 2 }] },
      { id: 'r2', projectId: 'p2', conditions: [{ field: 'a', op: 'is', value: 1 }] },
      { id: 'r3', projectId: 'p3', conditions: [{ field: 'a', op: 'is', value: 1 }] }
    ]
    expect(firstMatch(rules, makeEvent({ a: 1 }))?.id).toBe('r2')
  })

  it('returns undefined when no rule matches', () => {
    expect(firstMatch([], makeEvent({}))).toBeUndefined()
    const rules: Rule[] = [
      { id: 'r1', projectId: 'p1', conditions: [{ field: 'a', op: 'is', value: 2 }] }
    ]
    expect(firstMatch(rules, makeEvent({ a: 1 }))).toBeUndefined()
  })
})
