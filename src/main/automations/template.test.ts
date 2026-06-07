import { describe, it, expect } from 'vitest'
import { resolveTemplate, blankTemplates, TemplateResolutionError } from './template'

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

  it('resolves to empty string when leaf is missing but parent exists', () => {
    expect(resolveTemplate('{{a.b.c}}', { a: { b: {} } })).toBe('')
  })

  it('throws when path breaks mid-way through non-existent objects', () => {
    expect(() => resolveTemplate('{{a.b.c}}', {})).toThrow(TemplateResolutionError)
    expect(() => resolveTemplate('{{a.b.c}}', { a: 'not-an-object' })).toThrow(
      TemplateResolutionError
    )
  })

  it('preserves whitespace and surrounding text', () => {
    expect(resolveTemplate('  {{x}}  ', { x: 'y' })).toBe('  y  ')
  })

  it('allows escaping with a doubled brace (literal {{)', () => {
    expect(resolveTemplate('use \\{{literal}} for braces', {})).toBe('use {{literal}} for braces')
  })

  it('resolves null/undefined leaf values to empty string', () => {
    expect(resolveTemplate('{{x}}', { x: null })).toBe('')
    expect(resolveTemplate('{{x}}', { x: undefined })).toBe('')
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

  it('TemplateResolutionError carries the failing path for broken paths', () => {
    try {
      resolveTemplate('{{a.b.c}}', {})
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateResolutionError)
      expect((err as TemplateResolutionError).path).toBe('a.b.c')
    }
  })

  it('resolves skipped step output fields to empty string', () => {
    const context = { steps: { 'find-real-bugs': {} } }
    expect(resolveTemplate('{{steps.find-real-bugs.outputTail}}', context)).toBe('')
  })

  it('throws for references to non-existent step IDs', () => {
    const context = { steps: {} }
    expect(() => resolveTemplate('{{steps.nonexistent.outputTail}}', context)).toThrow(
      TemplateResolutionError
    )
  })
})

describe('blankTemplates', () => {
  it('blanks a token surrounded by text', () => {
    expect(blankTemplates('a/{{x}}/b')).toBe('a//b')
  })

  it('blanks a whole-string token to empty', () => {
    expect(blankTemplates('{{trigger.http.id}}')).toBe('')
  })

  it('preserves an escaped brace as a literal (does not blank it)', () => {
    expect(blankTemplates('\\{{x}}')).toBe('{{x}}')
  })

  it('blanks every token when multiple appear in one string', () => {
    expect(blankTemplates('{{a}}-{{b}}')).toBe('-')
  })

  it('leaves plain strings unchanged', () => {
    expect(blankTemplates('hello world')).toBe('hello world')
  })
})
