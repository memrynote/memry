import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'
import type { PushItem, SyncItemType, SyncOperation, VectorClock } from '@memry/contracts/sync-api'
import { compressPayload } from '../compress.ts'
import {
  ItemTooLargeError,
  SYNC_ITEM_ENCRYPT_OVERHEAD,
  SYNC_ITEM_MAX_ENCRYPT_BYTES
} from '../note-size.ts'
import { encodeCbor } from '../pull/cbor.ts'
import type { SyncPushCryptoProvider } from './crypto-provider.ts'

/**
 * Platform-free twin of desktop's `encryptItemForPush`
 * (`apps/desktop/src/main/sync/encrypt.ts`) — same compress → encrypt → wrap →
 * sign chain, same canonical CBOR signature payload, with the crypto calls
 * going through the injected provider.
 *
 * The signature payload must stay byte-identical to desktop's construction or
 * every device that pulls this item fails verification and drops it. It is the
 * exact inverse of `decryptRecordItem`, and the two are pinned against each
 * other by `record-roundtrip.test.ts`.
 */
export interface EncryptRecordInput {
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

export async function encryptRecordForPush(
  crypto: SyncPushCryptoProvider,
  input: EncryptRecordInput
): Promise<{ pushItem: PushItem; sizeBytes: number }> {
  const estimatedSize = input.content.byteLength * SYNC_ITEM_ENCRYPT_OVERHEAD
  if (estimatedSize > SYNC_ITEM_MAX_ENCRYPT_BYTES) {
    // Typed, so the queue layers can tell this apart from a crypto failure and
    // name the note that stopped syncing instead of only writing a reason onto
    // a row nobody reads.
    throw new ItemTooLargeError(input.id, estimatedSize, SYNC_ITEM_MAX_ENCRYPT_BYTES)
  }

  const fileKey = crypto.generateFileKey()
  try {
    const compressed = compressPayload(input.content)
    const { ciphertext, nonce: dataNonce } = crypto.encrypt(compressed, fileKey)
    const { wrappedKey, nonce: keyNonce } = crypto.wrapFileKey(fileKey, input.vaultKey)

    const encryptedKey = crypto.toBase64(wrappedKey)
    const keyNonceB64 = crypto.toBase64(keyNonce)
    const encryptedData = crypto.toBase64(ciphertext)
    const dataNonceB64 = crypto.toBase64(dataNonce)

    const signaturePayload: Record<string, unknown> = {
      id: input.id,
      type: input.type,
      operation: input.operation,
      cryptoVersion: 1,
      encryptedKey,
      keyNonce: keyNonceB64,
      encryptedData,
      dataNonce: dataNonceB64
    }

    if (input.deletedAt !== undefined) {
      signaturePayload.deletedAt = input.deletedAt
    }

    // Nested object construction matches desktop exactly: clock first, then
    // stateVector, and the `metadata` key ABSENT (not undefined) when neither
    // exists — CBOR encodes the nested object's own key order.
    if (input.clock || input.stateVector) {
      const metadata: Record<string, unknown> = {}
      if (input.clock) metadata.clock = input.clock
      if (input.stateVector) metadata.stateVector = input.stateVector
      signaturePayload.metadata = metadata
    }

    const message = encodeCbor(signaturePayload, CBOR_FIELD_ORDER.SYNC_ITEM)
    const signature = crypto.signDetached(message, input.signingSecretKey)

    return {
      pushItem: {
        id: input.id,
        type: input.type,
        operation: input.operation,
        encryptedKey,
        keyNonce: keyNonceB64,
        encryptedData,
        dataNonce: dataNonceB64,
        signature: crypto.toBase64(signature),
        signerDeviceId: input.signerDeviceId,
        ...(input.clock ? { clock: input.clock } : {}),
        ...(input.stateVector ? { stateVector: input.stateVector } : {}),
        ...(input.deletedAt !== undefined ? { deletedAt: input.deletedAt } : {})
      },
      sizeBytes: ciphertext.length
    }
  } finally {
    fileKey.fill(0)
  }
}
