/**
 * Verifier for `attachment-manifest.json` (N205).
 *
 * Reads the committed file and runs the production reader over it, so the
 * class is proven to be what the reader actually accepts rather than what
 * someone wrote down. It never imports the builder (README rule 2).
 *
 * The behavioural half matters as much as the bytes here: §14.4.1 makes the
 * signature check happen **before** the file key is unwrapped and the manifest
 * decrypted, so the tampered cases below have exactly one correct outcome.
 */
import { describe, expect, it } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'

import {
  decryptAttachmentManifest,
  ManifestSignatureError,
  type AttachmentManifest,
  type EncryptedAttachmentManifest
} from '../../../sync-client/src/push/attachment-manifest.ts'
import { loadVectorFile } from './vector-loader'

interface Case {
  name: string
  pins: string
  manifest: AttachmentManifest
  manifestJson: string
  envelope: EncryptedAttachmentManifest
  roundTrips: boolean
}

const vectors = loadVectorFile<{
  meta: {
    caseCount: number
    vaultKeyHex: string
    fileKeyHex: string
    signerPublicKeyB64: string
    signerDeviceId: string
    signatureOrder: string
  }
  cases: Case[]
}>('attachment-manifest.json')

await sodium.ready

const vaultKey = sodium.from_hex(vectors.meta.vaultKeyHex)
const signerPublicKey = sodium.from_base64(
  vectors.meta.signerPublicKeyB64,
  sodium.base64_variants.ORIGINAL
)

/** The production reader's crypto seam, over real libsodium. */
const reader = {
  fromBase64: (value: string) => sodium.from_base64(value, sodium.base64_variants.ORIGINAL),
  toBase64: (bytes: Uint8Array) => sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL),
  verifyDetached: async (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) =>
    sodium.crypto_sign_verify_detached(signature, message, publicKey),
  unwrapFileKey: async (wrapped: Uint8Array, nonce: Uint8Array, key: Uint8Array) =>
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, wrapped, null, nonce, key),
  decrypt: async (ciphertext: Uint8Array, nonce: Uint8Array, key: Uint8Array) =>
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, null, nonce, key)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any

describe('attachment-manifest vectors', () => {
  it('carries the recorded case count', () => {
    expect(vectors.cases).toHaveLength(vectors.meta.caseCount)
  })

  it('records that canonical order is not the allowlist order', () => {
    // The trap: a port signing CBOR_FIELD_ORDER order produces valid CBOR and
    // a signature nobody else accepts.
    expect(vectors.meta.signatureOrder).toContain('keyNonce, manifestNonce')
  })

  for (const entry of vectors.cases) {
    describe(entry.name, () => {
      it('decrypts to its manifest', async () => {
        const { manifest, fileKey } = await decryptAttachmentManifest(
          reader,
          entry.envelope,
          vaultKey,
          signerPublicKey
        )
        expect(manifest, entry.pins).toEqual(entry.manifest)
        expect(sodium.to_hex(fileKey)).toBe(vectors.meta.fileKeyHex)
      })

      it('records the manifest body byte for byte', () => {
        // The signature does NOT cover the body, so a port emitting the same
        // fields in another order would still parse everywhere and drift
        // silently. This is the only thing that catches it.
        expect(entry.manifestJson).toBe(JSON.stringify(entry.manifest))
      })

      it('was proven readable when it was generated', () => {
        expect(entry.roundTrips).toBe(true)
      })
    })
  }

  it('refuses a tampered envelope on the signature, before decrypting', async () => {
    // Each mutation leaves a well-formed envelope whose signature no longer
    // matches. A reader that unwrapped first would report a decrypt failure,
    // or worse succeed on attacker-chosen bytes.
    const base = vectors.cases[0].envelope
    const swaps: Array<[string, EncryptedAttachmentManifest]> = [
      ['encryptedManifest', { ...base, encryptedManifest: sodium.to_base64(new Uint8Array(8)) }],
      ['manifestNonce', { ...base, manifestNonce: sodium.to_base64(new Uint8Array(24)) }],
      ['encryptedFileKey', { ...base, encryptedFileKey: sodium.to_base64(new Uint8Array(48)) }],
      ['keyNonce', { ...base, keyNonce: sodium.to_base64(new Uint8Array(24)) }]
    ]

    for (const [field, envelope] of swaps) {
      await expect(
        decryptAttachmentManifest(reader, envelope, vaultKey, signerPublicKey),
        `swapping ${field} must be a signature refusal`
      ).rejects.toBeInstanceOf(ManifestSignatureError)
    }
  })

  it('refuses a manifest verified against the wrong device', async () => {
    const other = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(0x5c))
    await expect(
      decryptAttachmentManifest(reader, vectors.cases[0].envelope, vaultKey, other.publicKey)
    ).rejects.toBeInstanceOf(ManifestSignatureError)
  })

  it('carries a writer that chose a chunk size other than desktop 8 MiB', () => {
    // §14.9: CHUNK_SIZE is a desktop constant, not a contract constant. A port
    // that hardcoded it reads this file wrong, and the failure would be a
    // truncated download rather than an error.
    const odd = vectors.cases.find((entry) => entry.manifest.chunkSize !== 8 * 1024 * 1024)
    expect(odd, 'no case exercises a non-desktop chunk size').toBeDefined()
    const total = odd!.manifest.chunks.reduce((sum, chunk) => sum + chunk.size, 0)
    expect(total).toBe(odd!.manifest.size)
  })
})
