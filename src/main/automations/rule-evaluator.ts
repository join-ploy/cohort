import type { Condition, Rule } from '../../shared/automations-types'
import type { CandidateEvent } from './trigger-sources/types'

export function evalCondition(condition: Condition, actual: unknown): boolean {
  const { op, value } = condition
  switch (op) {
    case 'is':
      return actual === value
    case 'is-not':
      return actual !== value
    case 'is-any-of':
      return Array.isArray(value) && value.includes(actual as never)
    case 'is-none-of':
      return Array.isArray(value) && !value.includes(actual as never)
    case 'contains-any':
      return (
        Array.isArray(actual) &&
        Array.isArray(value) &&
        actual.some((v) => (value as unknown[]).includes(v))
      )
    case 'contains-all':
      return (
        Array.isArray(actual) &&
        Array.isArray(value) &&
        (value as unknown[]).every((v) => actual.includes(v))
      )
    case 'contains-none':
      return (
        Array.isArray(actual) &&
        Array.isArray(value) &&
        (value as unknown[]).every((v) => !actual.includes(v))
      )
    case 'gte':
      return typeof actual === 'number' && actual >= (value as number)
    case 'lte':
      return typeof actual === 'number' && actual <= (value as number)
    case 'eq':
      return actual === value
  }
}

export function evaluateRule(rule: Rule, event: CandidateEvent): boolean {
  return rule.conditions.every((c) => evalCondition(c, event.fields[c.field]))
}

export function firstMatch(rules: Rule[], event: CandidateEvent): Rule | undefined {
  return rules.find((r) => evaluateRule(r, event))
}
