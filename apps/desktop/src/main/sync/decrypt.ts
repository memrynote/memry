import sodium from 'libsodium-wrappers-sumo'
import { decrypt, unwrapFileKey } from '../crypto/encryption'
import { verifySignature } from '../crypto/signatures'
import { secureCleanup } from '../crypto/primitives'
import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'
import type { VectorClock } from '@memry/contracts/sync-api'
import { decompressPayload } from './compress'

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
  cryptoVersion: number
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

export function decryptItemFromPull(input: DecryptItemInput): DecryptItemResult {
  const version = input.cryptoVersion

  if (version < 1) {
    throw new Error(`Invalid crypto version: ${version}. Version must be >= 1.`)
  }

  switch (version) {
    case 1:
      return decryptV1(input, version)
    default:
      throw new Error(`Crypto version ${version} is not supported. Please update the app.`)
  }
}

function decryptV1(input: DecryptItemInput, version: number): DecryptItemResult {
  const signaturePayload: Record<string, unknown> = {
    id: input.id,
    type: input.type,
    operation: input.operation ?? 'update',
    cryptoVersion: version,
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
    const content = decompressPayload(plaintext)
    return { content, verified: true }
  } finally {
    secureCleanup(fileKey)
  }
}
