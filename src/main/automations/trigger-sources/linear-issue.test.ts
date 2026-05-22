import { describe, it, expect } from 'vitest'
import { makeLinearIssueSource } from './linear-issue'

describe('linearIssueSource.fieldCatalog', () => {
  it('exposes the four expected fields in order', () => {
    const source = makeLinearIssueSource({ client: null })
    const fields = source.fieldCatalog.map((d) => d.field)
    expect(fields).toEqual(['linear.assignee', 'linear.tag', 'linear.state', 'linear.priority'])
  })

  it('priority field exposes eq / is-any-of / gte / lte', () => {
    const source = makeLinearIssueSource({ client: null })
    const p = source.fieldCatalog.find((d) => d.field === 'linear.priority')!
    expect(p.ops).toEqual(expect.arrayContaining(['eq', 'is-any-of', 'gte', 'lte']))
    expect(p.valueKind).toBe('priority')
  })

  it('assignee field exposes is / is-not / is-any-of / is-none-of', () => {
    const source = makeLinearIssueSource({ client: null })
    const a = source.fieldCatalog.find((d) => d.field === 'linear.assignee')!
    expect(a.ops).toEqual(expect.arrayContaining(['is', 'is-not', 'is-any-of', 'is-none-of']))
    expect(a.valueKind).toBe('user')
  })

  it('tag field exposes contains-any / contains-all / contains-none', () => {
    const source = makeLinearIssueSource({ client: null })
    const t = source.fieldCatalog.find((d) => d.field === 'linear.tag')!
    expect(t.ops).toEqual(expect.arrayContaining(['contains-any', 'contains-all', 'contains-none']))
    expect(t.valueKind).toBe('label')
  })

  it('state field exposes is / is-any-of / is-none-of', () => {
    const source = makeLinearIssueSource({ client: null })
    const s = source.fieldCatalog.find((d) => d.field === 'linear.state')!
    expect(s.ops).toEqual(expect.arrayContaining(['is', 'is-any-of', 'is-none-of']))
    expect(s.valueKind).toBe('state')
  })

  it('id is "linear-issue" and displayName is "Linear issue"', () => {
    const source = makeLinearIssueSource({ client: null })
    expect(source.id).toBe('linear-issue')
    expect(source.displayName).toBe('Linear issue')
  })
})
