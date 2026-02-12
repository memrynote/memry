import { createHash } from 'crypto'
import sodium from 'libsodium-wrappers-sumo'
import { generateFileKey } from '../crypto/keys'
import { encrypt, wrapFileKey } from '../crypto/encryption'
import { signPayload } from '../crypto/signatures'
import { secureCleanup } from '../crypto/index'
import { CBOR_FIELD_ORDER } from '@shared/contracts/cbor-ordering'
import type { PushItem, SyncItemType, SyncOperation, VectorClock } from '@shared/contracts/sync-api'

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
  contentHash: string
  sizeBytes: number
}

export function encryptItemForPush(input: EncryptItemInput): EncryptItemResult {
  const fileKey = generateFileKey()

  try {
    const { ciphertext, nonce: dataNonce } = encrypt(input.content, fileKey)
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

    const contentHash = createHash('sha256').update(ciphertext).digest('hex')
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
        ...(input.stateVector && { stateVector: input.stateVector })
      },
      contentHash,
      sizeBytes
    }
  } finally {
    secureCleanup(fileKey)
  }
}
