import { describe, it, expect } from 'vitest'
import {
  CRYPTO_VERSION,
  HKDF_CONTEXTS,
  ARGON2_PARAMS,
  XCHACHA_PARAMS,
  ED25519_PARAMS,
  X25519_PARAMS,
  EncryptedItemSchema,
  EncryptedCrdtItemSchema,
  SignaturePayloadV1Schema,
  incrementClock,
  mergeClock,
  compareClock,
  clockDominates,
  emptyClock
} from '@shared/contracts/crypto'

describe('Crypto Contracts', () => {
  describe('Constants', () => {
    it('should have correct crypto version', () => {
      expect(CRYPTO_VERSION).toBe(1)
    })

    it('should have all HKDF contexts', () => {
      expect(HKDF_CONTEXTS).toEqual({
        VAULT_KEY: 'memry-vault-key-v1',
        SIGNING_KEY: 'memry-signing-key-v1',
        VERIFY_KEY: 'memry-verify-key-v1',
        LINKING_ENC: 'memry-linking-enc-v1',
        LINKING_MAC: 'memry-linking-mac-v1',
        KEY_VERIFY_INPUT: 'memry-key-verify-v1'
      })
    })

    it('should have correct Argon2 parameters', () => {
      expect(ARGON2_PARAMS).toEqual({
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 1,
        keyLength: 32
      })
    })

    it('should have correct XChaCha20-Poly1305 parameters', () => {
      expect(XCHACHA_PARAMS).toEqual({
        nonceSize: 24,
        keySize: 32,
        tagSize: 16
      })
    })

    it('should have correct Ed25519 parameters', () => {
      expect(ED25519_PARAMS).toEqual({
        publicKeySize: 32,
        privateKeySize: 64,
        seedSize: 32,
        signatureSize: 64
      })
    })

    it('should have correct X25519 parameters', () => {
      expect(X25519_PARAMS).toEqual({
        publicKeySize: 32,
        privateKeySize: 32,
        sharedSecretSize: 32
      })
    })
  })

  describe('EncryptedItemSchema', () => {
    const validItem = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      type: 'note' as const,
      cryptoVersion: CRYPTO_VERSION,
      encryptedKey: 'SGVsbG8gV29ybGQ=',
      keyNonce: 'SGVsbG8gV29ybGQ=',
      encryptedData: 'SGVsbG8gV29ybGQ=',
      dataNonce: 'SGVsbG8gV29ybGQ=',
      signature: 'SGVsbG8gV29ybGQ=',
      signerDeviceId: '123e4567-e89b-12d3-a456-426614174001',
      signedAt: Date.now(),
      clock: { device1: 5 },
      fieldClocks: {
        title: { device1: 3 },
        content: { device1: 5, device2: 2 }
      }
    }

    it('should validate valid encrypted item', () => {
      const result = EncryptedItemSchema.parse(validItem)
      expect(result.type).toBe('note')
      expect(result.cryptoVersion).toBe(CRYPTO_VERSION)
    })

    it('should validate without optional fields', () => {
      const minimal = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        type: 'task' as const,
        cryptoVersion: CRYPTO_VERSION,
        encryptedKey: 'SGVsbG8gV29ybGQ=',
        keyNonce: 'SGVsbG8gV29ybGQ=',
        encryptedData: 'SGVsbG8gV29ybGQ=',
        dataNonce: 'SGVsbG8gV29ybGQ=',
        signature: 'SGVsbG8gV29ybGQ=',
        signerDeviceId: '123e4567-e89b-12d3-a456-426614174001'
      }
      const result = EncryptedItemSchema.parse(minimal)
      expect(result.signedAt).toBeUndefined()
      expect(result.clock).toBeUndefined()
    })

    it('should reject invalid type', () => {
      const invalid = { ...validItem, type: 'invalid' as any }
      expect(() => EncryptedItemSchema.parse(invalid)).toThrow()
    })

    it('should reject invalid crypto version', () => {
      const invalid = { ...validItem, cryptoVersion: 2 }
      expect(() => EncryptedItemSchema.parse(invalid)).toThrow()
    })

    it('should reject invalid UUID', () => {
      const invalid = { ...validItem, id: 'not-a-uuid' }
      expect(() => EncryptedItemSchema.parse(invalid)).toThrow()
    })
  })

  describe('EncryptedCrdtItemSchema', () => {
    const validCrdtItem = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      type: 'note' as const,
      cryptoVersion: CRYPTO_VERSION,
      encryptedSnapshot: 'SGVsbG8gV29ybGQ=',
      snapshotNonce: 'SGVsbG8gV29ybGQ=',
      stateVector: 'SGVsbG8gV29ybGQ=',
      encryptedKey: 'SGVsbG8gV29ybGQ=',
      keyNonce: 'SGVsbG8gV29ybGQ=',
      signature: 'SGVsbG8gV29ybGQ=',
      signerDeviceId: '123e4567-e89b-12d3-a456-426614174001',
      updates: [
        {
          encryptedData: 'SGVsbG8gV29ybGQ=',
          nonce: 'SGVsbG8gV29ybGQ=',
          timestamp: Date.now(),
          signature: 'SGVsbG8gV29ybGQ='
        }
      ]
    }

    it('should validate valid CRDT item', () => {
      const result = EncryptedCrdtItemSchema.parse(validCrdtItem)
      expect(result.type).toBe('note')
      expect(result.updates).toHaveLength(1)
    })

    it('should reject non-note type for CRDT', () => {
      const invalid = { ...validCrdtItem, type: 'task' as any }
      expect(() => EncryptedCrdtItemSchema.parse(invalid)).toThrow()
    })

    it('should validate empty updates array', () => {
      const withEmptyUpdates = { ...validCrdtItem, updates: [] }
      const result = EncryptedCrdtItemSchema.parse(withEmptyUpdates)
      expect(result.updates).toEqual([])
    })
  })

  describe('SignaturePayloadV1Schema', () => {
    const validPayload = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      type: 'note',
      operation: 'create' as const,
      cryptoVersion: CRYPTO_VERSION,
      encryptedKey: 'SGVsbG8gV29ybGQ=',
      keyNonce: 'SGVsbG8gV29ybGQ=',
      encryptedData: 'SGVsbG8gV29ybGQ=',
      dataNonce: 'SGVsbG8gV29ybGQ=',
      metadata: {
        clock: { device1: 5 },
        fieldClocks: {
          title: { device1: 3 }
        },
        stateVector: 'SGVsbG8gV29ybGQ='
      }
    }

    it('should validate valid signature payload', () => {
      const result = SignaturePayloadV1Schema.parse(validPayload)
      expect(result.operation).toBe('create')
      expect(result.metadata?.clock).toEqual({ device1: 5 })
    })

    it('should validate without operation', () => {
      const withoutOp = { ...validPayload, operation: undefined }
      const result = SignaturePayloadV1Schema.parse(withoutOp)
      expect(result.operation).toBeUndefined()
    })

    it('should validate without metadata', () => {
      const withoutMeta = { ...validPayload, metadata: undefined }
      const result = SignaturePayloadV1Schema.parse(withoutMeta)
      expect(result.metadata).toBeUndefined()
    })

    it('should reject invalid operation', () => {
      const invalid = { ...validPayload, operation: 'invalid' as any }
      expect(() => SignaturePayloadV1Schema.parse(invalid)).toThrow()
    })
  })

  describe('Vector Clock Functions', () => {
    // These are already tested in sync-api.test.ts but let's verify they're accessible
    it('should export vector clock functions', () => {
      expect(typeof incrementClock).toBe('function')
      expect(typeof mergeClock).toBe('function')
      expect(typeof compareClock).toBe('function')
      expect(typeof clockDominates).toBe('function')
      expect(typeof emptyClock).toBe('function')
    })

    it('emptyClock should work', () => {
      const clock = emptyClock()
      expect(clock).toEqual({})
    })
  })
})
