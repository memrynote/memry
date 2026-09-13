/**
 * The deterministic `SyncPushCryptoProvider` the protocol vectors are generated
 * and verified through.
 *
 * The production crypto path draws a fresh random nonce per operation
 * (`apps/desktop/src/main/crypto/encryption.ts:6-16`) and a fresh random file
 * key per item (`apps/desktop/src/main/crypto/primitives.ts:4-6`). A vector
 * cannot contain a random value and also be reproducible, so the generator
 * stubs the RANDOMNESS SEAM and nothing else: `generateFileKey` returns a fixed
 * key, `encrypt` and `wrapFileKey` return fixed nonces, and every other method
 * is the real libsodium call.
 *
 * This is still a production code path. The provider seam exists in production
 * (`packages/sync-client/src/push/crypto-provider.ts`) precisely so the shell
 * supplies the crypto; supplying a deterministic entropy source through it is
 * not a reimplementation of the algorithm.
 *
 * Lifted from `packages/sync-client/src/push/roundtrip.test.ts:21-64` so the
 * generator and the verifiers share ONE implementation. Two copies that drift
 * would produce vectors that verify against themselves and nothing else.
 *
 * It lives under `test-vectors/` rather than `src/` on purpose: it is fixture
 * material, not part of the contracts surface, and `packages/contracts/src`
 * must stay free of a libsodium dependency.
 */
import sodium from 'libsodium-wrappers-sumo'

// Relative rather than `@memry/sync-client`: that package depends on
// `@memry/contracts`, so a package.json dependency the other way is a turbo
// task cycle. The type is compile-time only and this file is fixture code, so
// a path import is the cheaper of the two costs.
import type { SyncPushCryptoProvider } from '../../sync-client/src/push/crypto-provider.ts'

export type { SyncPushCryptoProvider }

/** Every generator draws from these, so a reader can correlate two vector files. */
export const FIXED = {
  /** `vaultUnlockFlow.fileKeyHex` from the committed crypto vectors. */
  FILE_KEY: 'fedcba98765432100123456789abcdeffedcba98765432100123456789abcdef',
  /** Content nonce. Already in use as `NONCE_24_A`. */
  NONCE_24_A: '000102030405060708090a0b0c0d0e0f1011121314151617',
  /** Key-wrap nonce. `NONCE_24_A` reversed. */
  NONCE_24_B: '17161514131211100f0e0d0c0b0a09080706050403020100',
  /** A second content nonce, for cases carrying two items. */
  NONCE_24_C: 'ff'.repeat(24),
  /** Ed25519 signer A. */
  SEED_A: 'a0'.repeat(32),
  /** X25519 secret B. */
  SEED_B: '5c'.repeat(32),
  /** Ed25519 signer B, for the wrong-signer cases. */
  SEED_C: '3e'.repeat(32),
  /** A valid 12-character note id. */
  NOTE_ID: 'abc123def456',
  /** A valid journal id. */
  JOURNAL_ID: 'j2026-04-16',
  DEVICE_A: 'device-a',
  DEVICE_B: 'device-b'
} as const

export const hex = (bytes: Uint8Array): string => sodium.to_hex(bytes)
export const fromHex = (value: string): Uint8Array => sodium.from_hex(value)
export const utf8 = (value: string): Uint8Array => sodium.from_string(value)
export const b64 = (bytes: Uint8Array): string =>
  sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)
export const fromB64 = (value: string): Uint8Array =>
  sodium.from_base64(value, sodium.base64_variants.ORIGINAL)

export interface DeterministicOptions {
  /** Hex of the 32-byte file key `generateFileKey` returns. */
  readonly fileKeyHex?: string
  /** Hex of the 24-byte nonce `encrypt` returns. */
  readonly dataNonceHex?: string
  /** Hex of the 24-byte nonce `wrapFileKey` returns. */
  readonly keyNonceHex?: string
}

/**
 * Build the provider. `await sodium.ready` before calling.
 *
 * Every method other than the three seams below is the same libsodium call the
 * shipped desktop provider makes, with the same base64 variant and the same
 * `associatedData ?? ''` convention (`''` is libsodium NULL, which is how the
 * mobile string-only binding expresses "no AD").
 */
export function deterministicProvider(options: DeterministicOptions = {}): SyncPushCryptoProvider {
  const fileKeyHex = options.fileKeyHex ?? FIXED.FILE_KEY
  const dataNonceHex = options.dataNonceHex ?? FIXED.NONCE_24_A
  const keyNonceHex = options.keyNonceHex ?? FIXED.NONCE_24_B

  return {
    // --- the three injected seams -----------------------------------------
    generateFileKey: () => fromHex(fileKeyHex),
    encrypt: (plaintext, key, associatedData) => {
      const nonce = fromHex(dataNonceHex)
      return {
        ciphertext: sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
          plaintext,
          associatedData ?? '',
          null,
          nonce,
          key
        ),
        nonce
      }
    },
    wrapFileKey: (fileKey, vaultKey) => {
      const nonce = fromHex(keyNonceHex)
      return {
        wrappedKey: sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
          fileKey,
          '',
          null,
          nonce,
          vaultKey
        ),
        nonce
      }
    },

    // --- real libsodium from here down ------------------------------------
    decrypt: (ciphertext, nonce, key, associatedData) =>
      sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        ciphertext,
        associatedData ?? '',
        nonce,
        key
      ),
    unwrapFileKey: (wrappedKey, nonce, vaultKey) =>
      sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, wrappedKey, '', nonce, vaultKey),
    signDetached: (message, secretKey) => sodium.crypto_sign_detached(message, secretKey),
    verifyDetached: (signature, message, publicKey) =>
      sodium.crypto_sign_verify_detached(signature, message, publicKey),
    fromBase64: (value) => sodium.from_base64(value, sodium.base64_variants.ORIGINAL),
    toBase64: (bytes) => sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)
  }
}

/** The Ed25519 pair a seed hex names. `await sodium.ready` first. */
export function signerFromSeed(seedHex: string): {
  publicKey: Uint8Array
  secretKey: Uint8Array
  deviceId: string
} {
  const pair = sodium.crypto_sign_seed_keypair(fromHex(seedHex))
  return {
    publicKey: pair.publicKey,
    secretKey: pair.privateKey,
    // The locally derived device id of chapter 01 §1.5.
    deviceId: sodium.to_hex(sodium.crypto_generichash(16, pair.publicKey, null))
  }
}
