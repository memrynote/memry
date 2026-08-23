import sodium from 'libsodium-wrappers-sumo'
import { createLogger } from '../lib/logger'
import { encryptItemForPush } from './encrypt'
import { decryptSingleItem } from './decrypt-item'
import { ItemTooLargeError } from '@memry/sync-client/note-size'
import type { SyncQueueManager } from './queue'
import type { SyncWorkerBridge } from './worker-bridge'
import type {
  RawPushItem,
  PullItemForDecrypt,
  DecryptedPullItem,
  DecryptionFailure
} from '@memry/sync-client/worker-protocol'
import type {
  PullItemResponse,
  PushItem,
  SyncItemType,
  SyncOperation
} from '@memry/contracts/sync-api'

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
    deviceId: string,
    vaultKey: Uint8Array
  ) => string
  /**
   * Called for an item the encrypt cap rejected. `markFailed` still runs — this
   * is the extra hop that lets the caller tell the user which note stopped
   * syncing, instead of the rejection living only on the queue row (#1465).
   */
  onItemTooLarge?: (item: { itemId: string; type: string; payload: string }) => void
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
  signingKeyBytes: Uint8Array,
  signerDeviceId: string,
  deps: EncryptBatchDeps
): Promise<Array<{ queueId: string; pushItem: PushItem }>> {
  // Prepared once, used by whichever path ends up doing the crypto. Building it
  // up front (rather than per path) keeps the worker request and the
  // main-thread fallback byte-identical: resolvePushPayload reads live DB rows,
  // so re-running it after a worker failure could hand the fallback a different
  // payload than the one the worker was asked to encrypt.
  const rawItems: RawPushItem[] = items.map((item) => {
    const payload = deps.resolvePushPayload(item, signerDeviceId, vaultKey)
    const meta = deps.extractPayloadMetadata(payload)
    return {
      queueId: item.id,
      itemId: item.itemId,
      type: item.type as SyncItemType,
      operation: item.operation as SyncOperation,
      payload,
      clock: meta.clock,
      stateVector: meta.stateVector,
      deletedAt: item.operation === 'delete' ? Math.floor(Date.now() / 1000) : undefined
    }
  })

  if (deps.workerBridge?.isRunning) {
    try {
      const { results, errors } = await deps.workerBridge.encryptBatch(
        rawItems,
        vaultKey,
        signingKeyBytes,
        signerDeviceId
      )

      const byQueueId = new Map(rawItems.map((item) => [item.queueId, item]))
      for (const err of errors) {
        log.error('Push: worker encrypt failed', { itemId: err.itemId, error: err.error })
        deps.queue.markFailed(err.queueId, `Encrypt failed: ${err.error}`)
        const source = byQueueId.get(err.queueId)
        if (err.code === 'item_too_large' && source) {
          deps.onItemTooLarge?.({
            itemId: source.itemId,
            type: source.type,
            payload: source.payload
          })
        }
      }

      return results.map((r) => ({ queueId: r.queueId, pushItem: r.pushItem }))
    } catch (err) {
      // Only worker transport/lifecycle failures reach here — the worker never
      // rejects the request for a crypto failure. Per-item crypto errors come
      // back in-band in `errors` above; a reject means "worker not started",
      // request timeout, worker `error`/non-zero `exit` (rejectAll), an
      // `{ type: 'error' }` protocol reply, or an unexpected response type.
      // Falling through therefore cannot swallow a crypto/auth failure: the
      // fallback re-runs the exact same encryptItemForPush on the same inputs,
      // so a genuinely bad item still fails, just on this thread.
      log.error('Push: worker crypto unavailable, falling back to main thread', {
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  const encrypted: Array<{ queueId: string; pushItem: PushItem }> = []
  for (const item of rawItems) {
    try {
      const result = encryptItemForPush({
        id: item.itemId,
        type: item.type,
        operation: item.operation,
        content: new TextEncoder().encode(item.payload),
        vaultKey,
        ['signingSecretKey']: signingKeyBytes,
        signerDeviceId,
        clock: item.clock,
        stateVector: item.stateVector,
        deletedAt: item.deletedAt
      })
      encrypted.push({ queueId: item.queueId, pushItem: result.pushItem })
    } catch (err) {
      // Only the size cap is handled here. It is per-item and permanent, so
      // letting it abort the whole batch would keep every other queued edit
      // from pushing. Any other failure still propagates, exactly as before.
      if (!(err instanceof ItemTooLargeError)) throw err
      log.error('Push: item over the sync size cap', {
        itemId: item.itemId,
        type: item.type,
        error: err.message
      })
      deps.queue.markFailed(item.queueId, `Encrypt failed: ${err.message}`)
      deps.onItemTooLarge?.({ itemId: item.itemId, type: item.type, payload: item.payload })
    }
  }
  return encrypted
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

    try {
      const { results, failures } = await deps.workerBridge.decryptBatch(
        workerItems,
        vaultKey,
        signerKeys
      )

      return {
        decrypted: results,
        failures: [...skipped, ...failures]
      }
    } catch (err) {
      // Same reasoning as the push path: a reject is a worker transport or
      // lifecycle failure, never a crypto verdict — per-item decrypt and
      // signature failures arrive in-band in `failures`. The loop below re-runs
      // the identical decryptSingleItem (signature verification included) on
      // this thread, so nothing unverified is accepted. It also re-derives
      // `skipped` from the cached device keys, so those failures are neither
      // lost nor duplicated.
      log.error('Pull: worker crypto unavailable, falling back to main thread', {
        error: err instanceof Error ? err.message : String(err)
      })
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
