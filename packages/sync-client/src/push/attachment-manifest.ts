import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'
import { encodeCbor } from '../pull/cbor.ts'
import type { SyncCryptoProvider } from '../pull/crypto-provider.ts'
import type { SyncPushCryptoProvider } from './crypto-provider.ts'

/**
 * The attachment manifest, encrypted and signed exactly as desktop does it
 * (`apps/desktop/src/main/sync/attachments.ts`).
 *
 * The manifest is the only thing that names the file: the chunks in R2 are
 * opaque ciphertext addressed by hash. So the signature here is what stops a
 * server-side swap from redirecting a note's picture at somebody else's bytes,
 * and it must cover the same four fields, in the same CBOR order, on both
 * shells.
 */

export interface AttachmentChunkRef {
  index: number
  /** sha256 of the PLAINTEXT chunk — the integrity check after decrypt. */
  hash: string
  /** sha256 of `nonce || ciphertext` — how the chunk is addressed in R2. */
  encryptedHash: string
  size: number
}

export interface AttachmentManifest {
  id: string
  filename: string
  mimeType: string
  size: number
  /** sha256 of the whole plaintext file. */
  checksum: string
  chunks: AttachmentChunkRef[]
  chunkSize: number
  createdAt: number
}

export interface EncryptedAttachmentManifest {
  encryptedManifest: string
  manifestNonce: string
  encryptedFileKey: string
  keyNonce: string
  manifestSignature: string
  signerDeviceId: string
}

function signaturePayload(manifest: {
  encryptedManifest: string
  manifestNonce: string
  encryptedFileKey: string
  keyNonce: string
}): Uint8Array {
  return encodeCbor(
    {
      encryptedManifest: manifest.encryptedManifest,
      manifestNonce: manifest.manifestNonce,
      encryptedFileKey: manifest.encryptedFileKey,
      keyNonce: manifest.keyNonce
    },
    CBOR_FIELD_ORDER.ATTACHMENT_MANIFEST
  )
}

export function encryptAttachmentManifest(
  crypto: SyncPushCryptoProvider,
  manifest: AttachmentManifest,
  fileKey: Uint8Array,
  vaultKey: Uint8Array,
  signing: { secretKey: Uint8Array; deviceId: string }
): EncryptedAttachmentManifest {
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
  const { ciphertext, nonce: manifestNonce } = crypto.encrypt(manifestBytes, fileKey)
  const { wrappedKey, nonce: keyNonce } = crypto.wrapFileKey(fileKey, vaultKey)

  const fields = {
    encryptedManifest: crypto.toBase64(ciphertext),
    manifestNonce: crypto.toBase64(manifestNonce),
    encryptedFileKey: crypto.toBase64(wrappedKey),
    keyNonce: crypto.toBase64(keyNonce)
  }

  return {
    ...fields,
    manifestSignature: crypto.toBase64(
      crypto.signDetached(signaturePayload(fields), signing.secretKey)
    ),
    signerDeviceId: signing.deviceId
  }
}

export class ManifestSignatureError extends Error {
  constructor(public readonly signerDeviceId: string) {
    super(`Manifest signature verification failed for device ${signerDeviceId}`)
    this.name = 'ManifestSignatureError'
  }
}

export async function decryptAttachmentManifest(
  crypto: SyncCryptoProvider,
  encrypted: EncryptedAttachmentManifest,
  vaultKey: Uint8Array,
  signerPublicKey: Uint8Array
): Promise<{ manifest: AttachmentManifest; fileKey: Uint8Array }> {
  const verified = await crypto.verifyDetached(
    crypto.fromBase64(encrypted.manifestSignature),
    signaturePayload(encrypted),
    signerPublicKey
  )
  if (!verified) throw new ManifestSignatureError(encrypted.signerDeviceId)

  const fileKey = await crypto.unwrapFileKey(
    crypto.fromBase64(encrypted.encryptedFileKey),
    crypto.fromBase64(encrypted.keyNonce),
    vaultKey
  )
  const manifestBytes = await crypto.decrypt(
    crypto.fromBase64(encrypted.encryptedManifest),
    crypto.fromBase64(encrypted.manifestNonce),
    fileKey
  )

  return {
    manifest: JSON.parse(new TextDecoder().decode(manifestBytes)) as AttachmentManifest,
    fileKey
  }
}
