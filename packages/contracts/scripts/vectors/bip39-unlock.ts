/**
 * Class: recovery-phrase unlock (`bip39-unlock.json`), 9 cases in two groups.
 *
 * The committed `vaultUnlockFlow` in `crypto-vectors.json` starts from a
 * PASSWORD. The production unlock path a second implementation must build
 * starts from a 24-word RECOVERY PHRASE and passes through
 * `bip39.mnemonicToSeed` — PBKDF2-HMAC-SHA512, 2048 iterations, the literal
 * salt `mnemonic`. That entire step is uncovered today, FR-019 and SC-003
 * depend on it, and it is the step most likely to go subtly wrong: a passphrase
 * passed where none belongs, or a different normalisation.
 *
 * WHY THIS IS A NEW FILE and not an addition to `crypto-vectors.json`: that
 * file is frozen byte-for-byte. Three suites consume it and none of them should
 * see a diff from this feature.
 *
 * WHY IT IS BUILT BY `gen-protocol-vectors.ts` rather than by
 * `gen-crypto-vectors.ts`, which conformance-vectors.md §4 names: the composite
 * entry point is the one `vectors:check` drives, so building it here puts the
 * new file under the FR-008 gate instead of leaving it regenerable only by
 * hand. `crypto-vectors.json` is untouched either way.
 *
 * Determinism: D1 throughout. Fixed entropy, fixed salt, fixed vault id.
 *
 * Chapter: docs/protocol/01-identity-and-keys.md.
 */
import * as bip39 from 'bip39'
import sodium from 'libsodium-wrappers-sumo'

import { ARGON2_PARAMS } from '../../src/crypto'
import { b64, fromHex, hex, utf8 } from '../../test-vectors/deterministic-provider'
import { meta } from './shared'

/** 32 bytes of fixed entropy → a deterministic 24-word English mnemonic. */
const ENTROPY_24 = '0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0'
/** 16 bytes → a 12-word mnemonic, to pin what a short phrase does. */
const ENTROPY_12 = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'
/** The account's `kdfSalt`, 16 bytes as chapter 01 §1.1 requires. */
const KDF_SALT = '9f8e7d6c5b4a39281706f5e4d3c2b1a0'
const VAULT_ID = '7f1d2c3b-4a59-4687-9d0e-1f2a3b4c5d6e'
/** A different account's phrase, for the mismatch case. */
const ENTROPY_WRONG = 'ff'.repeat(32)

const seedOf = (phrase: string): Uint8Array => new Uint8Array(bip39.mnemonicToSeedSync(phrase))

const masterKeyOf = (seed: Uint8Array): Uint8Array =>
  sodium.crypto_pwhash(
    32,
    seed,
    fromHex(KDF_SALT),
    ARGON2_PARAMS.OPS_LIMIT,
    ARGON2_PARAMS.MEMORY_LIMIT,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  )

const accountKeyVerifierOf = (masterKey: Uint8Array): string =>
  b64(sodium.crypto_kdf_derive_from_key(32, 4, 'memrykve', masterKey))

const vaultKeyOf = (masterKey: Uint8Array): Uint8Array =>
  sodium.crypto_kdf_derive_from_key(32, 1, 'memryvlt', masterKey)

const localVaultKeyVerifierOf = (vaultKey: Uint8Array, vaultId: string): string =>
  b64(sodium.crypto_generichash(32, utf8(`memry/vault-key-verifier/v1/${vaultId}`), vaultKey))

export function buildBip39Unlock(): Record<string, unknown> {
  const phrase24 = bip39.entropyToMnemonic(ENTROPY_24)
  const phrase12 = bip39.entropyToMnemonic(ENTROPY_12)
  const wrongPhrase = bip39.entropyToMnemonic(ENTROPY_WRONG)

  // The exact shape a user pastes: mixed case, doubled internal spaces, and a
  // leading and trailing space. Chapter 01 §1.3 says a client canonicalises
  // this BEFORE validating, and that the result is the canonical phrase.
  const words = phrase24.split(' ')
  const messy = `  ${words.map((w, i) => (i % 3 === 0 ? w.toUpperCase() : w)).join('  ')}  `
  const canonicalised = messy.trim().toLowerCase().replace(/\s+/g, ' ')

  // A valid word list with a deliberately wrong checksum: swap the last word
  // for another from the list.
  const badChecksumWords = [...words]
  badChecksumWords[23] = badChecksumWords[23] === 'zoo' ? 'zone' : 'zoo'
  const badChecksum = badChecksumWords.join(' ')

  const bip39Cases = [
    {
      name: 'a known 24-word English mnemonic to its 64-byte seed',
      entropyHex: ENTROPY_24,
      mnemonic: phrase24,
      wordCount: 24,
      kdf: { algorithm: 'PBKDF2-HMAC-SHA512', iterations: 2048, dkLen: 64, salt: 'mnemonic' },
      passphrase: '',
      expectedValid: bip39.validateMnemonic(phrase24),
      expectedSeedHex: hex(seedOf(phrase24)),
      pins: 'the literal salt is the ASCII string `mnemonic` with NO passphrase appended'
    },
    {
      name: 'the same mnemonic with mixed case, doubled spaces and outer padding',
      mnemonic: messy,
      canonicalised,
      expectedCanonicalEqualsPhrase: canonicalised === phrase24,
      // Recorded as it behaves TODAY: the raw form fails validation, which is
      // why a client MUST canonicalise first rather than hope.
      expectedValidBeforeCanonicalisation: bip39.validateMnemonic(messy),
      expectedValidAfterCanonicalisation: bip39.validateMnemonic(canonicalised),
      expectedSeedHexAfterCanonicalisation: hex(seedOf(canonicalised)),
      pins: 'the five normalisation steps of chapter 01 §1.3, and that they change nothing for an already-canonical phrase'
    },
    {
      name: 'a mnemonic with a deliberately invalid checksum',
      mnemonic: badChecksum,
      expectedValid: bip39.validateMnemonic(badChecksum),
      pins: 'validation MUST gate derivation: no seed may be derived from this'
    },
    {
      name: 'a 12-word mnemonic',
      entropyHex: ENTROPY_12,
      mnemonic: phrase12,
      wordCount: 12,
      expectedValid: bip39.validateMnemonic(phrase12),
      expectedSeedHex: hex(seedOf(phrase12)),
      pins: 'a 12-word phrase is VALID BIP39 and MUST still be rejected: the product generates 24 words, and accepting 12 halves the entropy silently'
    }
  ]

  const seed = seedOf(phrase24)
  const masterKey = masterKeyOf(seed)
  const vaultKey = vaultKeyOf(masterKey)
  const verifier = accountKeyVerifierOf(masterKey)

  const wrongSeed = seedOf(wrongPhrase)
  const wrongMasterKey = masterKeyOf(wrongSeed)
  const wrongVerifier = accountKeyVerifierOf(wrongMasterKey)

  const ed25519 = sodium.crypto_sign_seed_keypair(fromHex(ENTROPY_24))

  const verifierCases = [
    {
      name: 'recoveryPhraseUnlock — the whole chain FR-019 ships',
      mnemonic: phrase24,
      kdfSaltHex: KDF_SALT,
      argon2: { opsLimit: ARGON2_PARAMS.OPS_LIMIT, memLimit: ARGON2_PARAMS.MEMORY_LIMIT },
      expectedSeedHex: hex(seed),
      expectedMasterKeyHex: hex(masterKey),
      expectedVaultKeyHex: hex(vaultKey),
      expectedAccountKeyVerifierB64: verifier,
      pins: 'phrase → seed → master key → vault key → verifier, in one case'
    },
    {
      name: 'accountKeyVerifier — no hash wrapper, and a STRING comparison',
      masterKeyHex: hex(masterKey),
      expectedB64: verifier,
      construction: "base64(crypto_kdf_derive_from_key(32, 4, 'memrykve', masterKey))",
      comparison:
        'constant-time over the base64 STRINGS re-encoded as UTF-8, not over the decoded bytes',
      pins: 'an implementation that compares decoded bytes accepts every correct input and fails to reject some incorrect ones'
    },
    {
      name: 'localVaultKeyVerifier — keyed BLAKE2b, never sent to the server',
      vaultKeyHex: hex(vaultKey),
      vaultId: VAULT_ID,
      messageUtf8: `memry/vault-key-verifier/v1/${VAULT_ID}`,
      expectedB64: localVaultKeyVerifierOf(vaultKey, VAULT_ID),
      pins: 'the vault key is the KEY and the context string is the MESSAGE — the one place a vaultId touches key material'
    },
    {
      name: 'wrongPhrase — valid BIP39, wrong account',
      mnemonic: wrongPhrase,
      kdfSaltHex: KDF_SALT,
      expectedAccountKeyVerifierB64: wrongVerifier,
      serverVerifierB64: verifier,
      expectedMatch: false,
      pins: 'FR-027: the failure path. Nothing is persisted before the verifier passes'
    },
    {
      name: 'deviceId — the locally derived form',
      ed25519PublicKeyHex: hex(ed25519.publicKey),
      expectedDeviceIdHex: sodium.to_hex(sodium.crypto_generichash(16, ed25519.publicKey, null)),
      construction: 'hex(crypto_generichash(16, ed25519PublicKey, key = null))',
      pins: '32 lowercase hex characters. The WIRE identity is the server-assigned id, not this one (chapter 01 §1.5)'
    }
  ]

  return {
    meta: meta({
      class: 'bip39-unlock',
      chapter: 'docs/protocol/01-identity-and-keys.md',
      bip39Version: (bip39 as { wordlists?: unknown }).wordlists ? '3.1.0' : 'unknown',
      wordlist: 'english',
      argon2: ARGON2_PARAMS,
      caseCount: bip39Cases.length + verifierCases.length
    }),
    bip39: bip39Cases,
    verifiers: verifierCases
  }
}
