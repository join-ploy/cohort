import { describe, it, expect } from 'vitest'
import { resolveTemplate, TemplateResolutionError } from './template'

describe('resolveTemplate', () => {
  it('returns the input when no template tokens are present', () => {
    expect(resolveTemplate('hello world', {})).toBe('hello world')
  })

  it('substitutes a single token', () => {
    expect(resolveTemplate('hi {{name}}', { name: 'Mike' })).toBe('hi Mike')
  })

  it('substitutes nested paths', () => {
    expect(
      resolveTemplate('{{trigger.linear.issue.title}}', {
        trigger: { linear: { issue: { title: 'Fix X' } } }
      })
    ).toBe('Fix X')
  })

  it('coerces numbers and booleans to strings', () => {
    expect(resolveTemplate('{{n}} {{b}}', { n: 42, b: true })).toBe('42 true')
  })

  it('throws with the failing path for unresolved references', () => {
    expect(() => resolveTemplate('{{a.b.c}}', { a: { b: {} } })).toThrow(TemplateResolutionError)
    expect(() => resolveTemplate('{{a.b.c}}', { a: { b: {} } })).toThrow(/a\.b\.c/)
  })

  it('preserves whitespace and surrounding text', () => {
    expect(resolveTemplate('  {{x}}  ', { x: 'y' })).toBe('  y  ')
  })

  it('allows escaping with a doubled brace (literal {{)', () => {
    expect(resolveTemplate('use \\{{literal}} for braces', {})).toBe('use {{literal}} for braces')
  })

  it('rejects null/undefined values as unresolved', () => {
    expect(() => resolveTemplate('{{x}}', { x: null })).toThrow(TemplateResolutionError)
    expect(() => resolveTemplate('{{x}}', { x: undefined })).toThrow(TemplateResolutionError)
  })
})
