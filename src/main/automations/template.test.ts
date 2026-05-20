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

  it('rejects plain objects as non-primitive', () => {
    expect(() => resolveTemplate('{{x}}', { x: { a: 1 } })).toThrow(TemplateResolutionError)
    expect(() => resolveTemplate('{{x}}', { x: { a: 1 } })).toThrow(
      /only string, number, and boolean/
    )
  })

  it('rejects arrays as non-primitive', () => {
    expect(() => resolveTemplate('{{x}}', { x: [1, 2, 3] })).toThrow(TemplateResolutionError)
    expect(() => resolveTemplate('{{x}}', { x: [1, 2, 3] })).toThrow(/an array/)
  })

  it('rejects Date instances as non-primitive', () => {
    expect(() => resolveTemplate('{{x}}', { x: new Date(0) })).toThrow(TemplateResolutionError)
  })

  it('rejects empty tokens like {{}}', () => {
    expect(() => resolveTemplate('{{}}', {})).toThrow(TemplateResolutionError)
    expect(() => resolveTemplate('{{}}', {})).toThrow(/empty token/)
  })

  it('rejects whitespace-only tokens like {{   }}', () => {
    expect(() => resolveTemplate('{{   }}', {})).toThrow(TemplateResolutionError)
    expect(() => resolveTemplate('{{   }}', {})).toThrow(/empty token/)
  })

  it('TemplateResolutionError carries the failing path', () => {
    try {
      resolveTemplate('{{a.b.c}}', { a: { b: {} } })
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateResolutionError)
      expect((err as TemplateResolutionError).path).toBe('a.b.c')
    }
  })
})
