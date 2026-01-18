/**
 * Signatures Tests
 *
 * Tests Ed25519 digital signatures and HMAC functions.
 *
 * @module main/crypto/signatures.test
 */

import { describe, it, expect } from 'vitest'
import {
  sign,
  verify,
  signRaw,
  verifyRaw,
  signItem,
  verifyItem,
  signToBase64,
  verifyFromBase64,
  computeHmac,
  verifyHmac,
  computeHmacRaw,
  verifyHmacRaw
} from './signatures'
import { canonicalEncode } from './cbor'
import { generateSigningKeyPair } from './keys'
import {
  TEST_SIGNING_SEED,
  TEST_HMAC_KEY,
  TEST_SIGNATURE_PAYLOAD,
  TEST_SIGNATURE_PAYLOAD_WITH_METADATA,
  TEST_SIMPLE_OBJECT
} from './__fixtures__'
import {
  expectBufferEqual,
  expectBufferNotEqual,
  generateTestKeyPair,
  randomKey,
  expectToThrow,
  expectValidBase64
} from './__helpers__'

describe('signatures', () => {
  // Generate a test key pair for all tests
  const testKeyPair = generateSigningKeyPair(TEST_SIGNING_SEED)

  describe('sign/verify', () => {
    it('should sign data and verify signature', () => {
      const data = { message: 'Hello, World!' }
      const signature = sign(data, testKeyPair.secretKey)

      const isValid = verify(signature, data, testKeyPair.publicKey)

      expect(isValid).toBe(true)
    })

    it('should fail verification with wrong public key', () => {
      const data = { message: 'Hello, World!' }
      const signature = sign(data, testKeyPair.secretKey)

      const otherKeyPair = generateTestKeyPair()
      const isValid = verify(signature, data, otherKeyPair.publicKey)

      expect(isValid).toBe(false)
    })

    it('should fail verification with tampered data', () => {
      const data = { message: 'Hello, World!' }
      const signature = sign(data, testKeyPair.secretKey)

      const tamperedData = { message: 'Hello, Hacker!' }
      const isValid = verify(signature, tamperedData, testKeyPair.publicKey)

      expect(isValid).toBe(false)
    })

    it('should fail verification with tampered signature', () => {
      const data = { message: 'Hello, World!' }
      const signature = sign(data, testKeyPair.secretKey)

      // Tamper with signature
      const tamperedSignature = Buffer.from(signature)
      tamperedSignature[0] ^= 0xff

      const isValid = verify(tamperedSignature, data, testKeyPair.publicKey)

      expect(isValid).toBe(false)
    })

    it('should produce 64-byte signature', () => {
      const data = { test: 'data' }
      const signature = sign(data, testKeyPair.secretKey)

      expect(signature).toBeInstanceOf(Buffer)
      expect(signature.length).toBe(64)
    })

    it('should reject secret key of wrong length', () => {
      const shortKey = Buffer.alloc(32, 0x42)

      expectToThrow(() => sign({ test: 'data' }, shortKey), 'Secret key must be 64 bytes')
    })

    it('should sign object data via canonical CBOR', () => {
      const data = { b: 2, a: 1 }
      const signature = sign(data, testKeyPair.secretKey)

      // Verify should work regardless of key order
      const isValid = verify(signature, { a: 1, b: 2 }, testKeyPair.publicKey)

      expect(isValid).toBe(true)
    })

    it('should return false for wrong signature length', () => {
      const data = { test: 'data' }
      const shortSignature = Buffer.alloc(32, 0x42)

      const isValid = verify(shortSignature, data, testKeyPair.publicKey)

      expect(isValid).toBe(false)
    })

    it('should return false for wrong public key length', () => {
      const data = { test: 'data' }
      const signature = sign(data, testKeyPair.secretKey)
      const shortPublicKey = Buffer.alloc(16, 0x42)

      const isValid = verify(signature, data, shortPublicKey)

      expect(isValid).toBe(false)
    })
  })

  describe('signRaw/verifyRaw', () => {
    it('should sign pre-encoded bytes', () => {
      const message = canonicalEncode(TEST_SIMPLE_OBJECT)
      const signature = signRaw(message, testKeyPair.secretKey)

      expect(signature).toBeInstanceOf(Buffer)
      expect(signature.length).toBe(64)
    })

    it('should verify pre-encoded bytes', () => {
      const message = canonicalEncode(TEST_SIMPLE_OBJECT)
      const signature = signRaw(message, testKeyPair.secretKey)

      const isValid = verifyRaw(signature, message, testKeyPair.publicKey)

      expect(isValid).toBe(true)
    })

    it('should be consistent with sign/verify for same data', () => {
      const data = TEST_SIMPLE_OBJECT
      const message = canonicalEncode(data)

      const signature1 = sign(data, testKeyPair.secretKey)
      const signature2 = signRaw(message, testKeyPair.secretKey)

      // Signatures should be identical for same data
      expectBufferEqual(signature1, signature2)
    })

    it('should reject secret key of wrong length', () => {
      const message = canonicalEncode({ test: 'data' })
      const shortKey = Buffer.alloc(32, 0x42)

      expectToThrow(() => signRaw(message, shortKey), 'Secret key must be 64 bytes')
    })

    it('should work with Uint8Array input', () => {
      const message = new Uint8Array([1, 2, 3, 4, 5])
      const signature = signRaw(message, testKeyPair.secretKey)

      const isValid = verifyRaw(signature, message, testKeyPair.publicKey)

      expect(isValid).toBe(true)
    })
  })

  describe('signItem/verifyItem', () => {
    it('should sign encrypted item payload', () => {
      const signature = signItem(TEST_SIGNATURE_PAYLOAD, testKeyPair.secretKey)

      expect(signature).toBeInstanceOf(Buffer)
      expect(signature.length).toBe(64)
    })

    it('should verify encrypted item payload', () => {
      const signature = signItem(TEST_SIGNATURE_PAYLOAD, testKeyPair.secretKey)
      const isValid = verifyItem(signature, TEST_SIGNATURE_PAYLOAD, testKeyPair.publicKey)

      expect(isValid).toBe(true)
    })

    it('should include all required fields in signature', () => {
      // Changing any required field should invalidate signature
      const signature = signItem(TEST_SIGNATURE_PAYLOAD, testKeyPair.secretKey)

      // Change ID
      const modifiedId = { ...TEST_SIGNATURE_PAYLOAD, id: 'different-id' }
      expect(verifyItem(signature, modifiedId, testKeyPair.publicKey)).toBe(false)

      // Change type
      const modifiedType = { ...TEST_SIGNATURE_PAYLOAD, type: 'task' }
      expect(verifyItem(signature, modifiedType, testKeyPair.publicKey)).toBe(false)

      // Change cryptoVersion
      const modifiedVersion = { ...TEST_SIGNATURE_PAYLOAD, cryptoVersion: 2 }
      expect(verifyItem(signature, modifiedVersion, testKeyPair.publicKey)).toBe(false)

      // Change encryptedData
      const modifiedData = { ...TEST_SIGNATURE_PAYLOAD, encryptedData: 'different-data' }
      expect(verifyItem(signature, modifiedData, testKeyPair.publicKey)).toBe(false)
    })

    it('should include optional metadata in signature', () => {
      const signature = signItem(TEST_SIGNATURE_PAYLOAD_WITH_METADATA, testKeyPair.secretKey)

      // Signature should verify with same metadata
      expect(
        verifyItem(signature, TEST_SIGNATURE_PAYLOAD_WITH_METADATA, testKeyPair.publicKey)
      ).toBe(true)

      // Changing metadata should invalidate signature
      const modifiedMetadata = {
        ...TEST_SIGNATURE_PAYLOAD_WITH_METADATA,
        metadata: {
          ...TEST_SIGNATURE_PAYLOAD_WITH_METADATA.metadata,
          clock: { 'device-a': 99 }
        }
      }
      expect(verifyItem(signature, modifiedMetadata, testKeyPair.publicKey)).toBe(false)
    })

    it('should fail verification if any field changed', () => {
      const signature = signItem(TEST_SIGNATURE_PAYLOAD, testKeyPair.secretKey)

      const fields = ['id', 'type', 'encryptedKey', 'keyNonce', 'encryptedData', 'dataNonce']

      for (const field of fields) {
        const modified = { ...TEST_SIGNATURE_PAYLOAD, [field]: 'changed-value' }
        const isValid = verifyItem(signature, modified, testKeyPair.publicKey)

        expect(isValid).toBe(false)
      }
    })

    it('should handle operation field', () => {
      const payloadWithOp = { ...TEST_SIGNATURE_PAYLOAD, operation: 'create' as const }
      const signature = signItem(payloadWithOp, testKeyPair.secretKey)

      expect(verifyItem(signature, payloadWithOp, testKeyPair.publicKey)).toBe(true)

      // Changing operation should invalidate
      const modifiedOp = { ...payloadWithOp, operation: 'update' as const }
      expect(verifyItem(signature, modifiedOp, testKeyPair.publicKey)).toBe(false)
    })
  })

  describe('signToBase64/verifyFromBase64', () => {
    it('should produce valid Base64 signature', () => {
      const signature = signToBase64(TEST_SIMPLE_OBJECT, testKeyPair.secretKey)

      expectValidBase64(signature)
    })

    it('should verify Base64 signature', () => {
      const signature = signToBase64(TEST_SIMPLE_OBJECT, testKeyPair.secretKey)
      const isValid = verifyFromBase64(signature, TEST_SIMPLE_OBJECT, testKeyPair.publicKey)

      expect(isValid).toBe(true)
    })

    it('should round-trip correctly', () => {
      const data = { complex: { nested: { data: 123 } } }
      const signature = signToBase64(data, testKeyPair.secretKey)
      const isValid = verifyFromBase64(signature, data, testKeyPair.publicKey)

      expect(isValid).toBe(true)
    })

    it('should return false for invalid Base64', () => {
      const isValid = verifyFromBase64(
        'not-valid-base64!!!',
        TEST_SIMPLE_OBJECT,
        testKeyPair.publicKey
      )

      expect(isValid).toBe(false)
    })

    it('should return false for truncated signature', () => {
      const signature = signToBase64(TEST_SIMPLE_OBJECT, testKeyPair.secretKey)
      const truncated = signature.slice(0, signature.length - 10)

      const isValid = verifyFromBase64(truncated, TEST_SIMPLE_OBJECT, testKeyPair.publicKey)

      expect(isValid).toBe(false)
    })
  })

  describe('computeHmac/verifyHmac', () => {
    it('should compute 32-byte HMAC', () => {
      const hmac = computeHmac(TEST_HMAC_KEY, TEST_SIMPLE_OBJECT)

      expect(hmac).toBeInstanceOf(Buffer)
      expect(hmac.length).toBe(32)
    })

    it('should verify correct HMAC', () => {
      const hmac = computeHmac(TEST_HMAC_KEY, TEST_SIMPLE_OBJECT)
      const isValid = verifyHmac(hmac, TEST_HMAC_KEY, TEST_SIMPLE_OBJECT)

      expect(isValid).toBe(true)
    })

    it('should fail verification with wrong key', () => {
      const hmac = computeHmac(TEST_HMAC_KEY, TEST_SIMPLE_OBJECT)
      const wrongKey = randomKey(32)

      const isValid = verifyHmac(hmac, wrongKey, TEST_SIMPLE_OBJECT)

      expect(isValid).toBe(false)
    })

    it('should fail verification with wrong data', () => {
      const hmac = computeHmac(TEST_HMAC_KEY, TEST_SIMPLE_OBJECT)
      const wrongData = { different: 'data' }

      const isValid = verifyHmac(hmac, TEST_HMAC_KEY, wrongData)

      expect(isValid).toBe(false)
    })

    it('should reject key of wrong length', () => {
      const shortKey = Buffer.alloc(16, 0x42)

      expectToThrow(() => computeHmac(shortKey, TEST_SIMPLE_OBJECT), 'HMAC key must be 32 bytes')
    })

    it('should use canonical CBOR encoding', () => {
      // Same data in different order should produce same HMAC
      const data1 = { b: 2, a: 1 }
      const data2 = { a: 1, b: 2 }

      const hmac1 = computeHmac(TEST_HMAC_KEY, data1)
      const hmac2 = computeHmac(TEST_HMAC_KEY, data2)

      expectBufferEqual(hmac1, hmac2)
    })

    it('should return false for wrong HMAC length', () => {
      const shortHmac = Buffer.alloc(16, 0x42)

      const isValid = verifyHmac(shortHmac, TEST_HMAC_KEY, TEST_SIMPLE_OBJECT)

      expect(isValid).toBe(false)
    })

    it('should return false for wrong key length in verification', () => {
      const hmac = computeHmac(TEST_HMAC_KEY, TEST_SIMPLE_OBJECT)
      const shortKey = Buffer.alloc(16, 0x42)

      const isValid = verifyHmac(hmac, shortKey, TEST_SIMPLE_OBJECT)

      expect(isValid).toBe(false)
    })
  })

  describe('computeHmacRaw/verifyHmacRaw', () => {
    it('should compute HMAC over raw bytes', () => {
      const message = Buffer.from('raw message bytes')
      const hmac = computeHmacRaw(TEST_HMAC_KEY, message)

      expect(hmac).toBeInstanceOf(Buffer)
      expect(hmac.length).toBe(32)
    })

    it('should verify HMAC over raw bytes', () => {
      const message = Buffer.from('raw message bytes')
      const hmac = computeHmacRaw(TEST_HMAC_KEY, message)

      const isValid = verifyHmacRaw(hmac, TEST_HMAC_KEY, message)

      expect(isValid).toBe(true)
    })

    it('should work with Uint8Array input', () => {
      const message = new Uint8Array([1, 2, 3, 4, 5])
      const hmac = computeHmacRaw(TEST_HMAC_KEY, message)

      const isValid = verifyHmacRaw(hmac, TEST_HMAC_KEY, message)

      expect(isValid).toBe(true)
    })

    it('should fail verification with wrong message', () => {
      const message = Buffer.from('original message')
      const hmac = computeHmacRaw(TEST_HMAC_KEY, message)

      const wrongMessage = Buffer.from('different message')
      const isValid = verifyHmacRaw(hmac, TEST_HMAC_KEY, wrongMessage)

      expect(isValid).toBe(false)
    })

    it('should return false for wrong HMAC length', () => {
      const message = Buffer.from('test message')
      const shortHmac = Buffer.alloc(16, 0x42)

      const isValid = verifyHmacRaw(shortHmac, TEST_HMAC_KEY, message)

      expect(isValid).toBe(false)
    })

    it('should return false for wrong key length', () => {
      const message = Buffer.from('test message')
      const hmac = computeHmacRaw(TEST_HMAC_KEY, message)
      const shortKey = Buffer.alloc(16, 0x42)

      const isValid = verifyHmacRaw(hmac, shortKey, message)

      expect(isValid).toBe(false)
    })
  })

  describe('deterministic signatures', () => {
    it('should produce same signature for same data + key (Ed25519 is deterministic)', () => {
      const data = { test: 'deterministic signature test' }

      const signature1 = sign(data, testKeyPair.secretKey)
      const signature2 = sign(data, testKeyPair.secretKey)

      expectBufferEqual(signature1, signature2)
    })

    it('should produce consistent signatures across multiple calls', () => {
      const data = TEST_SIGNATURE_PAYLOAD
      const signatures: Buffer[] = []

      for (let i = 0; i < 5; i++) {
        signatures.push(signItem(data, testKeyPair.secretKey))
      }

      // All signatures should be identical
      for (let i = 1; i < signatures.length; i++) {
        expectBufferEqual(signatures[0], signatures[i])
      }
    })

    it('should produce different signatures for different data', () => {
      const data1 = { message: 'first message' }
      const data2 = { message: 'second message' }

      const signature1 = sign(data1, testKeyPair.secretKey)
      const signature2 = sign(data2, testKeyPair.secretKey)

      expectBufferNotEqual(signature1, signature2)
    })

    it('should produce different signatures for different keys', () => {
      const data = { message: 'same message' }
      const otherKeyPair = generateTestKeyPair()

      const signature1 = sign(data, testKeyPair.secretKey)
      const signature2 = sign(data, otherKeyPair.secretKey)

      expectBufferNotEqual(signature1, signature2)
    })
  })
})
