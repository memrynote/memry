import { describe, it, expect, beforeAll } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import { initCrypto } from '../crypto/index'
import { encryptCrdtUpdate, decryptCrdtUpdate } from './crdt-encrypt'
import { SignatureVerificationError } from './decrypt'

beforeAll(async () => {
  await initCrypto()
})

function generateTestKeys() {
  const vaultKey = sodium.randombytes_buf(32)
  const keyPair = sodium.crypto_sign_keypair()
  return {
    vaultKey,
    signingSecretKey: keyPair.privateKey,
    signingPublicKey: keyPair.publicKey
  }
}

describe('crdt-encrypt', () => {
  const noteId = 'note-test-abc-123'

  describe('#given a valid CRDT update #when encrypting and decrypting', () => {
    it('#then round-trips to identical plaintext', () => {
      const keys = generateTestKeys()
      const original = new TextEncoder().encode('hello crdt world')

      const packed = encryptCrdtUpdate(original, keys.vaultKey, noteId, keys.signingSecretKey)
      const decrypted = decryptCrdtUpdate(packed, keys.vaultKey, noteId, keys.signingPublicKey)

      expect(decrypted).toEqual(original)
    })

    it('#then round-trips large binary updates', () => {
      const keys = generateTestKeys()
      const original = sodium.randombytes_buf(4096)

      const packed = encryptCrdtUpdate(original, keys.vaultKey, noteId, keys.signingSecretKey)
      const decrypted = decryptCrdtUpdate(packed, keys.vaultKey, noteId, keys.signingPublicKey)

      expect(decrypted).toEqual(original)
    })
  })

  describe('#given wrong noteId #when decrypting', () => {
    it('#then throws due to AEAD mismatch', () => {
      const keys = generateTestKeys()
      const original = new TextEncoder().encode('bound to note A')

      const packed = encryptCrdtUpdate(original, keys.vaultKey, 'note-A', keys.signingSecretKey)

      expect(() =>
        decryptCrdtUpdate(packed, keys.vaultKey, 'note-B', keys.signingPublicKey)
      ).toThrow()
    })
  })

  describe('#given tampered signature #when decrypting', () => {
    it('#then throws SignatureVerificationError', () => {
      const keys = generateTestKeys()
      const original = new TextEncoder().encode('signed data')

      const packed = encryptCrdtUpdate(original, keys.vaultKey, noteId, keys.signingSecretKey)

      packed[72] ^= 0xff

      expect(() => decryptCrdtUpdate(packed, keys.vaultKey, noteId, keys.signingPublicKey)).toThrow(
        SignatureVerificationError
      )
    })
  })

  describe('#given wrong signer key #when decrypting', () => {
    it('#then throws SignatureVerificationError', () => {
      const keys = generateTestKeys()
      const wrongKeys = generateTestKeys()
      const original = new TextEncoder().encode('wrong signer')

      const packed = encryptCrdtUpdate(original, keys.vaultKey, noteId, keys.signingSecretKey)

      expect(() =>
        decryptCrdtUpdate(packed, keys.vaultKey, noteId, wrongKeys.signingPublicKey)
      ).toThrow(SignatureVerificationError)
    })
  })

  describe('#given compression #when encrypting small vs large data', () => {
    it('#then compressed output is smaller than uncompressed for large repetitive data', () => {
      const keys = generateTestKeys()
      const repetitive = new Uint8Array(1024).fill(42)

      const packed = encryptCrdtUpdate(repetitive, keys.vaultKey, noteId, keys.signingSecretKey)

      // Packed overhead: 160 header + AEAD tag (16) + compression flag (1) + compressed data
      // Without compression, minimum would be 160 + 16 + 1 + 1024 = 1201
      // With compression of all-same-byte data, should be much less
      expect(packed.length).toBeLessThan(1201)

      const decrypted = decryptCrdtUpdate(packed, keys.vaultKey, noteId, keys.signingPublicKey)
      expect(decrypted).toEqual(repetitive)
    })

    it('#then small data skips compression but still round-trips', () => {
      const keys = generateTestKeys()
      const tiny = new Uint8Array([1, 2, 3])

      const packed = encryptCrdtUpdate(tiny, keys.vaultKey, noteId, keys.signingSecretKey)
      const decrypted = decryptCrdtUpdate(packed, keys.vaultKey, noteId, keys.signingPublicKey)

      expect(decrypted).toEqual(tiny)
    })
  })

  describe('#given a too-short packed buffer #when decrypting', () => {
    it('#then throws with descriptive message', () => {
      const keys = generateTestKeys()
      const short = new Uint8Array(10)

      expect(() => decryptCrdtUpdate(short, keys.vaultKey, noteId, keys.signingPublicKey)).toThrow(
        'CRDT update too short'
      )
    })
  })
})
