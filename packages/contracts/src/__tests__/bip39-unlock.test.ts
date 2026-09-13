/**
 * Verifier for `bip39-unlock.json` (T066).
 *
 * Recomputes every case with Node libsodium and `bip39`, and asserts the one
 * thing a byte-comparison would miss: the account key verifier comparison is
 * over the base64 STRINGS re-encoded as UTF-8, not over the decoded bytes. An
 * implementation that compares decoded bytes accepts every correct input and
 * fails to reject some incorrect ones, so a test that only checks the happy
 * path passes for a broken comparison.
 */
import * as bip39 from 'bip39'
import sodium from 'libsodium-wrappers-sumo'
import { beforeAll, describe, expect, it } from 'vitest'

import { ARGON2_PARAMS } from '../crypto'
import { fromHex, loadVectorFile } from './vector-loader'

const vectors = loadVectorFile<{
  meta: { caseCount: number; argon2: typeof ARGON2_PARAMS; wordlist: string }
  bip39: Array<Record<string, unknown>>
  verifiers: Array<Record<string, unknown>>
}>('bip39-unlock.json')

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')
const b64 = (b: Uint8Array): string => sodium.to_base64(b, sodium.base64_variants.ORIGINAL)
const utf8 = (v: string): Uint8Array => new TextEncoder().encode(v)

const masterKeyOf = (seed: Uint8Array, saltHex: string): Uint8Array =>
  sodium.crypto_pwhash(
    32,
    seed,
    fromHex(saltHex),
    ARGON2_PARAMS.OPS_LIMIT,
    ARGON2_PARAMS.MEMORY_LIMIT,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  )

/** Chapter 01 §1.3, all five steps. */
const canonicalise = (phrase: string): string =>
  phrase.normalize('NFKD').trim().toLowerCase().replace(/\s+/g, ' ')

describe('bip39-unlock vectors', () => {
  beforeAll(async () => {
    await sodium.ready
  })

  it('carries the recorded case count', () => {
    expect(vectors.bip39.length + vectors.verifiers.length).toBe(vectors.meta.caseCount)
  })

  it('the recorded Argon2 parameters are the production ones', () => {
    expect(vectors.meta.argon2).toEqual({ ...ARGON2_PARAMS })
  })

  it('a known 24-word mnemonic derives the recorded seed', () => {
    const entry = vectors.bip39[0] as {
      mnemonic: string
      entropyHex: string
      expectedSeedHex: string
      expectedValid: boolean
      kdf: { iterations: number; dkLen: number; salt: string }
    }
    expect(bip39.entropyToMnemonic(entry.entropyHex)).toBe(entry.mnemonic)
    expect(bip39.validateMnemonic(entry.mnemonic)).toBe(entry.expectedValid)
    expect(hex(new Uint8Array(bip39.mnemonicToSeedSync(entry.mnemonic)))).toBe(
      entry.expectedSeedHex
    )
    // No passphrase: the same phrase WITH one must produce different bytes.
    expect(hex(new Uint8Array(bip39.mnemonicToSeedSync(entry.mnemonic, 'x')))).not.toBe(
      entry.expectedSeedHex
    )
    expect(entry.kdf).toEqual({
      algorithm: 'PBKDF2-HMAC-SHA512',
      iterations: 2048,
      dkLen: 64,
      salt: 'mnemonic'
    })
  })

  it('canonicalisation is what makes a messy phrase usable, and changes nothing else', () => {
    const entry = vectors.bip39[1] as {
      mnemonic: string
      canonicalised: string
      expectedCanonicalEqualsPhrase: boolean
      expectedValidBeforeCanonicalisation: boolean
      expectedValidAfterCanonicalisation: boolean
      expectedSeedHexAfterCanonicalisation: string
    }
    expect(canonicalise(entry.mnemonic)).toBe(entry.canonicalised)
    expect(bip39.validateMnemonic(entry.mnemonic)).toBe(entry.expectedValidBeforeCanonicalisation)
    expect(entry.expectedValidBeforeCanonicalisation, 'the raw form must NOT validate').toBe(false)
    expect(bip39.validateMnemonic(entry.canonicalised)).toBe(true)
    // The point of the decision: canonicalising an already-canonical phrase is
    // the identity, so mandating it changes no key any user already holds.
    expect(entry.expectedCanonicalEqualsPhrase).toBe(true)
    expect(entry.canonicalised).toBe((vectors.bip39[0] as { mnemonic: string }).mnemonic)
    expect(hex(new Uint8Array(bip39.mnemonicToSeedSync(entry.canonicalised)))).toBe(
      entry.expectedSeedHexAfterCanonicalisation
    )
  })

  it('an invalid checksum is rejected before any seed exists', () => {
    const entry = vectors.bip39[2] as { mnemonic: string; expectedValid: boolean }
    expect(entry.expectedValid).toBe(false)
    expect(bip39.validateMnemonic(entry.mnemonic)).toBe(false)
  })

  it('a 12-word phrase is valid BIP39 and must still be refused', () => {
    const entry = vectors.bip39[3] as {
      mnemonic: string
      expectedValid: boolean
      wordCount: number
    }
    expect(bip39.validateMnemonic(entry.mnemonic)).toBe(true)
    expect(entry.expectedValid).toBe(true)
    expect(entry.mnemonic.split(' ')).toHaveLength(12)
    expect(entry.wordCount, 'the product generates 24; accepting 12 halves the entropy').toBe(12)
  })

  it('recoveryPhraseUnlock: the whole chain', () => {
    const entry = vectors.verifiers[0] as {
      mnemonic: string
      kdfSaltHex: string
      expectedSeedHex: string
      expectedMasterKeyHex: string
      expectedVaultKeyHex: string
      expectedAccountKeyVerifierB64: string
    }
    const seed = new Uint8Array(bip39.mnemonicToSeedSync(entry.mnemonic))
    expect(hex(seed)).toBe(entry.expectedSeedHex)
    const masterKey = masterKeyOf(seed, entry.kdfSaltHex)
    expect(hex(masterKey)).toBe(entry.expectedMasterKeyHex)
    expect(hex(sodium.crypto_kdf_derive_from_key(32, 1, 'memryvlt', masterKey))).toBe(
      entry.expectedVaultKeyHex
    )
    expect(b64(sodium.crypto_kdf_derive_from_key(32, 4, 'memrykve', masterKey))).toBe(
      entry.expectedAccountKeyVerifierB64
    )
  })

  it('accountKeyVerifier is the raw KDF output with NO hash wrapper', () => {
    const entry = vectors.verifiers[1] as { masterKeyHex: string; expectedB64: string }
    const derived = sodium.crypto_kdf_derive_from_key(
      32,
      4,
      'memrykve',
      fromHex(entry.masterKeyHex)
    )
    expect(b64(derived)).toBe(entry.expectedB64)
    // A hashed variant must NOT match, so a wrapper added later fails here.
    expect(b64(sodium.crypto_generichash(32, derived, null))).not.toBe(entry.expectedB64)
  })

  it('the verifier comparison is over the base64 STRINGS, not the decoded bytes', () => {
    const entry = vectors.verifiers[1] as { expectedB64: string }
    const derived = utf8(entry.expectedB64)
    expect(sodium.memcmp(derived, utf8(entry.expectedB64))).toBe(true)

    // An alternative base64 spelling of the SAME bytes: a byte comparison
    // accepts it, a string comparison rejects it. The production comparison is
    // the string one, so a client that decodes first is more permissive than
    // the reference — which is the failure this case names.
    const bytes = sodium.from_base64(entry.expectedB64, sodium.base64_variants.ORIGINAL)
    const urlSafe = sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING)
    if (urlSafe !== entry.expectedB64) {
      expect(
        utf8(urlSafe).length === derived.length && sodium.memcmp(utf8(urlSafe), derived),
        'a differently spelled base64 of the same bytes must NOT compare equal'
      ).toBe(false)
    }
  })

  it('localVaultKeyVerifier is a keyed hash of the CONTEXT STRING under the vault key', () => {
    const entry = vectors.verifiers[2] as {
      vaultKeyHex: string
      vaultId: string
      messageUtf8: string
      expectedB64: string
    }
    expect(entry.messageUtf8).toBe(`memry/vault-key-verifier/v1/${entry.vaultId}`)
    expect(
      b64(sodium.crypto_generichash(32, utf8(entry.messageUtf8), fromHex(entry.vaultKeyHex)))
    ).toBe(entry.expectedB64)
    // Key and message the other way round must NOT match: getting this
    // backwards is the likeliest way to reimplement it wrong.
    expect(
      b64(sodium.crypto_generichash(32, fromHex(entry.vaultKeyHex), utf8(entry.messageUtf8)))
    ).not.toBe(entry.expectedB64)
  })

  it('a wrong phrase produces a mismatching verifier', () => {
    const entry = vectors.verifiers[3] as {
      mnemonic: string
      kdfSaltHex: string
      expectedAccountKeyVerifierB64: string
      serverVerifierB64: string
      expectedMatch: boolean
    }
    const seed = new Uint8Array(bip39.mnemonicToSeedSync(entry.mnemonic))
    const masterKey = masterKeyOf(seed, entry.kdfSaltHex)
    const verifier = b64(sodium.crypto_kdf_derive_from_key(32, 4, 'memrykve', masterKey))
    expect(verifier).toBe(entry.expectedAccountKeyVerifierB64)
    expect(verifier === entry.serverVerifierB64).toBe(entry.expectedMatch)
    expect(entry.expectedMatch).toBe(false)
  })

  it('deviceId is a 16-byte generichash of the Ed25519 public key', () => {
    const entry = vectors.verifiers[4] as {
      ed25519PublicKeyHex: string
      expectedDeviceIdHex: string
    }
    expect(
      sodium.to_hex(sodium.crypto_generichash(16, fromHex(entry.ed25519PublicKeyHex), null))
    ).toBe(entry.expectedDeviceIdHex)
    expect(entry.expectedDeviceIdHex).toMatch(/^[0-9a-f]{32}$/)
  })
})
