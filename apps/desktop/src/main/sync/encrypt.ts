import sodium from 'libsodium-wrappers-sumo'
import { encrypt, wrapFileKey } from '../crypto/encryption'
import { signPayload } from '../crypto/signatures'
import { generateFileKey, secureCleanup } from '../crypto/primitives'
import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'
import type { PushItem, SyncItemType, SyncOperation, VectorClock } from '@memry/contracts/sync-api'
// Compression before encryption: compression oracle risk accepted because CRDT updates
// have low entropy variance (attacker can't adaptively probe content) and all crypto
// operations use constant-time primitives (no timing side-channel)
import { compressPayload } from './compress'

export interface EncryptItemInput {
  id: string
  type: SyncItemType
  operation: SyncOperation
  content: Uint8Array
  vaultKey: Uint8Array
  signingSecretKey: Uint8Array
  signerDeviceId: string
  clock?: VectorClock
  stateVector?: string
  deletedAt?: number
}

export interface EncryptItemResult {
  pushItem: PushItem
  sizeBytes: number
}

export function encryptItemForPush(input: EncryptItemInput): EncryptItemResult {
  const MAX_SYNC_SIZE = 5 * 1024 * 1024
  const BASE64_CRYPTO_OVERHEAD = 1.37
  const estimatedSize = input.content.byteLength * BASE64_CRYPTO_OVERHEAD
  if (estimatedSize > MAX_SYNC_SIZE) {
    const estimatedMB = (estimatedSize / (1024 * 1024)).toFixed(1)
    throw new Error(`Item too large for sync (estimated ${estimatedMB}MB, max 5MB)`)
  }

  const fileKey = generateFileKey()

  try {
    const compressed = compressPayload(input.content)
    const { ciphertext, nonce: dataNonce } = encrypt(compressed, fileKey)
    const { wrappedKey, nonce: keyNonce } = wrapFileKey(fileKey, input.vaultKey)

    const toB64 = (bytes: Uint8Array): string =>
      sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)

    const encryptedKeyB64 = toB64(wrappedKey)
    const keyNonceB64 = toB64(keyNonce)
    const encryptedDataB64 = toB64(ciphertext)
    const dataNonceB64 = toB64(dataNonce)

    const signaturePayload: Record<string, unknown> = {
      id: input.id,
      type: input.type,
      operation: input.operation,
      cryptoVersion: 1,
      encryptedKey: encryptedKeyB64,
      keyNonce: keyNonceB64,
      encryptedData: encryptedDataB64,
      dataNonce: dataNonceB64
    }

    if (input.deletedAt !== undefined) {
      signaturePayload.deletedAt = input.deletedAt
    }

    if (input.clock || input.stateVector) {
      const metadata: Record<string, unknown> = {}
      if (input.clock) metadata.clock = input.clock
      if (input.stateVector) metadata.stateVector = input.stateVector
      signaturePayload.metadata = metadata
    }

    const signature = signPayload(
      signaturePayload,
      CBOR_FIELD_ORDER.SYNC_ITEM,
      input.signingSecretKey
    )

    const sizeBytes = ciphertext.length

    return {
      pushItem: {
        id: input.id,
        type: input.type,
        operation: input.operation,
        encryptedKey: encryptedKeyB64,
        keyNonce: keyNonceB64,
        encryptedData: encryptedDataB64,
        dataNonce: dataNonceB64,
        signature: toB64(signature),
        signerDeviceId: input.signerDeviceId,
        ...(input.clock && { clock: input.clock }),
        ...(input.stateVector && { stateVector: input.stateVector }),
        ...(input.deletedAt !== undefined && { deletedAt: input.deletedAt })
      },
      sizeBytes
    }
  } finally {
    secureCleanup(fileKey)
  }
}
