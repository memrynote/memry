/**
 * Key Derivation Tests
 *
 * Tests HKDF and Argon2id key derivation functions.
 *
 * @module main/crypto/keys.test
 */

import { describe, it, expect } from 'vitest'
import {
  deriveKey,
  deriveVaultKey,
  deriveSigningKeySeed,
  deriveVerifyKey,
  generateSigningKeyPair,
  deriveMasterKey,
  generateKdfSalt,
  computeKeyVerifier,
  verifyKeyVerifier,
  deriveAllKeys,
  generateFileKey,
  generateNonce
} from './keys'
import { HKDF_CONTEXTS } from '@shared/contracts/crypto'
import { TEST_MASTER_KEY, TEST_MASTER_KEY_ALT, TEST_SALT, TEST_SIGNING_SEED } from './__fixtures__'
import {
  expectBufferEqual,
  expectBufferNotEqual,
  randomKey,
  randomSalt,
  expectToThrow
} from './__helpers__'

describe('keys', () => {
  describe('deriveKey (HKDF)', () => {
    it('should derive 32-byte key from master key and context', () => {
      const derivedKey = deriveKey(TEST_MASTER_KEY, 'test-context')

      expect(derivedKey).toBeInstanceOf(Buffer)
      expect(derivedKey.length).toBe(32)
    })

    it('should produce different keys for different contexts', () => {
      const key1 = deriveKey(TEST_MASTER_KEY, 'context-1')
      const key2 = deriveKey(TEST_MASTER_KEY, 'context-2')

      expectBufferNotEqual(key1, key2)
    })

    it('should produce same key for same master key + context', () => {
      const key1 = deriveKey(TEST_MASTER_KEY, 'same-context')
      const key2 = deriveKey(TEST_MASTER_KEY, 'same-context')

      expectBufferEqual(key1, key2)
    })

    it('should reject master key of wrong length (too short)', () => {
      const shortKey = Buffer.alloc(16, 0x42)

      expectToThrow(() => deriveKey(shortKey, 'test'), 'Master key must be 32 bytes')
    })

    it('should reject master key of wrong length (too long)', () => {
      const longKey = Buffer.alloc(64, 0x42)

      expectToThrow(() => deriveKey(longKey, 'test'), 'Master key must be 32 bytes')
    })

    it('should handle long context strings', () => {
      const longContext = 'a'.repeat(100)
      const derivedKey = deriveKey(TEST_MASTER_KEY, longContext)

      expect(derivedKey).toBeInstanceOf(Buffer)
      expect(derivedKey.length).toBe(32)
    })

    it('should produce different keys for different master keys', () => {
      const key1 = deriveKey(TEST_MASTER_KEY, 'same-context')
      const key2 = deriveKey(TEST_MASTER_KEY_ALT, 'same-context')

      expectBufferNotEqual(key1, key2)
    })
  })

  describe('deriveVaultKey', () => {
    it('should derive vault key using correct context', () => {
      const vaultKey = deriveVaultKey(TEST_MASTER_KEY)
      const expectedKey = deriveKey(TEST_MASTER_KEY, HKDF_CONTEXTS.VAULT_KEY)

      expectBufferEqual(vaultKey, expectedKey)
    })

    it('should be deterministic', () => {
      const key1 = deriveVaultKey(TEST_MASTER_KEY)
      const key2 = deriveVaultKey(TEST_MASTER_KEY)

      expectBufferEqual(key1, key2)
    })

    it('should return 32-byte key', () => {
      const vaultKey = deriveVaultKey(TEST_MASTER_KEY)

      expect(vaultKey.length).toBe(32)
    })
  })

  describe('deriveSigningKeySeed', () => {
    it('should derive signing seed using correct context', () => {
      const signingKeySeed = deriveSigningKeySeed(TEST_MASTER_KEY)
      const expectedKey = deriveKey(TEST_MASTER_KEY, HKDF_CONTEXTS.SIGNING_KEY)

      expectBufferEqual(signingKeySeed, expectedKey)
    })

    it('should be deterministic', () => {
      const key1 = deriveSigningKeySeed(TEST_MASTER_KEY)
      const key2 = deriveSigningKeySeed(TEST_MASTER_KEY)

      expectBufferEqual(key1, key2)
    })

    it('should return 32-byte key', () => {
      const signingKeySeed = deriveSigningKeySeed(TEST_MASTER_KEY)

      expect(signingKeySeed.length).toBe(32)
    })
  })

  describe('deriveVerifyKey', () => {
    it('should derive verify key using correct context', () => {
      const verifyKey = deriveVerifyKey(TEST_MASTER_KEY)
      const expectedKey = deriveKey(TEST_MASTER_KEY, HKDF_CONTEXTS.VERIFY_KEY)

      expectBufferEqual(verifyKey, expectedKey)
    })

    it('should be deterministic', () => {
      const key1 = deriveVerifyKey(TEST_MASTER_KEY)
      const key2 = deriveVerifyKey(TEST_MASTER_KEY)

      expectBufferEqual(key1, key2)
    })

    it('should return 32-byte key', () => {
      const verifyKey = deriveVerifyKey(TEST_MASTER_KEY)

      expect(verifyKey.length).toBe(32)
    })
  })

  describe('generateSigningKeyPair', () => {
    it('should generate Ed25519 key pair from seed', () => {
      const { publicKey, secretKey } = generateSigningKeyPair(TEST_SIGNING_SEED)

      expect(publicKey).toBeInstanceOf(Buffer)
      expect(secretKey).toBeInstanceOf(Buffer)
    })

    it('should produce 32-byte public key', () => {
      const { publicKey } = generateSigningKeyPair(TEST_SIGNING_SEED)

      expect(publicKey.length).toBe(32)
    })

    it('should produce 64-byte secret key', () => {
      const { secretKey } = generateSigningKeyPair(TEST_SIGNING_SEED)

      expect(secretKey.length).toBe(64)
    })

    it('should be deterministic (same seed = same keys)', () => {
      const pair1 = generateSigningKeyPair(TEST_SIGNING_SEED)
      const pair2 = generateSigningKeyPair(TEST_SIGNING_SEED)

      expectBufferEqual(pair1.publicKey, pair2.publicKey)
      expectBufferEqual(pair1.secretKey, pair2.secretKey)
    })

    it('should reject seed of wrong length', () => {
      const shortSeed = Buffer.alloc(16, 0x42)

      expectToThrow(() => generateSigningKeyPair(shortSeed), 'Seed must be 32 bytes')
    })

    it('should produce different keys for different seeds', () => {
      const seed1 = Buffer.alloc(32, 0x01)
      const seed2 = Buffer.alloc(32, 0x02)

      const pair1 = generateSigningKeyPair(seed1)
      const pair2 = generateSigningKeyPair(seed2)

      expectBufferNotEqual(pair1.publicKey, pair2.publicKey)
      expectBufferNotEqual(pair1.secretKey, pair2.secretKey)
    })
  })

  describe('deriveMasterKey (Argon2id)', () => {
    // Note: These tests are slow due to Argon2id's intentional slowness
    it('should derive 32-byte master key from seed and salt', { timeout: 10000 }, () => {
      const seed = Buffer.alloc(64, 0x42)
      const masterKey = deriveMasterKey(seed, TEST_SALT)

      expect(masterKey).toBeInstanceOf(Buffer)
      expect(masterKey.length).toBe(32)
    })

    it('should be deterministic (same inputs = same output)', { timeout: 15000 }, () => {
      const seed = Buffer.alloc(64, 0x42)

      const key1 = deriveMasterKey(seed, TEST_SALT)
      const key2 = deriveMasterKey(seed, TEST_SALT)

      expectBufferEqual(key1, key2)
    })

    it('should produce different keys for different salts', { timeout: 15000 }, () => {
      const seed = Buffer.alloc(64, 0x42)
      const salt1 = Buffer.alloc(16, 0x01)
      const salt2 = Buffer.alloc(16, 0x02)

      const key1 = deriveMasterKey(seed, salt1)
      const key2 = deriveMasterKey(seed, salt2)

      expectBufferNotEqual(key1, key2)
    })

    it('should reject seed < 32 bytes', () => {
      const shortSeed = Buffer.alloc(16, 0x42)

      expectToThrow(() => deriveMasterKey(shortSeed, TEST_SALT), 'Seed must be at least 32 bytes')
    })

    it('should reject salt < 16 bytes', () => {
      const seed = Buffer.alloc(64, 0x42)
      const shortSalt = Buffer.alloc(8, 0x01)

      expectToThrow(() => deriveMasterKey(seed, shortSalt), 'Salt must be at least 16 bytes')
    })

    it('should accept seed of exactly 32 bytes', { timeout: 10000 }, () => {
      const seed = Buffer.alloc(32, 0x42)
      const masterKey = deriveMasterKey(seed, TEST_SALT)

      expect(masterKey.length).toBe(32)
    })

    it('should produce different keys for different seeds', { timeout: 15000 }, () => {
      const seed1 = Buffer.alloc(64, 0x01)
      const seed2 = Buffer.alloc(64, 0x02)

      const key1 = deriveMasterKey(seed1, TEST_SALT)
      const key2 = deriveMasterKey(seed2, TEST_SALT)

      expectBufferNotEqual(key1, key2)
    })
  })

  describe('generateKdfSalt', () => {
    it('should generate 16-byte random salt', () => {
      const salt = generateKdfSalt()

      expect(salt).toBeInstanceOf(Buffer)
      expect(salt.length).toBe(16)
    })

    it('should generate unique salts', () => {
      const salts: Buffer[] = []

      for (let i = 0; i < 10; i++) {
        salts.push(generateKdfSalt())
      }

      // Check all pairs are different
      for (let i = 0; i < salts.length; i++) {
        for (let j = i + 1; j < salts.length; j++) {
          expectBufferNotEqual(salts[i], salts[j])
        }
      }
    })
  })

  describe('computeKeyVerifier', () => {
    it('should compute 32-byte HMAC verifier', () => {
      const verifier = computeKeyVerifier(TEST_MASTER_KEY)

      expect(verifier).toBeInstanceOf(Buffer)
      expect(verifier.length).toBe(32)
    })

    it('should be deterministic', () => {
      const verifier1 = computeKeyVerifier(TEST_MASTER_KEY)
      const verifier2 = computeKeyVerifier(TEST_MASTER_KEY)

      expectBufferEqual(verifier1, verifier2)
    })

    it('should produce different verifiers for different master keys', () => {
      const verifier1 = computeKeyVerifier(TEST_MASTER_KEY)
      const verifier2 = computeKeyVerifier(TEST_MASTER_KEY_ALT)

      expectBufferNotEqual(verifier1, verifier2)
    })
  })

  describe('verifyKeyVerifier', () => {
    it('should return true for matching verifier', () => {
      const verifier = computeKeyVerifier(TEST_MASTER_KEY)
      const result = verifyKeyVerifier(TEST_MASTER_KEY, verifier)

      expect(result).toBe(true)
    })

    it('should return false for non-matching verifier', () => {
      const verifier = computeKeyVerifier(TEST_MASTER_KEY)
      const wrongVerifier = Buffer.alloc(32, 0xff)

      const result = verifyKeyVerifier(TEST_MASTER_KEY, wrongVerifier)

      expect(result).toBe(false)
    })

    it('should return false for wrong master key', () => {
      const verifier = computeKeyVerifier(TEST_MASTER_KEY)
      const result = verifyKeyVerifier(TEST_MASTER_KEY_ALT, verifier)

      expect(result).toBe(false)
    })
  })

  describe('deriveAllKeys', () => {
    it('should derive all keys from master key', () => {
      const keys = deriveAllKeys(TEST_MASTER_KEY)

      expect(keys).toHaveProperty('masterKey')
      expect(keys).toHaveProperty('vaultKey')
      expect(keys).toHaveProperty('signingKeyPair')
      expect(keys).toHaveProperty('verifyKey')
      expect(keys).toHaveProperty('keyVerifier')
    })

    it('should return vaultKey, signingKeyPair, keyVerifier', () => {
      const keys = deriveAllKeys(TEST_MASTER_KEY)

      expect(keys.vaultKey.length).toBe(32)
      expect(keys.signingKeyPair.publicKey.length).toBe(32)
      expect(keys.signingKeyPair.secretKey.length).toBe(64)
      expect(keys.verifyKey.length).toBe(32)
      expect(keys.keyVerifier.length).toBe(32)
    })

    it('should be deterministic', () => {
      const keys1 = deriveAllKeys(TEST_MASTER_KEY)
      const keys2 = deriveAllKeys(TEST_MASTER_KEY)

      expectBufferEqual(keys1.vaultKey, keys2.vaultKey)
      expectBufferEqual(keys1.signingKeyPair.publicKey, keys2.signingKeyPair.publicKey)
      expectBufferEqual(keys1.signingKeyPair.secretKey, keys2.signingKeyPair.secretKey)
      expectBufferEqual(keys1.verifyKey, keys2.verifyKey)
      expectBufferEqual(keys1.keyVerifier, keys2.keyVerifier)
    })

    it('should return Uint8Array types', () => {
      const keys = deriveAllKeys(TEST_MASTER_KEY)

      expect(keys.masterKey).toBeInstanceOf(Uint8Array)
      expect(keys.vaultKey).toBeInstanceOf(Uint8Array)
      expect(keys.signingKeyPair.publicKey).toBeInstanceOf(Uint8Array)
      expect(keys.signingKeyPair.secretKey).toBeInstanceOf(Uint8Array)
      expect(keys.verifyKey).toBeInstanceOf(Uint8Array)
      expect(keys.keyVerifier).toBeInstanceOf(Uint8Array)
    })

    it('should produce consistent keys with individual derivation functions', () => {
      const allKeys = deriveAllKeys(TEST_MASTER_KEY)

      const vaultKey = deriveVaultKey(TEST_MASTER_KEY)
      const signingKeySeed = deriveSigningKeySeed(TEST_MASTER_KEY)
      const signingKeyPair = generateSigningKeyPair(signingKeySeed)
      const verifyKey = deriveVerifyKey(TEST_MASTER_KEY)
      const keyVerifier = computeKeyVerifier(TEST_MASTER_KEY)

      expectBufferEqual(allKeys.vaultKey, vaultKey)
      expectBufferEqual(allKeys.signingKeyPair.publicKey, signingKeyPair.publicKey)
      expectBufferEqual(allKeys.signingKeyPair.secretKey, signingKeyPair.secretKey)
      expectBufferEqual(allKeys.verifyKey, verifyKey)
      expectBufferEqual(allKeys.keyVerifier, keyVerifier)
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

      // Check all pairs are different
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          expectBufferNotEqual(keys[i], keys[j])
        }
      }
    })
  })

  describe('generateNonce', () => {
    it('should generate 24-byte nonce for XChaCha20', () => {
      const nonce = generateNonce()

      expect(nonce).toBeInstanceOf(Buffer)
      expect(nonce.length).toBe(24)
    })

    it('should generate nonce of specified length', () => {
      const nonce16 = generateNonce(16)
      const nonce32 = generateNonce(32)

      expect(nonce16.length).toBe(16)
      expect(nonce32.length).toBe(32)
    })

    it('should generate unique nonces', () => {
      const nonces: Buffer[] = []

      for (let i = 0; i < 10; i++) {
        nonces.push(generateNonce())
      }

      // Check all pairs are different
      for (let i = 0; i < nonces.length; i++) {
        for (let j = i + 1; j < nonces.length; j++) {
          expectBufferNotEqual(nonces[i], nonces[j])
        }
      }
    })
  })
})
