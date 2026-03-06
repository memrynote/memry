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
      errors: Array<{ queueId: string; itemId: string; error: string }>
    }
  | {
      type: 'decrypt-batch-result'
      requestId: string
      results: DecryptedPullItem[]
      failures: DecryptionFailure[]
    }
  | {
      type: 'error'
      requestId: string
      error: string
    }
  | { type: 'ready' }
  | { type: 'shutdown-ack' }
