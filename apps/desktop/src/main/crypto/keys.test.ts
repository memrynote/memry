import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import keytar from 'keytar'

import {
  ARGON2_PARAMS,
  KEYCHAIN_ENTRIES,
  KEY_DERIVATION_CONTEXTS,
  LINKING_HKDF_CONTEXTS,
  X25519_PARAMS
} from '@memry/contracts/crypto'

vi.mock('keytar', () => ({
  default: {
    setPassword: vi.fn(),
    getPassword: vi.fn(),
    deletePassword: vi.fn()
  }
}))

import {
  computeKeyConfirm,
  computeLinkingProof,
  computeSharedSecret,
  computeVerificationCode,
  deriveKey,
  deriveLinkingKeys,
  deriveMasterKey,
  generateDeviceSigningKeyPair,
  generateKeyVerifier,
  generateSalt,
  generateX25519KeyPair,
  getDevicePublicKey,
  getOrCreateSigningKeyPair,
  getOrDeriveVaultKey
} from './keys'

beforeAll(async () => {
  await sodium.ready
})

afterEach(() => {
  vi.restoreAllMocks()
})

const FIXED_SEED = new Uint8Array(64).fill(0x42)
const FIXED_SALT = Uint8Array.from([
  0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff
])
const FIXED_MASTER_KEY = new Uint8Array(32).fill(0x5a)
const FIXED_SHARED_SECRET = new Uint8Array(32).fill(0x7c)

describe('deriveMasterKey — Argon2id parameter regression lock', () => {
  it('produces a stable golden hex digest for the canonical (seed, salt) pair', async () => {
    // #given a fixed seed + salt + canonical libsodium Argon2id params
    // #when the master key is derived via real libsodium (no mocks)
    const material = await deriveMasterKey(FIXED_SEED, FIXED_SALT)
    const actualHex = sodium.to_hex(material.masterKey)

    // #then the derived key matches the inline snapshot.
    // Locks canonical parallelism=1 deviation from RFC 9106 spec=4; see MEMORY.md
    // Inputs: ARGON2_PARAMS (opslimit=3, memlimit=64 MiB), ALG_ARGON2ID13, output=32B,
    //         seed=64×0x42, salt=0x00..0xff (16 bytes).
    // If this snapshot drifts, an Argon2id parameter changed — investigate before updating.
    expect(actualHex).toMatchInlineSnapshot(
      `"05e691d50fc4043e5b38f12fbe2f4bbba7a1669a1421795b0d5f445e86e617a3"`
    )
  })

  it('uses ARGON2_PARAMS (opslimit, memlimit) and produces a 32-byte master key', async () => {
    // #given a spy on sodium.crypto_pwhash to capture the params libsodium is called with
    const spy = vi.spyOn(sodium, 'crypto_pwhash')

    // #when
    const material = await deriveMasterKey(FIXED_SEED, FIXED_SALT)

    // #then
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(
      32,
      FIXED_SEED,
      FIXED_SALT,
      ARGON2_PARAMS.OPS_LIMIT,
      ARGON2_PARAMS.MEMORY_LIMIT,
      sodium.crypto_pwhash_ALG_ARGON2ID13
    )
    expect(material.masterKey).toHaveLength(32)
    expect(material.kdfSalt).toBe(sodium.to_base64(FIXED_SALT, sodium.base64_variants.ORIGINAL))
    expect(material.keyVerifier.length).toBeGreaterThan(0)
  })

  it('returns a verifier identical to a direct generateKeyVerifier(masterKey) call', async () => {
    // #given derived material from a fixed seed/salt
    const material = await deriveMasterKey(FIXED_SEED, FIXED_SALT)

    // #when the verifier is recomputed from the same master key bytes
    const fresh = await generateKeyVerifier(new Uint8Array(material.masterKey))

    // #then the values match
    expect(material.keyVerifier).toBe(fresh)
  })

  it('zeros the master key and rethrows when verifier computation fails', async () => {
    // #given the verifier derivation step throws
    const kdfSpy = vi.spyOn(sodium, 'crypto_kdf_derive_from_key').mockImplementation(() => {
      throw new Error('boom')
    })
    const memzeroSpy = vi.spyOn(sodium, 'memzero')

    // #when / #then — derivation fails and the 32-byte master key buffer is zeroed
    await expect(deriveMasterKey(FIXED_SEED, FIXED_SALT)).rejects.toThrow('boom')
    const wipedMasterKey = memzeroSpy.mock.calls.some(
      ([buf]) => buf instanceof Uint8Array && buf.length === 32
    )
    expect(wipedMasterKey).toBe(true)

    kdfSpy.mockRestore()
    memzeroSpy.mockRestore()
  })
})

describe('deriveKey', () => {
  it('produces context-separated outputs for the same master key', async () => {
    // #given a master key
    // #when the key is derived under two different valid contexts
    const vaultKey = await deriveKey(FIXED_MASTER_KEY, KEY_DERIVATION_CONTEXTS.VAULT_KEY, 32)
    const verifierKey = await deriveKey(FIXED_MASTER_KEY, KEY_DERIVATION_CONTEXTS.KEY_VERIFIER, 32)

    // #then the two derived keys differ
    expect(sodium.to_hex(vaultKey)).not.toBe(sodium.to_hex(verifierKey))
    expect(vaultKey).toHaveLength(32)
    expect(verifierKey).toHaveLength(32)
  })

  it('honors the requested output length', async () => {
    // #given valid context
    // #when deriving with a non-standard length
    const derived = await deriveKey(FIXED_MASTER_KEY, KEY_DERIVATION_CONTEXTS.VAULT_KEY, 16)

    // #then output length matches request
    expect(derived).toHaveLength(16)
  })

  it('is deterministic for identical (key, context, length) inputs', async () => {
    // #given a stable input triple
    // #when called twice
    const a = await deriveKey(FIXED_MASTER_KEY, KEY_DERIVATION_CONTEXTS.VAULT_KEY, 32)
    const b = await deriveKey(FIXED_MASTER_KEY, KEY_DERIVATION_CONTEXTS.VAULT_KEY, 32)

    // #then results are equal
    expect(sodium.to_hex(a)).toBe(sodium.to_hex(b))
  })

  it('rejects unknown contexts', async () => {
    await expect(deriveKey(FIXED_MASTER_KEY, 'not-a-real-context', 32)).rejects.toThrow(
      'Unknown key derivation context: not-a-real-context'
    )
  })
})

describe('generateSalt', () => {
  it('returns a buffer of ARGON2_PARAMS.SALT_LENGTH bytes', () => {
    // #given/when
    const salt = generateSalt()

    // #then
    expect(salt).toHaveLength(ARGON2_PARAMS.SALT_LENGTH)
  })

  it('returns unique values across successive calls', () => {
    // #given a small batch of generated salts
    const seen = new Set<string>()
    for (let i = 0; i < 32; i++) {
      seen.add(sodium.to_hex(generateSalt()))
    }

    // #then no duplicates
    expect(seen.size).toBe(32)
  })
})

describe('generateDeviceSigningKeyPair', () => {
  it('produces well-formed Ed25519 key material with a BLAKE2b deviceId', async () => {
    // #given/when
    const keyPair = await generateDeviceSigningKeyPair()

    // #then key shapes match Ed25519 expectations
    expect(keyPair.publicKey).toHaveLength(32)
    expect(keyPair.secretKey).toHaveLength(64)
    expect(keyPair.deviceId).toHaveLength(32)

    // #then deviceId is BLAKE2b-128 of the public key, hex-encoded
    const expectedDeviceId = sodium.to_hex(
      sodium.crypto_generichash(16, keyPair.publicKey, null)
    )
    expect(keyPair.deviceId).toBe(expectedDeviceId)
  })

  it('returns distinct key pairs across successive calls', async () => {
    // #given two freshly generated pairs
    const a = await generateDeviceSigningKeyPair()
    const b = await generateDeviceSigningKeyPair()

    // #then deviceIds and public keys differ
    expect(a.deviceId).not.toBe(b.deviceId)
    expect(sodium.to_hex(a.publicKey)).not.toBe(sodium.to_hex(b.publicKey))
  })

  it('round-trips public key derivation via getDevicePublicKey', async () => {
    // #given a signing key pair
    const keyPair = await generateDeviceSigningKeyPair()

    // #when the public key is derived from the secret key
    const derived = getDevicePublicKey(keyPair.secretKey)

    // #then it matches the pair's public key
    expect(sodium.to_hex(derived)).toBe(sodium.to_hex(keyPair.publicKey))
  })
})

describe('generateKeyVerifier', () => {
  it('returns the same base64 string for the same master key', async () => {
    // #given/when
    const a = await generateKeyVerifier(new Uint8Array(FIXED_MASTER_KEY))
    const b = await generateKeyVerifier(new Uint8Array(FIXED_MASTER_KEY))

    // #then deterministic
    expect(a).toBe(b)
  })

  it('returns different verifiers for different master keys', async () => {
    // #given two distinct master keys
    const k1 = new Uint8Array(32).fill(0x01)
    const k2 = new Uint8Array(32).fill(0x02)

    // #when
    const v1 = await generateKeyVerifier(k1)
    const v2 = await generateKeyVerifier(k2)

    // #then verifiers differ
    expect(v1).not.toBe(v2)
  })

  it('zeros the intermediate verifier key buffer after encoding', async () => {
    // #given a memzero spy
    const memzeroSpy = vi.spyOn(sodium, 'memzero')

    // #when
    await generateKeyVerifier(new Uint8Array(FIXED_MASTER_KEY))

    // #then memzero was called on a 32-byte buffer
    const calls = memzeroSpy.mock.calls.filter(
      ([buf]) => buf instanceof Uint8Array && buf.length === 32
    )
    expect(calls.length).toBeGreaterThanOrEqual(1)

    memzeroSpy.mockRestore()
  })
})

describe('generateX25519KeyPair + computeSharedSecret', () => {
  it('returns key material of the spec-defined lengths', async () => {
    // #given/when
    const pair = await generateX25519KeyPair()

    // #then
    expect(pair.publicKey).toHaveLength(X25519_PARAMS.PUBLIC_KEY_LENGTH)
    expect(pair.secretKey).toHaveLength(X25519_PARAMS.SECRET_KEY_LENGTH)
  })

  it('produces a shared secret that matches between two parties (ECDH roundtrip)', async () => {
    // #given two independently-generated X25519 key pairs
    const alice = await generateX25519KeyPair()
    const bob = await generateX25519KeyPair()

    // #when each party computes the shared secret with their private key + the peer's public key
    const aliceShared = await computeSharedSecret(alice.secretKey, bob.publicKey)
    const bobShared = await computeSharedSecret(bob.secretKey, alice.publicKey)

    // #then the resulting secrets are equal and SHARED_SECRET_LENGTH bytes
    expect(aliceShared).toHaveLength(X25519_PARAMS.SHARED_SECRET_LENGTH)
    expect(sodium.to_hex(aliceShared)).toBe(sodium.to_hex(bobShared))
  })

  it('rejects invalid private key length', async () => {
    // #given a too-short private key
    const shortKey = new Uint8Array(X25519_PARAMS.SECRET_KEY_LENGTH - 1)
    const validPub = new Uint8Array(X25519_PARAMS.PUBLIC_KEY_LENGTH)

    // #when/then
    await expect(computeSharedSecret(shortKey, validPub)).rejects.toThrow(
      `X25519 private key must be ${X25519_PARAMS.SECRET_KEY_LENGTH} bytes`
    )
  })

  it('rejects invalid public key length', async () => {
    // #given a too-short public key
    const validPriv = new Uint8Array(X25519_PARAMS.SECRET_KEY_LENGTH)
    const shortPub = new Uint8Array(X25519_PARAMS.PUBLIC_KEY_LENGTH - 1)

    // #when/then
    await expect(computeSharedSecret(validPriv, shortPub)).rejects.toThrow(
      `X25519 public key must be ${X25519_PARAMS.PUBLIC_KEY_LENGTH} bytes`
    )
  })
})

describe('deriveLinkingKeys', () => {
  it('returns an enc/mac pair with distinct 32-byte values', async () => {
    // #given a shared secret
    // #when linking keys are derived
    const { encKey, macKey } = await deriveLinkingKeys(FIXED_SHARED_SECRET)

    // #then both are 32 bytes and differ from each other
    expect(encKey).toHaveLength(32)
    expect(macKey).toHaveLength(32)
    expect(sodium.to_hex(encKey)).not.toBe(sodium.to_hex(macKey))
  })

  it('is deterministic for the same shared secret', async () => {
    // #given identical shared secrets
    // #when derived twice
    const a = await deriveLinkingKeys(FIXED_SHARED_SECRET)
    const b = await deriveLinkingKeys(FIXED_SHARED_SECRET)

    // #then both pairs match
    expect(sodium.to_hex(a.encKey)).toBe(sodium.to_hex(b.encKey))
    expect(sodium.to_hex(a.macKey)).toBe(sodium.to_hex(b.macKey))
  })

  it('uses the documented LINKING_HKDF_CONTEXTS for enc and mac', async () => {
    // #given a spy on the underlying KDF
    const spy = vi.spyOn(sodium, 'crypto_kdf_derive_from_key')

    // #when
    await deriveLinkingKeys(FIXED_SHARED_SECRET)

    // #then both contexts were passed to the KDF
    const ctxArgs = spy.mock.calls.map((call) => call[2])
    expect(ctxArgs).toContain('memrylnk')
    expect(ctxArgs).toContain('memrymac')
    expect(LINKING_HKDF_CONTEXTS.ENCRYPTION).toBe('memry-linking-enc-v1')
    expect(LINKING_HKDF_CONTEXTS.MAC).toBe('memry-linking-mac-v1')

    spy.mockRestore()
  })
})

describe('computeVerificationCode', () => {
  it('returns a deterministic 6-digit numeric code', async () => {
    // #given/when
    const a = await computeVerificationCode(FIXED_SHARED_SECRET)
    const b = await computeVerificationCode(FIXED_SHARED_SECRET)

    // #then deterministic + format
    expect(a).toBe(b)
    expect(a).toMatch(/^\d{6}$/)
  })

  it('produces different codes for different shared secrets (with high probability)', async () => {
    // #given two distinct secrets
    const s1 = new Uint8Array(32).fill(0x01)
    const s2 = new Uint8Array(32).fill(0xfe)

    // #when
    const c1 = await computeVerificationCode(s1)
    const c2 = await computeVerificationCode(s2)

    // #then
    expect(c1).not.toBe(c2)
  })

  it('always returns exactly 6 characters even when modulo result is small', async () => {
    // #given a generichash spy that returns a payload yielding modulo 7
    const sasKeyHashSpy = vi
      .spyOn(sodium, 'crypto_generichash')
      .mockReturnValueOnce(new Uint8Array([0, 0, 0, 7]))

    // #when
    const code = await computeVerificationCode(FIXED_SHARED_SECRET)

    // #then padded to 6 digits
    expect(code).toBe('000007')

    sasKeyHashSpy.mockRestore()
  })
})

describe('computeLinkingProof + computeKeyConfirm', () => {
  it('computeLinkingProof is deterministic for the same inputs and changes when inputs change', () => {
    // #given a stable mac key + session/device pair
    const macKey = new Uint8Array(32).fill(0x09)
    const sessionId = 'sess-abc'
    const devicePublicKey = 'dev-pub'

    // #when called twice with identical inputs
    const a = computeLinkingProof(macKey, sessionId, devicePublicKey)
    const b = computeLinkingProof(macKey, sessionId, devicePublicKey)

    // #then deterministic and HMAC-shaped (32 bytes)
    expect(a).toHaveLength(32)
    expect(sodium.to_hex(a)).toBe(sodium.to_hex(b))

    // #when input changes
    const c = computeLinkingProof(macKey, sessionId, 'different-dev-pub')
    expect(sodium.to_hex(a)).not.toBe(sodium.to_hex(c))
  })

  it('computeKeyConfirm is deterministic for the same inputs and changes when inputs change', () => {
    // #given inputs
    const macKey = new Uint8Array(32).fill(0x0a)
    const sessionId = 'sess-xyz'
    const encryptedMasterKey = 'cipher-blob'

    // #when called twice
    const a = computeKeyConfirm(macKey, sessionId, encryptedMasterKey)
    const b = computeKeyConfirm(macKey, sessionId, encryptedMasterKey)

    // #then
    expect(a).toHaveLength(32)
    expect(sodium.to_hex(a)).toBe(sodium.to_hex(b))

    // #when changed input
    const c = computeKeyConfirm(macKey, sessionId, 'different-cipher')
    expect(sodium.to_hex(a)).not.toBe(sodium.to_hex(c))
  })

  it('uses different keyed-MAC outputs for proof vs confirm even with the same context', () => {
    // #given one mac key and shared session id
    const macKey = new Uint8Array(32).fill(0x0b)
    const sessionId = 'sess-share'

    // #when both helpers run with semantically different payloads
    const proof = computeLinkingProof(macKey, sessionId, 'dev-pub')
    const confirm = computeKeyConfirm(macKey, sessionId, 'enc-mk')

    // #then outputs differ
    expect(sodium.to_hex(proof)).not.toBe(sodium.to_hex(confirm))
  })
})

describe('getOrCreateSigningKeyPair', () => {
  it('reuses keychain key when present', async () => {
    // #given a key pair persisted to mock keychain
    const original = await generateDeviceSigningKeyPair()
    vi.mocked(keytar.getPassword).mockResolvedValueOnce(
      sodium.to_base64(original.secretKey, sodium.base64_variants.ORIGINAL)
    )

    // #when
    const result = await getOrCreateSigningKeyPair()

    // #then the same identity is restored
    expect(result.deviceId).toBe(original.deviceId)
    expect(sodium.to_hex(result.publicKey)).toBe(sodium.to_hex(original.publicKey))
  })

  it('generates a fresh key pair when nothing is in the keychain', async () => {
    // #given empty keychain
    vi.mocked(keytar.getPassword).mockResolvedValueOnce(null)

    // #when
    const result = await getOrCreateSigningKeyPair()

    // #then a valid Ed25519 pair was created
    expect(result.publicKey).toHaveLength(32)
    expect(result.secretKey).toHaveLength(64)
    expect(result.deviceId).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('getOrDeriveVaultKey', () => {
  it('throws when the master key is missing from the keychain', async () => {
    // #given empty keychain
    vi.mocked(keytar.getPassword).mockResolvedValueOnce(null)

    // #when/then
    await expect(getOrDeriveVaultKey()).rejects.toThrow(
      'Master key not found in keychain — cannot derive vault key'
    )
  })

  it('derives a 32-byte vault key from the stored master key', async () => {
    // #given a master key persisted in the keychain
    vi.mocked(keytar.getPassword).mockImplementation(async (service, account) => {
      if (
        service === KEYCHAIN_ENTRIES.MASTER_KEY.service &&
        account === KEYCHAIN_ENTRIES.MASTER_KEY.account
      ) {
        return sodium.to_base64(FIXED_MASTER_KEY, sodium.base64_variants.ORIGINAL)
      }
      return null
    })

    // #when
    const vaultKey = await getOrDeriveVaultKey()

    // #then it's 32 bytes and matches a direct derivation
    const expected = await deriveKey(
      new Uint8Array(FIXED_MASTER_KEY),
      KEY_DERIVATION_CONTEXTS.VAULT_KEY,
      32
    )
    expect(vaultKey).toHaveLength(32)
    expect(sodium.to_hex(vaultKey)).toBe(sodium.to_hex(expected))
  })
})
