import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))

import { encryptSecret, decryptSecret } from './secret-encryption'

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
