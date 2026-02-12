import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { decode } from 'cborg'
import sodium from 'libsodium-wrappers-sumo'
import keytar from 'keytar'

vi.mock('keytar', () => ({
  default: {
    setPassword: vi.fn(),
    getPassword: vi.fn(),
    deletePassword: vi.fn()
  }
}))

import {
  CBOR_FIELD_ORDER,
  constantTimeEqual,
  decrypt,
  deriveKey,
  deriveMasterKey,
  encodeCbor,
  encrypt,
  generateDeviceSigningKeyPair,
  generateFileKey,
  generateKeyVerifier,
  generateNonce,
  generateRecoveryPhrase,
  generateSalt,
  getDevicePublicKey,
  initCrypto,
  phraseToSeed,
  retrieveKey,
  secureCleanup,
  signPayload,
  storeKey,
  unwrapFileKey,
  validateRecoveryPhrase,
  verifySignature,
  wrapFileKey,
  deleteKey
} from './index'
import { ARGON2_PARAMS, KEYCHAIN_ENTRIES, XCHACHA20_PARAMS } from '@shared/contracts/crypto'

describe('crypto foundation', () => {
  beforeAll(async () => {
    await sodium.ready
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('encodes CBOR with canonical field order, skips undefined, rejects extra keys', () => {
    const encoded = encodeCbor(
      {
        encryptedData: 'cipher',
        id: 'item-1',
        dataNonce: 'nonce',
        metadata: undefined,
        type: 'task',
        operation: 'create',
        cryptoVersion: 1,
        encryptedKey: 'key',
        keyNonce: 'nonce-key'
      },
      CBOR_FIELD_ORDER.SYNC_ITEM
    )

    const decoded = decode(encoded, { useMaps: true })
    expect(decoded).toBeInstanceOf(Map)

    const map = decoded as Map<string, unknown>
    expect(new Set(map.keys())).toEqual(
      new Set([
        'id',
        'type',
        'operation',
        'cryptoVersion',
        'encryptedKey',
        'keyNonce',
        'encryptedData',
        'dataNonce'
      ])
    )
    expect(map.has('metadata')).toBe(false)

    expect(() =>
      encodeCbor(
        { id: 'item-1', type: 'task', extraField: 'bad' },
        CBOR_FIELD_ORDER.SYNC_ITEM
      )
    ).toThrow(/fields not in ordering/)
  })

  it('encrypts and decrypts roundtrip with associated data', () => {
    const key = generateFileKey()
    const plaintext = new TextEncoder().encode('phase2-test-payload')
    const associatedData = new TextEncoder().encode('aad')

    const { ciphertext, nonce } = encrypt(plaintext, key, associatedData)
    const recovered = decrypt(ciphertext, nonce, key, associatedData)

    expect(new TextDecoder().decode(recovered)).toBe('phase2-test-payload')
    expect(nonce).toHaveLength(XCHACHA20_PARAMS.NONCE_LENGTH)
  })

  it('fails decryption when associated data differs', () => {
    const key = generateFileKey()
    const plaintext = new TextEncoder().encode('phase2-test-payload')
    const { ciphertext, nonce } = encrypt(plaintext, key, new TextEncoder().encode('aad'))

    expect(() => decrypt(ciphertext, nonce, key, new TextEncoder().encode('tampered'))).toThrow()
  })

  it('wraps and unwraps file keys with the vault key', () => {
    const fileKey = generateFileKey()
    const vaultKey = generateFileKey()

    const wrapped = wrapFileKey(fileKey, vaultKey)
    const unwrapped = unwrapFileKey(wrapped.wrappedKey, wrapped.nonce, vaultKey)

    expect(unwrapped).toEqual(fileKey)
  })

  it('generates nonce with required length', () => {
    const nonce = generateNonce()
    expect(nonce).toHaveLength(XCHACHA20_PARAMS.NONCE_LENGTH)
  })

  it('secure cleanup zeroes provided buffers', () => {
    const a = new Uint8Array([1, 2, 3])
    const b = new Uint8Array([4, 5, 6])

    secureCleanup(a, b)

    expect(Array.from(a)).toEqual([0, 0, 0])
    expect(Array.from(b)).toEqual([0, 0, 0])
  })

  it('constantTimeEqual handles equal, unequal, and length mismatch', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false)
    expect(constantTimeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false)
  })

  it('stores, retrieves, and deletes keychain values as base64', async () => {
    const mockedKeytar = vi.mocked(keytar)
    const keyBytes = new Uint8Array([11, 22, 33, 44])

    await storeKey(KEYCHAIN_ENTRIES.MASTER_KEY, keyBytes)

    expect(mockedKeytar.setPassword).toHaveBeenCalledTimes(1)
    expect(mockedKeytar.setPassword).toHaveBeenCalledWith(
      KEYCHAIN_ENTRIES.MASTER_KEY.service,
      KEYCHAIN_ENTRIES.MASTER_KEY.account,
      sodium.to_base64(keyBytes, sodium.base64_variants.ORIGINAL)
    )

    mockedKeytar.getPassword.mockResolvedValueOnce(
      sodium.to_base64(keyBytes, sodium.base64_variants.ORIGINAL)
    )
    const restored = await retrieveKey(KEYCHAIN_ENTRIES.MASTER_KEY)
    expect(restored).toEqual(keyBytes)

    mockedKeytar.getPassword.mockResolvedValueOnce(null)
    const missing = await retrieveKey(KEYCHAIN_ENTRIES.MASTER_KEY)
    expect(missing).toBeNull()

    await deleteKey(KEYCHAIN_ENTRIES.MASTER_KEY)
    expect(mockedKeytar.deletePassword).toHaveBeenCalledWith(
      KEYCHAIN_ENTRIES.MASTER_KEY.service,
      KEYCHAIN_ENTRIES.MASTER_KEY.account
    )
  })

  it('derives keys for known contexts and rejects unknown contexts', async () => {
    const masterKey = generateFileKey()

    const known = await deriveKey(masterKey, 'memry-vault-key-v1', 32)

    expect(known).toHaveLength(32)
    await expect(deriveKey(masterKey, 'custom-context', 16)).rejects.toThrow(
      'Unknown key derivation context: custom-context'
    )
  })

  it('derives master key material and verifier', async () => {
    const seed = await phraseToSeed(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    )
    const salt = generateSalt()

    const material = await deriveMasterKey(seed, salt)

    expect(material.masterKey).toHaveLength(32)
    expect(material.kdfSalt).toBe(sodium.to_base64(salt, sodium.base64_variants.ORIGINAL))
    expect(material.keyVerifier.length).toBeGreaterThan(0)
  })

  it('generates key metadata and validates signing key pair derivation', async () => {
    const salt = generateSalt()
    expect(salt).toHaveLength(ARGON2_PARAMS.SALT_LENGTH)

    const signer = await generateDeviceSigningKeyPair()
    expect(signer.deviceId).toHaveLength(32)
    expect(signer.publicKey).toHaveLength(32)
    expect(signer.secretKey).toHaveLength(64)

    const derivedPublicKey = getDevicePublicKey(signer.secretKey)
    expect(derivedPublicKey).toEqual(signer.publicKey)

    const verifier = await generateKeyVerifier(generateFileKey())
    expect(verifier.length).toBeGreaterThan(0)
  })

  it('generates and validates recovery phrases and deterministic seeds', async () => {
    const generated = await generateRecoveryPhrase()
    expect(validateRecoveryPhrase(generated.phrase)).toBe(true)

    const samplePhrase =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    const seedA = await phraseToSeed(samplePhrase)
    const seedB = await phraseToSeed(samplePhrase)
    expect(seedA).toEqual(seedB)
    expect(validateRecoveryPhrase('invalid words')).toBe(false)
  })

  it('signs and verifies payloads; tampering invalidates signatures', async () => {
    const keyPair = await generateDeviceSigningKeyPair()
    const payload = {
      id: 'item-1',
      type: 'task',
      operation: 'create',
      cryptoVersion: 1,
      encryptedKey: 'key',
      keyNonce: 'nonce-key',
      encryptedData: 'cipher',
      dataNonce: 'nonce-data'
    }

    const signature = signPayload(payload, CBOR_FIELD_ORDER.SYNC_ITEM, keyPair.secretKey)
    const valid = verifySignature(payload, CBOR_FIELD_ORDER.SYNC_ITEM, signature, keyPair.publicKey)

    expect(valid).toBe(true)

    const tampered = { ...payload, encryptedData: 'changed' }
    const invalid = verifySignature(
      tampered,
      CBOR_FIELD_ORDER.SYNC_ITEM,
      signature,
      keyPair.publicKey
    )
    expect(invalid).toBe(false)
  })

  it('initializes sodium readiness', async () => {
    await expect(initCrypto()).resolves.toBeUndefined()
  })
})
