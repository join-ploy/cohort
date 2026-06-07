import { safeStorage } from 'electron'

// safeStorage-backed string encryption shared by the persistence store and the
// http-endpoint trigger. Falls back to plaintext when the OS keychain is
// unavailable (e.g. headless Linux CI) so values are never lost.
export function encryptSecret(plaintext: string): string {
  if (!plaintext || !safeStorage.isEncryptionAvailable()) {
    return plaintext
  }
  try {
    return safeStorage.encryptString(plaintext).toString('base64')
  } catch (err) {
    console.error('[secret-encryption] encryption failed:', err)
    return plaintext
  }
}

export function decryptSecret(ciphertext: string): string {
  if (!ciphertext || !safeStorage.isEncryptionAvailable()) {
    return ciphertext
  }
  try {
    return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))
  } catch {
    // Why: a decrypt failure usually means the value predates encryption or the
    // keychain changed — fall back to the raw string rather than losing it.
    console.warn('[secret-encryption] decryption failed — returning value as-is.')
    return ciphertext
  }
}
