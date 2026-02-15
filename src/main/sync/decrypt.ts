import sodium from 'libsodium-wrappers-sumo'
import { decrypt, unwrapFileKey } from '../crypto/encryption'
import { verifySignature } from '../crypto/signatures'
import { secureCleanup } from '../crypto/index'
import { CBOR_FIELD_ORDER } from '@shared/contracts/cbor-ordering'
import type { VectorClock } from '@shared/contracts/sync-api'

export class SignatureVerificationError extends Error {
  constructor(
    public readonly itemId: string,
    public readonly signerDeviceId: string
  ) {
    super(`Signature verification failed for item ${itemId} from device ${signerDeviceId}`)
    this.name = 'SignatureVerificationError'
  }
}

export interface DecryptItemInput {
  id: string
  type: string
  operation?: string
  cryptoVersion?: number
  encryptedKey: string
  keyNonce: string
  encryptedData: string
  dataNonce: string
  signature: string
  signerDeviceId: string
  deletedAt?: number
  metadata?: { clock?: VectorClock; stateVector?: string }
  vaultKey: Uint8Array
  signerPublicKey: Uint8Array
}

export interface DecryptItemResult {
  content: Uint8Array
  verified: true
}

const SUPPORTED_CRYPTO_VERSIONS = [1]

export function decryptItemFromPull(input: DecryptItemInput): DecryptItemResult {
  const version = input.cryptoVersion ?? 1
  if (!SUPPORTED_CRYPTO_VERSIONS.includes(version)) {
    throw new Error(`Unsupported crypto version: ${version}`)
  }

  const signaturePayload: Record<string, unknown> = {
    id: input.id,
    type: input.type,
    operation: input.operation ?? 'update',
    cryptoVersion: input.cryptoVersion ?? 1,
    encryptedKey: input.encryptedKey,
    keyNonce: input.keyNonce,
    encryptedData: input.encryptedData,
    dataNonce: input.dataNonce
  }

  if (input.deletedAt !== undefined) {
    signaturePayload.deletedAt = input.deletedAt
  }

  if (input.metadata) {
    signaturePayload.metadata = input.metadata
  }

  const signatureBytes = sodium.from_base64(input.signature, sodium.base64_variants.ORIGINAL)

  const verified = verifySignature(
    signaturePayload,
    CBOR_FIELD_ORDER.SYNC_ITEM,
    signatureBytes,
    input.signerPublicKey
  )

  if (!verified) {
    throw new SignatureVerificationError(input.id, input.signerDeviceId)
  }

  const wrappedKey = sodium.from_base64(input.encryptedKey, sodium.base64_variants.ORIGINAL)
  const keyNonce = sodium.from_base64(input.keyNonce, sodium.base64_variants.ORIGINAL)
  const encryptedData = sodium.from_base64(input.encryptedData, sodium.base64_variants.ORIGINAL)
  const dataNonce = sodium.from_base64(input.dataNonce, sodium.base64_variants.ORIGINAL)

  const fileKey = unwrapFileKey(wrappedKey, keyNonce, input.vaultKey)

  try {
    const plaintext = decrypt(encryptedData, dataNonce, fileKey)
    return { content: plaintext, verified: true }
  } finally {
    secureCleanup(fileKey)
  }
}
