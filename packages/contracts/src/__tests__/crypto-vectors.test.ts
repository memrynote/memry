/**
 * Desktop proof suite for the committed crypto parity vectors (T005 / R1).
 *
 * Recomputes every fixture in test-vectors/crypto-vectors.json against Node
 * libsodium and byte-compares. The on-device harness
 * (apps/mobile/src/crypto/__harness__/vector-parity.ts) runs the same file
 * through the JSI binding; G0-a passes only when both agree on every vector.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import sodium from 'libsodium-wrappers-sumo'
import { beforeAll, describe, expect, it } from 'vitest'

import { ARGON2_PARAMS, XCHACHA20_PARAMS } from '../crypto'

type Vectors = ReturnType<typeof loadVectors>

const loadVectors = () =>
  JSON.parse(
    readFileSync(new URL('../../test-vectors/crypto-vectors.json', import.meta.url), 'utf8')
  ) as {
    meta: { constants: { argon2: typeof ARGON2_PARAMS; xchacha20: typeof XCHACHA20_PARAMS } }
    argon2id: Array<{
      passwordUtf8: string
      saltHex: string
      opsLimit: number
      memLimit: number
      outLength: number
      derivedHex: string
      description: string
    }>
    xchacha20poly1305Ietf: Array<{
      keyHex: string
      nonceHex: string
      plaintextUtf8?: string
      plaintextHex?: string
      adHex: string | null
      ciphertextHex: string
    }>
    ed25519: {
      seedHex: string
      publicKeyHex: string
      secretKeyHex: string
      messageUtf8: string
      detachedSignatureHex: string
      deviceIdHex: string
    }
    kdfDeriveFromKey: Array<{
      ctx: string
      subkeyId: number
      length: number
      masterKeyHex: string
      derivedHex: string
    }>
    generichash: Array<{
      messageHex?: string
      messageUtf8?: string
      keyHex: string | null
      outLength: number
      hashHex: string
    }>
    auth: Array<{ messageUtf8: string; keyHex: string; macHex: string }>
    scalarmult: {
      base: Array<{ scalarHex: string; publicKeyHex: string }>
      shared: Array<{ scalarHex: string; pointHex: string; sharedSecretHex: string }>
    }
    boxKeypair: { secretKeyHex: string; publicKeyHex: string }
    vaultUnlockFlow: {
      passwordUtf8: string
      kdfSaltHex: string
      argon2: { opsLimit: number; memLimit: number }
      masterKeyHex: string
      keyVerifierBase64: string
      vaultKeyHex: string
      fileKeyHex: string
      keyNonceHex: string
      encryptedKeyHex: string
      dataNonceHex: string
      encryptedDataHex: string
      plaintextMarkdownUtf8: string
      plaintextSha256Hex: string
    }
  }

let vectors: Vectors

beforeAll(async () => {
  await sodium.ready
  vectors = loadVectors()
})

const hex = (bytes: Uint8Array): string => sodium.to_hex(bytes)
const fromHex = (value: string): Uint8Array => sodium.from_hex(value)
const utf8 = (value: string): Uint8Array => sodium.from_string(value)

describe('crypto parity vectors', () => {
  it('pins the production Argon2id and XChaCha20 constants', () => {
    expect(vectors.meta.constants.argon2).toEqual(ARGON2_PARAMS)
    expect(vectors.meta.constants.xchacha20).toEqual(XCHACHA20_PARAMS)
    const prod = vectors.argon2id[0]
    expect(prod.opsLimit).toBe(ARGON2_PARAMS.OPS_LIMIT)
    expect(prod.memLimit).toBe(ARGON2_PARAMS.MEMORY_LIMIT)
  })

  it('reproduces every Argon2id vector', () => {
    for (const v of vectors.argon2id) {
      const derived = sodium.crypto_pwhash(
        v.outLength,
        utf8(v.passwordUtf8),
        fromHex(v.saltHex),
        v.opsLimit,
        v.memLimit,
        sodium.crypto_pwhash_ALG_ARGON2ID13
      )
      expect(hex(derived), v.description).toBe(v.derivedHex)
    }
  })

  it('reproduces every XChaCha20-Poly1305 vector and round-trips decryption', () => {
    for (const v of vectors.xchacha20poly1305Ietf) {
      const plaintext = v.plaintextUtf8 ? utf8(v.plaintextUtf8) : fromHex(v.plaintextHex ?? '')
      const ad = v.adHex ? fromHex(v.adHex) : null
      const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        plaintext,
        ad,
        null,
        fromHex(v.nonceHex),
        fromHex(v.keyHex)
      )
      expect(hex(ciphertext)).toBe(v.ciphertextHex)

      const opened = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        fromHex(v.ciphertextHex),
        ad,
        fromHex(v.nonceHex),
        fromHex(v.keyHex)
      )
      expect(hex(opened)).toBe(hex(plaintext))
    }
  })

  it('reproduces the Ed25519 seed keypair, detached signature, and deviceId', () => {
    const v = vectors.ed25519
    const pair = sodium.crypto_sign_seed_keypair(fromHex(v.seedHex))
    expect(hex(pair.publicKey)).toBe(v.publicKeyHex)
    expect(hex(pair.privateKey)).toBe(v.secretKeyHex)

    const signature = sodium.crypto_sign_detached(utf8(v.messageUtf8), pair.privateKey)
    expect(hex(signature)).toBe(v.detachedSignatureHex)
    expect(
      sodium.crypto_sign_verify_detached(
        fromHex(v.detachedSignatureHex),
        utf8(v.messageUtf8),
        pair.publicKey
      )
    ).toBe(true)

    expect(sodium.to_hex(sodium.crypto_generichash(16, pair.publicKey, null))).toBe(v.deviceIdHex)
  })

  it('reproduces crypto_kdf_derive_from_key for all 7 production contexts', () => {
    expect(vectors.kdfDeriveFromKey).toHaveLength(7)
    for (const v of vectors.kdfDeriveFromKey) {
      const derived = sodium.crypto_kdf_derive_from_key(
        v.length,
        v.subkeyId,
        v.ctx,
        fromHex(v.masterKeyHex)
      )
      expect(hex(derived), v.ctx).toBe(v.derivedHex)
    }
  })

  it('reproduces every generichash vector (keyed + custom lengths)', () => {
    for (const v of vectors.generichash) {
      const message = v.messageUtf8 ? utf8(v.messageUtf8) : fromHex(v.messageHex ?? '')
      const hash = sodium.crypto_generichash(
        v.outLength,
        message,
        v.keyHex ? fromHex(v.keyHex) : null
      )
      expect(hex(hash)).toBe(v.hashHex)
    }
  })

  it('reproduces every crypto_auth vector', () => {
    for (const v of vectors.auth) {
      const mac = sodium.crypto_auth(utf8(v.messageUtf8), fromHex(v.keyHex))
      expect(hex(mac)).toBe(v.macHex)
      expect(
        sodium.crypto_auth_verify(fromHex(v.macHex), utf8(v.messageUtf8), fromHex(v.keyHex))
      ).toBe(true)
    }
  })

  it('reproduces crypto_scalarmult base and shared-secret vectors', () => {
    for (const v of vectors.scalarmult.base) {
      expect(hex(sodium.crypto_scalarmult_base(fromHex(v.scalarHex)))).toBe(v.publicKeyHex)
    }
    for (const v of vectors.scalarmult.shared) {
      expect(hex(sodium.crypto_scalarmult(fromHex(v.scalarHex), fromHex(v.pointHex)))).toBe(
        v.sharedSecretHex
      )
    }
    // ECDH agreement: both directions land on the same shared secret
    expect(vectors.scalarmult.shared[0].sharedSecretHex).toBe(
      vectors.scalarmult.shared[1].sharedSecretHex
    )
  })

  it('reproduces the box keypair public-key derivation', () => {
    const v = vectors.boxKeypair
    expect(hex(sodium.crypto_scalarmult_base(fromHex(v.secretKeyHex)))).toBe(v.publicKeyHex)
  })

  it('walks the full vault-unlock flow to the desktop-equal plaintext hash', () => {
    const v = vectors.vaultUnlockFlow
    expect(v.argon2.opsLimit).toBe(ARGON2_PARAMS.OPS_LIMIT)
    expect(v.argon2.memLimit).toBe(ARGON2_PARAMS.MEMORY_LIMIT)

    const masterKey = sodium.crypto_pwhash(
      32,
      utf8(v.passwordUtf8),
      fromHex(v.kdfSaltHex),
      v.argon2.opsLimit,
      v.argon2.memLimit,
      sodium.crypto_pwhash_ALG_ARGON2ID13
    )
    expect(hex(masterKey)).toBe(v.masterKeyHex)

    const verifierKey = sodium.crypto_kdf_derive_from_key(32, 4, 'memrykve', masterKey)
    expect(sodium.to_base64(verifierKey, sodium.base64_variants.ORIGINAL)).toBe(v.keyVerifierBase64)

    const vaultKey = sodium.crypto_kdf_derive_from_key(32, 1, 'memryvlt', masterKey)
    expect(hex(vaultKey)).toBe(v.vaultKeyHex)

    const fileKey = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      fromHex(v.encryptedKeyHex),
      null,
      fromHex(v.keyNonceHex),
      vaultKey
    )
    expect(hex(fileKey)).toBe(v.fileKeyHex)

    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      fromHex(v.encryptedDataHex),
      null,
      fromHex(v.dataNonceHex),
      fileKey
    )
    expect(sodium.to_string(plaintext)).toBe(v.plaintextMarkdownUtf8)
    expect(createHash('sha256').update(Buffer.from(plaintext)).digest('hex')).toBe(
      v.plaintextSha256Hex
    )
  })
})
