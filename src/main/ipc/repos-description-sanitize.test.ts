/**
 * Unit tests for `sanitizeRepoDescription` — the IPC-boundary sanitizer that
 * normalizes user-authored Repo.description before it lands in persisted
 * state. The description gets dumped into automation prompts via
 * `group.members.<repo>.description`, so the sanitizer must be paranoid about
 * control chars and bidi-override escapes the same way
 * `sanitizeWorktreeDisplayName` is for worktree titles.
 *
 * No length cap: descriptions are local-only and may be paragraphs. Newlines
 * and tabs survive on purpose so users can structure the prose; only the
 * other C0/C1 control bytes get neutralized.
 */

import { describe, expect, it } from 'vitest'
import { sanitizeRepoDescription } from './repos'

describe('sanitizeRepoDescription', () => {
  it('trims leading and trailing whitespace', () => {
    expect(sanitizeRepoDescription('   hello   ')).toBe('hello')
  })

  it('preserves internal whitespace including multiple spaces', () => {
    // Why: the sanitizer used to collapse `\s+` runs, which destroyed
    // paragraph structure. We now treat the user-typed prose as-is.
    expect(sanitizeRepoDescription('a   b c')).toBe('a   b c')
  })

  it('preserves newlines so multi-line descriptions survive', () => {
    expect(sanitizeRepoDescription('line one\nline two')).toBe('line one\nline two')
    expect(sanitizeRepoDescription('para one\n\npara two')).toBe('para one\n\npara two')
  })

  it('preserves tabs', () => {
    expect(sanitizeRepoDescription('col1\tcol2')).toBe('col1\tcol2')
  })

  it('replaces non-newline non-tab C0 control chars with spaces', () => {
    expect(sanitizeRepoDescription('bell\x07alert')).toBe('bell alert')
  })

  it('replaces C1 control chars (0x7f–0x9f) with spaces', () => {
    expect(sanitizeRepoDescription('a\x7fb\x9fc')).toBe('a b c')
  })

  it('strips bidi-override controls (LRO/RLO/PDF/LRI/RLI/FSI/PDI)', () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE — classic display-spoofing vector.
    expect(sanitizeRepoDescription('Hello‮World')).toBe('HelloWorld')
    // U+2066 LEFT-TO-RIGHT ISOLATE + U+2069 POP DIRECTIONAL ISOLATE.
    expect(sanitizeRepoDescription('A⁦B⁩C')).toBe('ABC')
  })

  it('does not cap long input', () => {
    const long = 'x'.repeat(5000)
    const result = sanitizeRepoDescription(long)
    expect(result).toBe(long)
  })

  it('returns undefined when the input is empty', () => {
    expect(sanitizeRepoDescription('')).toBeUndefined()
  })

  it('returns undefined when the input collapses to whitespace + bidi only', () => {
    // Bidi overrides + whitespace only — nothing displayable left after
    // stripping. Treating this as "no description" lets the IPC layer drop
    // the key from the patch so persisted state stays clean.
    expect(sanitizeRepoDescription('   ‮⁦  ')).toBeUndefined()
  })

  it('preserves Unicode letters (CJK, accented Latin, emoji)', () => {
    // Why: descriptions are user-authored prose; only attacker-controlled
    // bytes (bidi, control chars) need stripping. Real text should pass
    // through cleanly.
    expect(sanitizeRepoDescription('日本語の説明')).toBe('日本語の説明')
    expect(sanitizeRepoDescription('café')).toBe('café')
    expect(sanitizeRepoDescription('  ship it 🚀  ')).toBe('ship it 🚀')
  })
})
