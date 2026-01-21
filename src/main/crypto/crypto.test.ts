/**
 * Crypto Module Tests
 *
 * Verifies all crypto primitives work correctly.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import {
  initCrypto,
  generateRecoveryPhrase,
  validateRecoveryPhrase,
  phraseToEntropy,
  entropyToPhrase,
  deriveMasterKey,
  deriveAllKeys,
  deriveKey,
  generateFileKey,
  generateDeviceSigningKeyPair,
  getDevicePublicKeyBase64,
  generateSalt,
  generateNonce,
  encrypt,
  decrypt,
  wrapFileKey,
  unwrapFileKey,
  encryptWithWrappedKey,
  decryptWithWrappedKey,
  signPayload,
  verifyPayload,
  sign,
  verify,
  encodeSignaturePayloadV1,
  secureZero,
  uint8ArrayToBase64,
  base64ToUint8Array
} from './index'
import { HKDF_CONTEXTS, CRYPTO_VERSION } from '@shared/contracts/crypto'
import type { SignaturePayloadV1 } from '@shared/contracts/crypto'

describe('Crypto Module', () => {
  beforeAll(async () => {
    await initCrypto()
  })

  describe('Recovery Phrase (T021, T022)', () => {
    it('generates a 24-word recovery phrase', () => {
      const phrase = generateRecoveryPhrase()
      expect(phrase).toHaveLength(24)
      expect(phrase.every((word) => typeof word === 'string')).toBe(true)
    })

    it('validates a valid recovery phrase', () => {
      const phrase = generateRecoveryPhrase()
      expect(validateRecoveryPhrase(phrase)).toBe(true)
    })

    it('rejects an invalid recovery phrase', () => {
      const invalidPhrase = Array(24).fill('invalid')
      expect(validateRecoveryPhrase(invalidPhrase)).toBe(false)
    })

    it('converts phrase to entropy and back', () => {
      const phrase = generateRecoveryPhrase()
      const entropy = phraseToEntropy(phrase)
      expect(entropy).toHaveLength(32)

      const recoveredPhrase = entropyToPhrase(entropy)
      expect(recoveredPhrase).toEqual(phrase)
    })
  })

  describe('Key Derivation (T020, T023, T024c)', () => {
    it('derives master key from entropy with Argon2id', async () => {
      const phrase = generateRecoveryPhrase()
      const entropy = phraseToEntropy(phrase)
      const salt = await generateSalt()

      const masterKey = await deriveMasterKey(entropy, salt)
      expect(masterKey).toHaveLength(32)
    })

    it('derives keys deterministically', async () => {
      const phrase = generateRecoveryPhrase()
      const entropy = phraseToEntropy(phrase)
      const salt = await generateSalt()

      const masterKey1 = await deriveMasterKey(entropy, salt)
      const masterKey2 = await deriveMasterKey(entropy, salt)

      expect(masterKey1).toEqual(masterKey2)
    })

    it('derives all sub-keys from master key', async () => {
      const phrase = generateRecoveryPhrase()
      const entropy = phraseToEntropy(phrase)
      const salt = await generateSalt()
      const masterKey = await deriveMasterKey(entropy, salt)

      const keys = await deriveAllKeys(masterKey)

      expect(keys.vaultKey).toHaveLength(32)
      expect(keys.signingKeyPair.publicKey).toHaveLength(32)
      expect(keys.signingKeyPair.privateKey).toHaveLength(64)
      expect(keys.verifyKey).toHaveLength(32)
    })

    it('derives key using HKDF context', async () => {
      const masterKey = new Uint8Array(32).fill(1)
      const key = await deriveKey(masterKey, HKDF_CONTEXTS.VAULT_KEY, 32)
      expect(key).toHaveLength(32)
    })

    it('generates random file keys', async () => {
      const key1 = await generateFileKey()
      const key2 = await generateFileKey()

      expect(key1).toHaveLength(32)
      expect(key2).toHaveLength(32)
      expect(key1).not.toEqual(key2)
    })

    it('generates random nonces', async () => {
      const nonce1 = await generateNonce()
      const nonce2 = await generateNonce()

      expect(nonce1).toHaveLength(24)
      expect(nonce2).toHaveLength(24)
      expect(nonce1).not.toEqual(nonce2)
    })
  })

  describe('Encryption (T024, T025, T024d)', () => {
    it('encrypts and decrypts data', async () => {
      const plaintext = new TextEncoder().encode('Hello, World!')
      const key = await generateFileKey()

      const { ciphertext, nonce } = await encrypt(plaintext, key)
      expect(ciphertext.length).toBeGreaterThan(plaintext.length) // Includes auth tag

      const decrypted = await decrypt(ciphertext, nonce, key)
      expect(new TextDecoder().decode(decrypted)).toBe('Hello, World!')
    })

    it('fails decryption with wrong key', async () => {
      const plaintext = new TextEncoder().encode('Hello, World!')
      const key1 = await generateFileKey()
      const key2 = await generateFileKey()

      const { ciphertext, nonce } = await encrypt(plaintext, key1)

      await expect(decrypt(ciphertext, nonce, key2)).rejects.toThrow('Decryption failed')
    })

    it('wraps and unwraps file keys', async () => {
      const fileKey = await generateFileKey()
      const vaultKey = await generateFileKey()

      const { encryptedKey, keyNonce } = await wrapFileKey(fileKey, vaultKey)
      const unwrappedKey = await unwrapFileKey(encryptedKey, keyNonce, vaultKey)

      expect(unwrappedKey).toEqual(fileKey)
    })

    it('encrypts with wrapped key convenience function', async () => {
      const plaintext = new TextEncoder().encode('Secret data')
      const fileKey = await generateFileKey()
      const vaultKey = await generateFileKey()

      const encrypted = await encryptWithWrappedKey(plaintext, fileKey, vaultKey)

      expect(encrypted.encryptedData).toBeDefined()
      expect(encrypted.dataNonce).toBeDefined()
      expect(encrypted.encryptedKey).toBeDefined()
      expect(encrypted.keyNonce).toBeDefined()

      const decrypted = await decryptWithWrappedKey(
        encrypted.encryptedData,
        encrypted.dataNonce,
        encrypted.encryptedKey,
        encrypted.keyNonce,
        vaultKey
      )

      expect(new TextDecoder().decode(decrypted)).toBe('Secret data')
    })
  })

  describe('Signatures (T026, T027)', () => {
    it('signs and verifies payload', async () => {
      const deviceKeyPair = await generateDeviceSigningKeyPair('device-123')

      const payload: SignaturePayloadV1 = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'note',
        cryptoVersion: CRYPTO_VERSION,
        encryptedKey: 'base64key',
        keyNonce: 'base64nonce',
        encryptedData: 'base64data',
        dataNonce: 'base64datanonce'
      }

      const result = await signPayload(payload, deviceKeyPair.privateKey, deviceKeyPair.deviceId)
      expect(result.signature).toHaveLength(64)
      expect(result.signerDeviceId).toBe('device-123')

      const verification = await verifyPayload(
        payload,
        result.signature,
        deviceKeyPair.publicKey
      )
      expect(verification.valid).toBe(true)
    })

    it('rejects tampered payload', async () => {
      const deviceKeyPair = await generateDeviceSigningKeyPair('device-123')

      const payload: SignaturePayloadV1 = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'note',
        cryptoVersion: CRYPTO_VERSION,
        encryptedKey: 'base64key',
        keyNonce: 'base64nonce',
        encryptedData: 'base64data',
        dataNonce: 'base64datanonce'
      }

      const result = await signPayload(payload, deviceKeyPair.privateKey, deviceKeyPair.deviceId)

      // Tamper with payload
      const tamperedPayload = { ...payload, encryptedData: 'tampered' }

      const verification = await verifyPayload(
        tamperedPayload,
        result.signature,
        deviceKeyPair.publicKey
      )
      expect(verification.valid).toBe(false)
    })

    it('signs and verifies arbitrary data', async () => {
      const deviceKeyPair = await generateDeviceSigningKeyPair('device-123')
      const data = new TextEncoder().encode('Some data to sign')

      const signature = await sign(data, deviceKeyPair.privateKey)
      expect(signature).toHaveLength(64)

      const isValid = await verify(data, signature, deviceKeyPair.publicKey)
      expect(isValid).toBe(true)
    })
  })

  describe('Device Keys (T028a, T028b)', () => {
    it('generates device signing keypair', async () => {
      const keyPair = await generateDeviceSigningKeyPair('device-456')

      expect(keyPair.publicKey).toHaveLength(32)
      expect(keyPair.privateKey).toHaveLength(64)
      expect(keyPair.deviceId).toBe('device-456')
    })

    it('gets device public key as Base64', async () => {
      const keyPair = await generateDeviceSigningKeyPair('device-789')
      const publicKeyBase64 = getDevicePublicKeyBase64(keyPair)

      expect(typeof publicKeyBase64).toBe('string')
      expect(publicKeyBase64.length).toBeGreaterThan(0)

      // Verify round-trip
      const decoded = base64ToUint8Array(publicKeyBase64)
      expect(decoded).toEqual(keyPair.publicKey)
    })
  })

  describe('CBOR Encoding (T020a)', () => {
    it('encodes signature payload deterministically', () => {
      const payload: SignaturePayloadV1 = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'note',
        cryptoVersion: CRYPTO_VERSION,
        encryptedKey: 'key',
        keyNonce: 'nonce',
        encryptedData: 'data',
        dataNonce: 'datanonce'
      }

      const encoded1 = encodeSignaturePayloadV1(payload)
      const encoded2 = encodeSignaturePayloadV1(payload)

      expect(encoded1).toEqual(encoded2)
    })

    it('produces same signature regardless of clock key order', async () => {
      const deviceKeyPair = await generateDeviceSigningKeyPair('device-123')

      // Two payloads with same semantic clock but different key insertion order
      const payload1: SignaturePayloadV1 = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'note',
        cryptoVersion: CRYPTO_VERSION,
        encryptedKey: 'key',
        keyNonce: 'nonce',
        encryptedData: 'data',
        dataNonce: 'datanonce',
        metadata: {
          clock: { 'device-a': 1, 'device-b': 2 } // a before b
        }
      }

      const payload2: SignaturePayloadV1 = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'note',
        cryptoVersion: CRYPTO_VERSION,
        encryptedKey: 'key',
        keyNonce: 'nonce',
        encryptedData: 'data',
        dataNonce: 'datanonce',
        metadata: {
          clock: { 'device-b': 2, 'device-a': 1 } // b before a (different order)
        }
      }

      // Sign with payload1
      const { signature } = await signPayload(payload1, deviceKeyPair.privateKey, 'device-123')

      // Verify with payload2 (different key order but same data)
      const verification = await verifyPayload(payload2, signature, deviceKeyPair.publicKey)
      expect(verification.valid).toBe(true)
    })
  })

  describe('Memory Security (T029a)', () => {
    it('securely zeros memory', async () => {
      const key = await generateFileKey()
      const originalKey = new Uint8Array(key)

      await secureZero(key)

      // Key should be zeroed
      expect(key.every((byte) => byte === 0)).toBe(true)
      // Original copy should still have data
      expect(originalKey.some((byte) => byte !== 0)).toBe(true)
    })
  })

  describe('Base64 Utilities', () => {
    it('converts Uint8Array to Base64 and back', () => {
      const original = new Uint8Array([1, 2, 3, 4, 5, 255, 0, 128])
      const base64 = uint8ArrayToBase64(original)
      const decoded = base64ToUint8Array(base64)

      expect(decoded).toEqual(original)
    })
  })

  describe('Full E2EE Flow', () => {
    it('complete encryption workflow', async () => {
      // 1. Generate recovery phrase
      const phrase = generateRecoveryPhrase()
      expect(validateRecoveryPhrase(phrase)).toBe(true)

      // 2. Derive master key
      const entropy = phraseToEntropy(phrase)
      const salt = await generateSalt()
      const masterKey = await deriveMasterKey(entropy, salt)

      // 3. Derive all sub-keys
      const keys = await deriveAllKeys(masterKey)

      // 4. Generate device signing keypair
      const deviceKeyPair = await generateDeviceSigningKeyPair('test-device')

      // 5. Generate file key
      const fileKey = await generateFileKey()

      // 6. Encrypt data
      const plaintext = new TextEncoder().encode('My secret note content')
      const encrypted = await encryptWithWrappedKey(plaintext, fileKey, keys.vaultKey)

      // 7. Create and sign payload
      const payload: SignaturePayloadV1 = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'note',
        cryptoVersion: CRYPTO_VERSION,
        encryptedKey: encrypted.encryptedKey,
        keyNonce: encrypted.keyNonce,
        encryptedData: encrypted.encryptedData,
        dataNonce: encrypted.dataNonce
      }

      const { signature } = await signPayload(
        payload,
        deviceKeyPair.privateKey,
        deviceKeyPair.deviceId
      )

      // 8. Verify signature
      const verification = await verifyPayload(payload, signature, deviceKeyPair.publicKey)
      expect(verification.valid).toBe(true)

      // 9. Decrypt data
      const decrypted = await decryptWithWrappedKey(
        encrypted.encryptedData,
        encrypted.dataNonce,
        encrypted.encryptedKey,
        encrypted.keyNonce,
        keys.vaultKey
      )

      expect(new TextDecoder().decode(decrypted)).toBe('My secret note content')

      // 10. Clean up sensitive data
      await secureZero(masterKey)
      await secureZero(keys.vaultKey)
      await secureZero(fileKey)
    })
  })
})
