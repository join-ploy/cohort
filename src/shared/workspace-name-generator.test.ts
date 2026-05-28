import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WORKSPACE_NAME_PATTERN,
  generateUniqueWorkspaceName,
  suggestWorkspaceName,
  validateWorkspaceName
} from './workspace-name-generator'

describe('WORKSPACE_NAME_PATTERN', () => {
  it('matches snake_case names starting with a letter and up to 22 chars', () => {
    expect(WORKSPACE_NAME_PATTERN.test('a')).toBe(true)
    expect(WORKSPACE_NAME_PATTERN.test('wise_panther')).toBe(true) // pre-hash, still valid
    expect(WORKSPACE_NAME_PATTERN.test('wopping_ferret_a1348')).toBe(true) // hash shape
    expect(WORKSPACE_NAME_PATTERN.test('a234567890123456789012')).toBe(true) // 22 chars
  })

  it('rejects leading digit, uppercase, special chars, and over-length names', () => {
    expect(WORKSPACE_NAME_PATTERN.test('')).toBe(false)
    expect(WORKSPACE_NAME_PATTERN.test('1abc')).toBe(false)
    expect(WORKSPACE_NAME_PATTERN.test('Wise')).toBe(false)
    expect(WORKSPACE_NAME_PATTERN.test('wise-panther')).toBe(false)
    expect(WORKSPACE_NAME_PATTERN.test('wise panther')).toBe(false)
    expect(WORKSPACE_NAME_PATTERN.test('a2345678901234567890123')).toBe(false) // 23 chars
  })
})

describe('suggestWorkspaceName', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns a string matching WORKSPACE_NAME_PATTERN', () => {
    for (let i = 0; i < 50; i += 1) {
      const name = suggestWorkspaceName()
      expect(name).toMatch(WORKSPACE_NAME_PATTERN)
    }
  })

  it('uses adjective_noun_hash shape (two underscores, 5-char base36 tail)', () => {
    const name = suggestWorkspaceName()
    const parts = name.split('_')
    expect(parts.length).toBe(3)
    expect(parts[0].length).toBeGreaterThan(0)
    expect(parts[1].length).toBeGreaterThan(0)
    expect(parts[2]).toMatch(/^[a-z0-9]{5}$/)
  })
})

describe('generateUniqueWorkspaceName', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns a fresh name when nothing is taken', () => {
    const name = generateUniqueWorkspaceName(new Set())
    expect(name).toMatch(WORKSPACE_NAME_PATTERN)
  })

  it('appends _2 when the suggested name is already taken', () => {
    // Force suggestWorkspaceName to deterministically return the first word
    // of each list — the generator uses Math.random under the hood.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const first = suggestWorkspaceName() // e.g. "wise_otter"
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const taken = new Set([first])
    expect(generateUniqueWorkspaceName(taken)).toBe(`${first}_2`)
  })

  it('appends _3 when both base and _2 are taken', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const first = suggestWorkspaceName()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const taken = new Set([first, `${first}_2`])
    expect(generateUniqueWorkspaceName(taken)).toBe(`${first}_3`)
  })
})

describe('validateWorkspaceName', () => {
  it('returns null for valid names', () => {
    expect(validateWorkspaceName('wise_panther', new Set())).toBeNull()
    expect(validateWorkspaceName('a', new Set())).toBeNull()
    expect(validateWorkspaceName('wopping_ferret_a1348', new Set())).toBeNull()
    expect(validateWorkspaceName('a234567890123456789012', new Set())).toBeNull()
  })

  it('rejects empty strings', () => {
    expect(validateWorkspaceName('', new Set())).toBeTruthy()
  })

  it('rejects names starting with a digit', () => {
    expect(validateWorkspaceName('1abc', new Set())).toBeTruthy()
  })

  it('rejects uppercase letters', () => {
    expect(validateWorkspaceName('Wise', new Set())).toBeTruthy()
  })

  it('rejects special characters', () => {
    expect(validateWorkspaceName('wise-panther', new Set())).toBeTruthy()
    expect(validateWorkspaceName('wise panther', new Set())).toBeTruthy()
  })

  it('rejects names over 22 characters', () => {
    expect(validateWorkspaceName('a2345678901234567890123', new Set())).toBeTruthy()
  })

  it('rejects taken names', () => {
    expect(validateWorkspaceName('wise_panther', new Set(['wise_panther']))).toBeTruthy()
  })
})
