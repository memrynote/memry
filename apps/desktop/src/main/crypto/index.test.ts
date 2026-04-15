import { beforeAll, describe, expect, it } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'

import * as crypto from './index'

beforeAll(async () => {
  await sodium.ready
})

const expectedFunctions = [
  // keys
  'deriveKey',
  'deriveMasterKey',
  'generateFileKey',
  'generateDeviceSigningKeyPair',
  'getDevicePublicKey',
  'getOrCreateSigningKeyPair',
  'generateKeyVerifier',
  'generateSalt',
  'getOrDeriveVaultKey',
  'generateX25519KeyPair',
  'computeSharedSecret',
  'deriveLinkingKeys',
  'computeVerificationCode',
  'computeLinkingProof',
  'computeKeyConfirm',
  // recovery
  'generateRecoveryPhrase',
  'phraseToSeed',
  'recoverMasterKeyFromPhrase',
  'validateKeyVerifier',
  'validateRecoveryPhrase',
  // encryption
  'decrypt',
  'decryptMasterKeyFromLinking',
  'encrypt',
  'encryptMasterKeyForLinking',
  'generateNonce',
  'unwrapFileKey',
  'wrapFileKey',
  // signatures
  'signPayload',
  'verifySignature',
  // cbor
  'encodeCbor',
  // keychain
  'deleteKey',
  'retrieveKey',
  'storeKey',
  // primitives
  'secureCleanup',
  // memory-lock
  'lockKeyMaterial',
  'unlockKeyMaterial',
  // local
  'constantTimeEqual',
  'initCrypto'
] as const

describe('crypto/index public surface', () => {
  it.each(expectedFunctions)('re-exports %s as a function', (name) => {
    // #given the public crypto barrel
    // #then each named export is a function
    const value = (crypto as Record<string, unknown>)[name]
    expect(value, `expected ${name} to be exported`).toBeDefined()
    expect(typeof value, `expected ${name} to be a function`).toBe('function')
  })

  it('re-exports CBOR_FIELD_ORDER as an object value', () => {
    // #given CBOR_FIELD_ORDER from the barrel
    // #then it is a defined object (not a function)
    expect(crypto.CBOR_FIELD_ORDER).toBeDefined()
    expect(typeof crypto.CBOR_FIELD_ORDER).toBe('object')
    expect(crypto.CBOR_FIELD_ORDER.SYNC_ITEM).toBeDefined()
  })
})

describe('constantTimeEqual', () => {
  it('returns true for byte-identical arrays', () => {
    // #given two equal Uint8Arrays
    const a = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const b = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

    // #then comparison is true
    expect(crypto.constantTimeEqual(a, b)).toBe(true)
  })

  it('returns false when a single byte differs', () => {
    // #given two arrays differing by exactly one byte
    const a = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const b = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 9])

    // #then comparison is false
    expect(crypto.constantTimeEqual(a, b)).toBe(false)
  })

  it('returns false for arrays of different lengths', () => {
    // #given arrays of mismatched lengths
    const a = new Uint8Array([1, 2, 3, 4])
    const b = new Uint8Array([1, 2, 3, 4, 5])

    // #then comparison short-circuits to false
    expect(crypto.constantTimeEqual(a, b)).toBe(false)
  })

  it('returns true for two empty arrays', () => {
    // #given two zero-length arrays
    const a = new Uint8Array(0)
    const b = new Uint8Array(0)

    // #then they are considered equal
    expect(crypto.constantTimeEqual(a, b)).toBe(true)
  })

  it('returns false when the first byte differs', () => {
    // #given arrays differing only at index 0
    const a = new Uint8Array([0xff, 0, 0, 0])
    const b = new Uint8Array([0x00, 0, 0, 0])

    // #then comparison is false
    expect(crypto.constantTimeEqual(a, b)).toBe(false)
  })
})

describe('initCrypto', () => {
  it('resolves on first call', async () => {
    // #when initCrypto is awaited
    // #then it resolves without throwing
    await expect(crypto.initCrypto()).resolves.toBeUndefined()
  })

  it('is idempotent across repeated calls', async () => {
    // #given two sequential calls
    // #then both resolve cleanly
    await expect(crypto.initCrypto()).resolves.toBeUndefined()
    await expect(crypto.initCrypto()).resolves.toBeUndefined()
  })
})
