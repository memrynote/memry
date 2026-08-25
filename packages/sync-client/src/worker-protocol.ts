import type { PushItem, SyncItemType, SyncOperation, VectorClock } from '@memry/contracts/sync-api'

export interface RawPushItem {
  queueId: string
  itemId: string
  type: SyncItemType
  operation: SyncOperation
  payload: string
  clock?: VectorClock
  stateVector?: string
  deletedAt?: number
}

export interface EncryptedPushResult {
  queueId: string
  pushItem: PushItem
  sizeBytes: number
}

export interface PullItemForDecrypt {
  id: string
  type: string
  operation: string
  cryptoVersion: number
  encryptedKey: string
  keyNonce: string
  encryptedData: string
  dataNonce: string
  signature: string
  signerDeviceId: string
  deletedAt?: number
  clock?: VectorClock
  stateVector?: string
}

export interface DecryptedPullItem {
  id: string
  type: string
  operation: string
  content: string
  clock?: VectorClock
  deletedAt?: number
  signerDeviceId: string
}

export interface DecryptionFailure {
  id: string
  type: string
  signerDeviceId: string
  error: string
  isCryptoError: boolean
  isSignatureError: boolean
}

/**
 * One CRDT payload (a snapshot blob or an incremental update) to decrypt off
 * the main thread. Exactly one of `data` / `dataB64` is set: snapshots arrive
 * from the HTTP layer already byte-decoded, batch/incremental updates arrive
 * as the server's base64 strings and are decoded in the worker — that decode
 * loop is part of what this offloads.
 */
export interface CrdtPayloadForDecrypt {
  /** Position in the request array; results and failures refer back to it. */
  index: number
  noteId: string
  data?: Uint8Array
  dataB64?: string
  signerDeviceId: string
}

export interface CrdtDecryptFailure {
  index: number
  noteId: string
  error: string
  isSignatureError: boolean
}

/**
 * The exact bytes the main-thread path derives from a server base64 payload
 * (`atob` + charCode loop). Shared by the worker and every fallback so the two
 * paths cannot drift.
 */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

export type MainToWorkerMessage =
  | {
      type: 'encrypt-batch'
      requestId: string
      items: RawPushItem[]
      vaultKey: Uint8Array
      signingSecretKey: Uint8Array
      signerDeviceId: string
    }
  | {
      type: 'decrypt-batch'
      requestId: string
      items: PullItemForDecrypt[]
      vaultKey: Uint8Array
      signerKeys: Record<string, string>
    }
  | {
      type: 'decrypt-crdt-batch'
      requestId: string
      items: CrdtPayloadForDecrypt[]
      vaultKey: Uint8Array
      signerKeys: Record<string, string>
    }
  | { type: 'shutdown' }

// libsodium-wrappers throws plain Error objects with no custom subclass,
// so instanceof checks won't work for sodium-thrown errors. String matching
// against known error message fragments is the only reliable detection.
const CRYPTO_ERROR_PATTERNS = ['signature', 'decrypt', 'sodium', 'nonce', 'base64'] as const

export function isCryptoErrorMessage(msg: string): boolean {
  const lower = msg.toLowerCase()
  return CRYPTO_ERROR_PATTERNS.some((p) => lower.includes(p))
}

export type WorkerToMainMessage =
  | {
      type: 'encrypt-batch-result'
      requestId: string
      results: EncryptedPushResult[]
      // `code` marks the failures the main thread must handle specifically.
      // An Error subclass cannot cross the worker boundary, so the
      // discriminator has to travel as data.
      errors: Array<{
        queueId: string
        itemId: string
        error: string
        code?: 'item_too_large'
      }>
    }
  | {
      type: 'decrypt-batch-result'
      requestId: string
      results: DecryptedPullItem[]
      failures: DecryptionFailure[]
    }
  | {
      type: 'decrypt-crdt-batch-result'
      requestId: string
      results: Array<{ index: number; update: Uint8Array }>
      failures: CrdtDecryptFailure[]
    }
  | {
      type: 'error'
      requestId: string
      error: string
    }
  | { type: 'ready' }
  | { type: 'shutdown-ack' }
