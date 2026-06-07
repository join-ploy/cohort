import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mutable safeStorage stub so each test can pick the keychain-available path or
// the unavailable fallback, and force a decrypt failure.
const state = vi.hoisted(() => ({ available: false, throwOnDecrypt: false }))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => state.available,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => {
      if (state.throwOnDecrypt) {
        throw new Error('keychain reset')
      }
      return b.toString()
    }
  }
}))

import { encryptSecret, decryptSecret } from './secret-encryption'

beforeEach(() => {
  state.available = false
  state.throwOnDecrypt = false
})

describe('secret-encryption (safeStorage unavailable)', () => {
  it('returns plaintext unchanged when encryption is unavailable', () => {
    expect(encryptSecret('token-123')).toBe('token-123')
    expect(decryptSecret('token-123')).toBe('token-123')
  })

  it('treats empty values as passthrough', () => {
    expect(encryptSecret('')).toBe('')
    expect(decryptSecret('')).toBe('')
  })
})

describe('secret-encryption (safeStorage available)', () => {
  it('round-trips a secret through encrypt + decrypt', () => {
    state.available = true
    const cipher = encryptSecret('Bearer abc123')
    expect(cipher).not.toBe('Bearer abc123') // actually encrypted
    expect(decryptSecret(cipher)).toBe('Bearer abc123')
  })

  it('returns the ciphertext as-is when decryption throws (legacy/keychain-reset)', () => {
    state.available = true
    state.throwOnDecrypt = true
    expect(decryptSecret('looks-like-ciphertext')).toBe('looks-like-ciphertext')
  })
})
