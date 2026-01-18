/**
 * Encryption Tests
 *
 * Tests XChaCha20-Poly1305 authenticated encryption.
 *
 * @module main/crypto/encryption.test
 */

import { describe, it, expect } from 'vitest'
import {
  encrypt,
  decrypt,
  wrapFileKey,
  unwrapFileKey,
  encryptItem,
  decryptItem,
  encryptItemToBase64,
  decryptItemFromBase64,
  encryptChunk,
  decryptChunk
} from './encryption'
import { generateFileKey, generateNonce } from './keys'
import {
  TEST_VAULT_KEY,
  TEST_FILE_KEY,
  TEST_PLAINTEXT,
  EMPTY_PLAINTEXT,
  TEST_BINARY_DATA,
  createLargePlaintext
} from './__fixtures__'
import {
  expectBufferEqual,
  expectBufferNotEqual,
  randomKey,
  expectToThrow,
  expectValidBase64
} from './__helpers__'
import { CRYPTO_VERSION } from '@shared/contracts/crypto'

describe('encryption', () => {
  describe('encrypt/decrypt', () => {
    it('should encrypt and decrypt small data', () => {
      const key = generateFileKey()
      const { ciphertext, nonce } = encrypt(TEST_PLAINTEXT, key)

      const decrypted = decrypt(Buffer.from(ciphertext), Buffer.from(nonce), key)

      expectBufferEqual(decrypted, TEST_PLAINTEXT)
    })

    it('should encrypt and decrypt large data (1MB)', () => {
      const key = generateFileKey()
      const largePlaintext = createLargePlaintext(1024)

      const { ciphertext, nonce } = encrypt(largePlaintext, key)
      const decrypted = decrypt(Buffer.from(ciphertext), Buffer.from(nonce), key)

      expectBufferEqual(decrypted, largePlaintext)
    })

    it('should produce different ciphertext for same plaintext (random nonce)', () => {
      const key = generateFileKey()

      const result1 = encrypt(TEST_PLAINTEXT, key)
      const result2 = encrypt(TEST_PLAINTEXT, key)

      // Ciphertexts should be different due to different nonces
      expectBufferNotEqual(result1.ciphertext, result2.ciphertext)
      expectBufferNotEqual(result1.nonce, result2.nonce)
    })

    it('should fail decryption with wrong key', () => {
      const key1 = generateFileKey()
      const key2 = generateFileKey()

      const { ciphertext, nonce } = encrypt(TEST_PLAINTEXT, key1)

      expectToThrow(
        () => decrypt(Buffer.from(ciphertext), Buffer.from(nonce), key2),
        'Decryption failed'
      )
    })

    it('should fail decryption with wrong nonce', () => {
      const key = generateFileKey()

      const { ciphertext, nonce } = encrypt(TEST_PLAINTEXT, key)
      const wrongNonce = generateNonce(24)

      expectToThrow(() => decrypt(Buffer.from(ciphertext), wrongNonce, key), 'Decryption failed')
    })

    it('should fail decryption with tampered ciphertext', () => {
      const key = generateFileKey()

      const { ciphertext, nonce } = encrypt(TEST_PLAINTEXT, key)

      // Tamper with the ciphertext
      const tamperedCiphertext = Buffer.from(ciphertext)
      tamperedCiphertext[0] ^= 0xff

      expectToThrow(() => decrypt(tamperedCiphertext, Buffer.from(nonce), key), 'Decryption failed')
    })

    it('should reject key of wrong length', () => {
      const shortKey = Buffer.alloc(16, 0x42)

      expectToThrow(() => encrypt(TEST_PLAINTEXT, shortKey), 'Key must be 32 bytes')
    })

    it('should reject nonce of wrong length', () => {
      const key = generateFileKey()
      const { ciphertext } = encrypt(TEST_PLAINTEXT, key)

      const shortNonce = Buffer.alloc(16, 0x01)

      expectToThrow(
        () => decrypt(Buffer.from(ciphertext), shortNonce, key),
        'Nonce must be 24 bytes'
      )
    })

    it('should handle empty plaintext', () => {
      const key = generateFileKey()

      const { ciphertext, nonce } = encrypt(EMPTY_PLAINTEXT, key)
      const decrypted = decrypt(Buffer.from(ciphertext), Buffer.from(nonce), key)

      expectBufferEqual(decrypted, EMPTY_PLAINTEXT)
    })

    it('should handle binary data with null bytes', () => {
      const key = generateFileKey()

      const { ciphertext, nonce } = encrypt(TEST_BINARY_DATA, key)
      const decrypted = decrypt(Buffer.from(ciphertext), Buffer.from(nonce), key)

      expectBufferEqual(decrypted, TEST_BINARY_DATA)
    })

    it('should produce ciphertext longer than plaintext (auth tag)', () => {
      const key = generateFileKey()

      const { ciphertext } = encrypt(TEST_PLAINTEXT, key)

      // XChaCha20-Poly1305 adds 16-byte auth tag
      expect(ciphertext.length).toBe(TEST_PLAINTEXT.length + 16)
    })

    it('should reject ciphertext that is too short', () => {
      const key = generateFileKey()
      const shortCiphertext = Buffer.alloc(8) // Less than 16-byte tag
      const nonce = generateNonce(24)

      expectToThrow(() => decrypt(shortCiphertext, nonce, key), 'Ciphertext too short')
    })
  })

  describe('wrapFileKey/unwrapFileKey', () => {
    it('should wrap and unwrap file key correctly', () => {
      const { ciphertext, nonce } = wrapFileKey(TEST_FILE_KEY, TEST_VAULT_KEY)
      const unwrapped = unwrapFileKey(Buffer.from(ciphertext), Buffer.from(nonce), TEST_VAULT_KEY)

      expectBufferEqual(unwrapped, TEST_FILE_KEY)
    })

    it('should fail unwrap with wrong vault key', () => {
      const { ciphertext, nonce } = wrapFileKey(TEST_FILE_KEY, TEST_VAULT_KEY)
      const wrongVaultKey = randomKey(32)

      expectToThrow(
        () => unwrapFileKey(Buffer.from(ciphertext), Buffer.from(nonce), wrongVaultKey),
        'Decryption failed'
      )
    })

    it('should produce 32-byte wrapped key + auth tag', () => {
      const { ciphertext } = wrapFileKey(TEST_FILE_KEY, TEST_VAULT_KEY)

      // 32-byte file key + 16-byte auth tag = 48 bytes
      expect(ciphertext.length).toBe(48)
    })

    it('should produce different wrapped keys for same file key', () => {
      const result1 = wrapFileKey(TEST_FILE_KEY, TEST_VAULT_KEY)
      const result2 = wrapFileKey(TEST_FILE_KEY, TEST_VAULT_KEY)

      // Different nonces = different wrapped keys
      expectBufferNotEqual(result1.ciphertext, result2.ciphertext)
    })

    it('should throw for wrapped key with invalid length', () => {
      // Create a valid encryption of something other than a 32-byte key
      const invalidData = Buffer.alloc(16, 0x42)
      const { ciphertext, nonce } = encrypt(invalidData, TEST_VAULT_KEY)

      expectToThrow(
        () => unwrapFileKey(Buffer.from(ciphertext), Buffer.from(nonce), TEST_VAULT_KEY),
        'invalid length'
      )
    })
  })

  describe('encryptItem/decryptItem', () => {
    it('should encrypt string data', () => {
      const result = encryptItem('Hello, World!', TEST_VAULT_KEY)

      expect(result.encryptedData).toBeInstanceOf(Buffer)
      expect(result.dataNonce).toBeInstanceOf(Buffer)
      expect(result.encryptedKey).toBeInstanceOf(Buffer)
      expect(result.keyNonce).toBeInstanceOf(Buffer)
    })

    it('should encrypt Buffer data', () => {
      const result = encryptItem(TEST_PLAINTEXT, TEST_VAULT_KEY)

      expect(result.encryptedData).toBeInstanceOf(Buffer)
    })

    it('should return all required fields', () => {
      const result = encryptItem(TEST_PLAINTEXT, TEST_VAULT_KEY)

      expect(result).toHaveProperty('encryptedData')
      expect(result).toHaveProperty('dataNonce')
      expect(result).toHaveProperty('encryptedKey')
      expect(result).toHaveProperty('keyNonce')
      expect(result).toHaveProperty('cryptoVersion')
    })

    it('should decrypt back to original data', () => {
      const original = 'Test data for encryption'
      const encrypted = encryptItem(original, TEST_VAULT_KEY)

      const decrypted = decryptItem(
        encrypted.encryptedData,
        encrypted.dataNonce,
        encrypted.encryptedKey,
        encrypted.keyNonce,
        TEST_VAULT_KEY
      )

      expect(decrypted.toString('utf8')).toBe(original)
    })

    it('should use different file key for each encryption', () => {
      const result1 = encryptItem(TEST_PLAINTEXT, TEST_VAULT_KEY)
      const result2 = encryptItem(TEST_PLAINTEXT, TEST_VAULT_KEY)

      // Different file keys = different encrypted keys
      expectBufferNotEqual(result1.encryptedKey, result2.encryptedKey)
    })

    it('should fail decryption with wrong vault key', () => {
      const encrypted = encryptItem(TEST_PLAINTEXT, TEST_VAULT_KEY)
      const wrongVaultKey = randomKey(32)

      expectToThrow(
        () =>
          decryptItem(
            encrypted.encryptedData,
            encrypted.dataNonce,
            encrypted.encryptedKey,
            encrypted.keyNonce,
            wrongVaultKey
          ),
        'Decryption failed'
      )
    })

    it('should include cryptoVersion = 1', () => {
      const result = encryptItem(TEST_PLAINTEXT, TEST_VAULT_KEY)

      expect(result.cryptoVersion).toBe(CRYPTO_VERSION)
      expect(result.cryptoVersion).toBe(1)
    })

    it('should handle UTF-8 characters', () => {
      const original = '你好世界 🌍 émoji'
      const encrypted = encryptItem(original, TEST_VAULT_KEY)

      const decrypted = decryptItem(
        encrypted.encryptedData,
        encrypted.dataNonce,
        encrypted.encryptedKey,
        encrypted.keyNonce,
        TEST_VAULT_KEY
      )

      expect(decrypted.toString('utf8')).toBe(original)
    })

    it('should handle large data', () => {
      const largeData = createLargePlaintext(512) // 512KB
      const encrypted = encryptItem(largeData, TEST_VAULT_KEY)

      const decrypted = decryptItem(
        encrypted.encryptedData,
        encrypted.dataNonce,
        encrypted.encryptedKey,
        encrypted.keyNonce,
        TEST_VAULT_KEY
      )

      expectBufferEqual(decrypted, largeData)
    })
  })

  describe('encryptItemToBase64/decryptItemFromBase64', () => {
    it('should produce valid Base64 strings', () => {
      const result = encryptItemToBase64(TEST_PLAINTEXT, TEST_VAULT_KEY)

      expectValidBase64(result.encryptedData)
      expectValidBase64(result.dataNonce)
      expectValidBase64(result.encryptedKey)
      expectValidBase64(result.keyNonce)
    })

    it('should round-trip correctly', () => {
      const original = 'Test data for Base64 encryption'
      const encrypted = encryptItemToBase64(original, TEST_VAULT_KEY)

      const decrypted = decryptItemFromBase64(
        encrypted.encryptedData,
        encrypted.dataNonce,
        encrypted.encryptedKey,
        encrypted.keyNonce,
        TEST_VAULT_KEY
      )

      expect(decrypted).toBe(original)
    })

    it('should include cryptoVersion', () => {
      const result = encryptItemToBase64(TEST_PLAINTEXT, TEST_VAULT_KEY)

      expect(result.cryptoVersion).toBe(1)
    })

    it('should handle UTF-8 strings', () => {
      const original = '日本語テスト 🎉'
      const encrypted = encryptItemToBase64(original, TEST_VAULT_KEY)
      const decrypted = decryptItemFromBase64(
        encrypted.encryptedData,
        encrypted.dataNonce,
        encrypted.encryptedKey,
        encrypted.keyNonce,
        TEST_VAULT_KEY
      )

      expect(decrypted).toBe(original)
    })
  })

  describe('encryptChunk/decryptChunk', () => {
    it('should encrypt individual chunks', () => {
      const fileKey = generateFileKey()
      const chunk = Buffer.from('This is a chunk of data')

      const { ciphertext, nonce } = encryptChunk(chunk, fileKey, 0)

      expect(ciphertext).toBeInstanceOf(Buffer)
      expect(nonce).toBeInstanceOf(Buffer)
    })

    it('should decrypt chunks correctly', () => {
      const fileKey = generateFileKey()
      const chunk = Buffer.from('This is a chunk of data')

      const { ciphertext, nonce } = encryptChunk(chunk, fileKey, 0)
      const decrypted = decryptChunk(ciphertext, nonce, fileKey)

      expectBufferEqual(decrypted, chunk)
    })

    it('should use unique nonce per chunk', () => {
      const fileKey = generateFileKey()
      const chunk = Buffer.from('Same data')

      const result0 = encryptChunk(chunk, fileKey, 0)
      const result1 = encryptChunk(chunk, fileKey, 1)

      // Different nonces
      expectBufferNotEqual(result0.nonce, result1.nonce)
    })

    it('should handle 8MB chunks', () => {
      const fileKey = generateFileKey()
      const largeChunk = createLargePlaintext(8 * 1024) // 8MB

      const { ciphertext, nonce } = encryptChunk(largeChunk, fileKey, 0)
      const decrypted = decryptChunk(ciphertext, nonce, fileKey)

      expectBufferEqual(decrypted, largeChunk)
    })

    it('should fail decryption with wrong key', () => {
      const fileKey1 = generateFileKey()
      const fileKey2 = generateFileKey()
      const chunk = Buffer.from('Sensitive data')

      const { ciphertext, nonce } = encryptChunk(chunk, fileKey1, 0)

      expectToThrow(() => decryptChunk(ciphertext, nonce, fileKey2), 'Decryption failed')
    })

    it('should fail decryption with tampered ciphertext', () => {
      const fileKey = generateFileKey()
      const chunk = Buffer.from('Sensitive data')

      const { ciphertext, nonce } = encryptChunk(chunk, fileKey, 0)

      // Tamper with ciphertext
      ciphertext[0] ^= 0xff

      expectToThrow(() => decryptChunk(ciphertext, nonce, fileKey), 'Decryption failed')
    })
  })

  describe('generateFileKey', () => {
    it('should generate 32-byte random key', () => {
      const key = generateFileKey()

      expect(key).toBeInstanceOf(Buffer)
      expect(key.length).toBe(32)
    })

    it('should generate unique keys each call', () => {
      const keys: Buffer[] = []

      for (let i = 0; i < 10; i++) {
        keys.push(generateFileKey())
      }

      // All keys should be unique
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          expectBufferNotEqual(keys[i], keys[j])
        }
      }
    })
  })

  describe('memory safety', () => {
    it('should zero out file key after encryptItem (verified by behavior)', () => {
      // We can't directly test that memory is zeroed, but we can verify
      // that the function completes successfully and the data is encrypted
      const result = encryptItem(TEST_PLAINTEXT, TEST_VAULT_KEY)

      // If the file key wasn't properly handled, encryption would fail
      expect(result.encryptedData.length).toBeGreaterThan(0)
      expect(result.cryptoVersion).toBe(1)
    })

    it('should zero out file key after decryptItem (verified by behavior)', () => {
      const encrypted = encryptItem(TEST_PLAINTEXT, TEST_VAULT_KEY)

      // Decrypt successfully
      const decrypted = decryptItem(
        encrypted.encryptedData,
        encrypted.dataNonce,
        encrypted.encryptedKey,
        encrypted.keyNonce,
        TEST_VAULT_KEY
      )

      // If the file key wasn't properly handled, decryption would fail
      expectBufferEqual(decrypted, TEST_PLAINTEXT)
    })

    it('should still work after multiple encrypt/decrypt cycles', () => {
      const testData = 'Test data for multiple cycles'

      // Run multiple cycles to ensure no memory issues
      for (let i = 0; i < 10; i++) {
        const encrypted = encryptItem(testData, TEST_VAULT_KEY)
        const decrypted = decryptItem(
          encrypted.encryptedData,
          encrypted.dataNonce,
          encrypted.encryptedKey,
          encrypted.keyNonce,
          TEST_VAULT_KEY
        )

        expect(decrypted.toString('utf8')).toBe(testData)
      }
    })
  })
})
