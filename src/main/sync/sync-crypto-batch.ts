import sodium from 'libsodium-wrappers-sumo'
import { createLogger } from '../lib/logger'
import { encryptItemForPush } from './encrypt'
import { decryptSingleItem } from './decrypt-item'
import type { SyncQueueManager } from './queue'
import type { SyncWorkerBridge } from './worker-bridge'
import type {
  RawPushItem,
  PullItemForDecrypt,
  DecryptedPullItem,
  DecryptionFailure
} from './worker-protocol'
import type {
  PullItemResponse,
  PushItem,
  SyncItemType,
  SyncOperation
} from '@shared/contracts/sync-api'

const log = createLogger('SyncCryptoBatch')

export interface EncryptBatchDeps {
  workerBridge?: SyncWorkerBridge
  queue: SyncQueueManager
  extractPayloadMetadata: (payload: string) => {
    clock?: Record<string, number>
    stateVector?: string
  }
  resolvePushPayload: (
    item: { id: string; itemId: string; type: string; operation: string; payload: string },
    deviceId: string
  ) => string
}

type QueueRow = {
  id: string
  itemId: string
  type: string
  operation: string
  payload: string
}

export async function encryptPushBatch(
  items: QueueRow[],
  vaultKey: Uint8Array,
  signingSecretKey: Uint8Array,
  signerDeviceId: string,
  deps: EncryptBatchDeps
): Promise<Array<{ queueId: string; pushItem: PushItem }>> {
  const prepareItem = (
    item: QueueRow
  ): {
    payload: string
    meta: ReturnType<EncryptBatchDeps['extractPayloadMetadata']>
    deletedAt?: number
  } => {
    const payload = deps.resolvePushPayload(item, signerDeviceId)
    const meta = deps.extractPayloadMetadata(payload)
    return {
      payload,
      meta,
      ...(item.operation === 'delete' ? { deletedAt: Math.floor(Date.now() / 1000) } : {})
    }
  }

  if (deps.workerBridge?.isRunning) {
    const rawItems: RawPushItem[] = items.map((item) => {
      const { payload, meta, deletedAt } = prepareItem(item)
      return {
        queueId: item.id,
        itemId: item.itemId,
        type: item.type as SyncItemType,
        operation: item.operation as SyncOperation,
        payload,
        clock: meta.clock,
        stateVector: meta.stateVector,
        deletedAt
      }
    })

    const { results, errors } = await deps.workerBridge.encryptBatch(
      rawItems,
      vaultKey,
      signingSecretKey,
      signerDeviceId
    )

    for (const err of errors) {
      log.error('Push: worker encrypt failed', { itemId: err.itemId, error: err.error })
      deps.queue.markFailed(err.queueId, `Encrypt failed: ${err.error}`)
    }

    return results.map((r) => ({ queueId: r.queueId, pushItem: r.pushItem }))
  }

  return items.map((item) => {
    const { payload, meta, deletedAt } = prepareItem(item)
    const result = encryptItemForPush({
      id: item.itemId,
      type: item.type as Parameters<typeof encryptItemForPush>[0]['type'],
      operation: item.operation as Parameters<typeof encryptItemForPush>[0]['operation'],
      content: new TextEncoder().encode(payload),
      vaultKey,
      signingSecretKey,
      signerDeviceId,
      clock: meta.clock,
      stateVector: meta.stateVector,
      deletedAt
    })
    return { queueId: item.id, pushItem: result.pushItem }
  })
}

export interface DecryptBatchDeps {
  workerBridge?: SyncWorkerBridge
  resolveDeviceKey: (deviceId: string) => Promise<Uint8Array | null>
}

export async function decryptPullBatch(
  items: PullItemResponse[],
  vaultKey: Uint8Array,
  deps: DecryptBatchDeps
): Promise<{
  decrypted: DecryptedPullItem[]
  failures: DecryptionFailure[]
}> {
  if (deps.workerBridge?.isRunning) {
    const signerKeys: Record<string, string> = {}
    const skipped: DecryptionFailure[] = []
    const workerItems: PullItemForDecrypt[] = []

    for (const item of items) {
      const pubKey = await deps.resolveDeviceKey(item.signerDeviceId)
      if (!pubKey) {
        skipped.push({
          id: item.id,
          type: item.type,
          signerDeviceId: item.signerDeviceId,
          error: `No public key for signer device ${item.signerDeviceId}`,
          isCryptoError: false,
          isSignatureError: false
        })
        continue
      }
      if (!signerKeys[item.signerDeviceId]) {
        signerKeys[item.signerDeviceId] = sodium.to_base64(pubKey, sodium.base64_variants.ORIGINAL)
      }
      workerItems.push({
        id: item.id,
        type: item.type,
        operation: item.operation,
        cryptoVersion: item.cryptoVersion ?? 1,
        encryptedKey: item.blob.encryptedKey,
        keyNonce: item.blob.keyNonce,
        encryptedData: item.blob.encryptedData,
        dataNonce: item.blob.dataNonce,
        signature: item.signature,
        signerDeviceId: item.signerDeviceId,
        deletedAt: item.deletedAt,
        clock: item.clock,
        stateVector: item.stateVector
      })
    }

    if (workerItems.length === 0) {
      return { decrypted: [], failures: skipped }
    }

    const { results, failures } = await deps.workerBridge.decryptBatch(
      workerItems,
      vaultKey,
      signerKeys
    )

    return {
      decrypted: results,
      failures: [...skipped, ...failures]
    }
  }

  const decrypted: DecryptedPullItem[] = []
  const failures: DecryptionFailure[] = []

  for (const item of items) {
    const signerPubKey = await deps.resolveDeviceKey(item.signerDeviceId)
    if (!signerPubKey) {
      failures.push({
        id: item.id,
        type: item.type,
        signerDeviceId: item.signerDeviceId,
        error: `No public key for signer device ${item.signerDeviceId}`,
        isCryptoError: false,
        isSignatureError: false
      })
      continue
    }

    const result = decryptSingleItem(
      {
        id: item.id,
        type: item.type,
        operation: item.operation,
        cryptoVersion: item.cryptoVersion ?? 1,
        encryptedKey: item.blob.encryptedKey,
        keyNonce: item.blob.keyNonce,
        encryptedData: item.blob.encryptedData,
        dataNonce: item.blob.dataNonce,
        signature: item.signature,
        signerDeviceId: item.signerDeviceId,
        deletedAt: item.deletedAt,
        clock: item.clock,
        stateVector: item.stateVector
      },
      vaultKey,
      signerPubKey
    )

    if (result.ok) {
      decrypted.push(result.item)
    } else {
      failures.push(result.failure)
    }
  }

  return { decrypted, failures }
}
