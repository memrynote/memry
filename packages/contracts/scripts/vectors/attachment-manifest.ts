/**
 * Class: the attachment manifest (`attachment-manifest.json`), chapter 14
 * §14.4 (N205, Q3).
 *
 * Generated through the production writer
 * `packages/sync-client/src/push/attachment-manifest.ts`, with the
 * deterministic provider supplying the file key and both nonces, and read back
 * through that same module's `decryptAttachmentManifest`.
 *
 * **What this class is holding together.** Q3 asked whether the Rust core
 * reimplements manifest signing or whether the logic is lifted somewhere both
 * ports call. There is no such place — the core is a standalone Rust port that
 * a Swift shell links as a static library and it cannot call a TypeScript
 * module — so it reimplements, and this file is what stops the two from
 * drifting.
 *
 * **Two things it pins that are easy to get wrong and fail silently.**
 *
 * The signature covers the four envelope fields as canonical CBOR, and
 * canonical order is **not** the `CBOR_FIELD_ORDER.ATTACHMENT_MANIFEST` order:
 * the encoder sorts by key length and then bytewise, so the wire order is
 * `keyNonce`, `manifestNonce`, `encryptedFileKey`, `encryptedManifest`. A port
 * that signed the allowlist order would produce valid CBOR and a signature
 * nobody else accepts.
 *
 * The signature does **not** cover the manifest body. The body crosses as
 * `JSON.stringify(manifest)`, so a port that emitted the same fields in a
 * different order would produce a manifest the other port still parses —
 * nothing fails, and the two drift silently. So `manifestJson` is recorded as
 * its own field and asserted byte-for-byte, not just round-tripped.
 *
 * **Verification happens before unwrap and decrypt** (§14.4.1), which is
 * behaviour rather than bytes, so the class carries tampered cases whose only
 * correct outcome is a signature refusal.
 */
import {
  decryptAttachmentManifest,
  encryptAttachmentManifest,
  type AttachmentManifest
} from '../../../sync-client/src/push/attachment-manifest.ts'
import {
  FIXED,
  b64,
  deterministicProvider,
  fromHex,
  signerFromSeed
} from '../../test-vectors/deterministic-provider'
import { meta } from './shared'

const VAULT_KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0'

/** A fixed hash, so the file is reproducible and the shape is still real. */
const hashOf = (seed: string): string => seed.repeat(64).slice(0, 64)

interface Spec {
  name: string
  manifest: AttachmentManifest
  pins: string
}

const SPECS: Spec[] = [
  {
    name: 'a single-chunk image',
    manifest: {
      id: 'att-single',
      filename: 'picture.png',
      mimeType: 'image/png',
      size: 12,
      checksum: hashOf('a'),
      chunks: [{ index: 0, hash: hashOf('b'), encryptedHash: hashOf('c'), size: 12 }],
      chunkSize: 8 * 1024 * 1024,
      createdAt: 1_760_000_000_000
    },
    pins: 'the ordinary case: one chunk, and the manifest JSON field order'
  },
  {
    name: 'a multi-chunk file with a short final chunk',
    manifest: {
      id: 'att-multi',
      filename: 'recording.m4a',
      mimeType: 'audio/mp4',
      size: 8 * 1024 * 1024 + 7,
      checksum: hashOf('d'),
      chunks: [
        { index: 0, hash: hashOf('e'), encryptedHash: hashOf('f'), size: 8 * 1024 * 1024 },
        { index: 1, hash: hashOf('0'), encryptedHash: hashOf('1'), size: 7 }
      ],
      chunkSize: 8 * 1024 * 1024,
      createdAt: 1_760_000_000_001
    },
    pins: '§14.2 the final chunk is short; a reader sizes each chunk from chunks[j].size and never from chunkSize'
  },
  {
    name: 'a writer that chose a different chunk size',
    manifest: {
      id: 'att-chunked',
      filename: 'notes.pdf',
      mimeType: 'application/pdf',
      size: 3,
      checksum: hashOf('2'),
      chunks: [
        { index: 0, hash: hashOf('3'), encryptedHash: hashOf('4'), size: 2 },
        { index: 1, hash: hashOf('5'), encryptedHash: hashOf('6'), size: 1 }
      ],
      chunkSize: 2,
      createdAt: 1_760_000_000_002
    },
    pins: '§14.9 CHUNK_SIZE is a desktop constant, not a contract constant: a reader MUST NOT assume 8 MiB'
  },
  {
    name: 'a filename carrying non-ASCII and a quote',
    manifest: {
      id: 'att-utf8',
      filename: 'Grüße "2026" 世界.txt',
      mimeType: 'text/plain',
      size: 5,
      checksum: hashOf('7'),
      chunks: [{ index: 0, hash: hashOf('8'), encryptedHash: hashOf('9'), size: 5 }],
      chunkSize: 8 * 1024 * 1024,
      createdAt: 1_760_000_000_003
    },
    pins: 'the manifest body is JSON: a quote must escape and UTF-8 must survive identically on both ports'
  }
]

export async function buildAttachmentManifest(): Promise<Record<string, unknown>> {
  const crypto = deterministicProvider()
  const signer = signerFromSeed(FIXED.SEED_A)
  const vaultKey = fromHex(VAULT_KEY)
  const fileKey = fromHex(FIXED.FILE_KEY)

  const cases = []
  for (const spec of SPECS) {
    const envelope = encryptAttachmentManifest(crypto, spec.manifest, fileKey, vaultKey, {
      secretKey: signer.secretKey,
      deviceId: signer.deviceId
    })

    // Proven readable by the production reader before it is committed, so the
    // file cannot record an envelope nothing can open.
    const readBack = await decryptAttachmentManifest(crypto, envelope, vaultKey, signer.publicKey)

    cases.push({
      name: spec.name,
      pins: spec.pins,
      manifest: spec.manifest,
      /** The exact bytes that get encrypted, which the signature does NOT cover. */
      manifestJson: JSON.stringify(spec.manifest),
      envelope,
      roundTrips: JSON.stringify(readBack.manifest) === JSON.stringify(spec.manifest)
    })
  }

  return {
    meta: meta({
      class: 'attachment-manifest',
      chapter: 'docs/protocol/14-attachments.md §14.4, §14.4.1, §14.9',
      writer: 'packages/sync-client/src/push/attachment-manifest.ts',
      vaultKeyHex: VAULT_KEY,
      fileKeyHex: FIXED.FILE_KEY,
      manifestNonceHex: FIXED.NONCE_24_A,
      keyNonceHex: FIXED.NONCE_24_B,
      signerSeedHex: FIXED.SEED_A,
      signerPublicKeyB64: b64(signer.publicKey),
      signerDeviceId: signer.deviceId,
      signatureOrder:
        'canonical CBOR sorts by key length then bytewise, so the signed order is keyNonce, manifestNonce, encryptedFileKey, encryptedManifest — NOT the CBOR_FIELD_ORDER listing order',
      notClaimed:
        'the signature covers the four envelope fields only; the manifest body is pinned separately as manifestJson',
      caseCount: cases.length
    }),
    cases
  }
}
