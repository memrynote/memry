import { parentPort } from 'worker_threads'
import sodium from 'libsodium-wrappers-sumo'
import { encryptItemForPush } from './encrypt'
import { decryptSingleItem } from './decrypt-item'
import { secureCleanup } from '../crypto/primitives'
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  EncryptedPushResult,
  DecryptedPullItem,
  DecryptionFailure
} from './worker-protocol'
import type { SyncItemType, SyncOperation } from '@shared/contracts/sync-api'

if (!parentPort) {
  throw new Error('worker.ts must be run as a worker_threads Worker')
}

const port = parentPort
let shuttingDown = false

async function init(): Promise<void> {
  await sodium.ready

  port.on('message', (msg: MainToWorkerMessage) => {
    switch (msg.type) {
      case 'encrypt-batch':
        handleEncryptBatch(msg)
        break
      case 'decrypt-batch':
        handleDecryptBatch(msg)
        break
      case 'shutdown':
        shuttingDown = true
        port.postMessage({ type: 'shutdown-ack' } satisfies WorkerToMainMessage)
        process.exit(0)
    }
    if (shuttingDown) process.exit(0)
  })

  port.postMessage({ type: 'ready' } satisfies WorkerToMainMessage)
}

function handleEncryptBatch(msg: Extract<MainToWorkerMessage, { type: 'encrypt-batch' }>): void {
  const results: EncryptedPushResult[] = []
  const errors: Array<{ queueId: string; itemId: string; error: string }> = []

  try {
    for (const item of msg.items) {
      try {
        const content = new TextEncoder().encode(item.payload)
        const result = encryptItemForPush({
          id: item.itemId,
          type: item.type as SyncItemType,
          operation: item.operation as SyncOperation,
          content,
          vaultKey: msg.vaultKey,
          signingSecretKey: msg.signingSecretKey,
          signerDeviceId: msg.signerDeviceId,
          clock: item.clock,
          stateVector: item.stateVector,
          deletedAt: item.deletedAt
        })
        results.push({
          queueId: item.queueId,
          pushItem: result.pushItem,
          sizeBytes: result.sizeBytes
        })
      } catch (err) {
        errors.push({
          queueId: item.queueId,
          itemId: item.itemId,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }

    port.postMessage({
      type: 'encrypt-batch-result',
      requestId: msg.requestId,
      results,
      errors
    } satisfies WorkerToMainMessage)
  } finally {
    secureCleanup(msg.vaultKey, msg.signingSecretKey)
  }
}

function handleDecryptBatch(msg: Extract<MainToWorkerMessage, { type: 'decrypt-batch' }>): void {
  const results: DecryptedPullItem[] = []
  const failures: DecryptionFailure[] = []

  try {
    for (const item of msg.items) {
      const signerKeyB64 = msg.signerKeys[item.signerDeviceId]
      if (!signerKeyB64) {
        failures.push({
          id: item.id,
          type: item.type,
          signerDeviceId: item.signerDeviceId,
          error: `No public key for signer device ${item.signerDeviceId}`,
          isCryptoError: false
        })
        continue
      }

      const signerPublicKey = sodium.from_base64(signerKeyB64, sodium.base64_variants.ORIGINAL)
      const outcome = decryptSingleItem(item, msg.vaultKey, signerPublicKey)

      if (outcome.ok) {
        results.push(outcome.item)
      } else {
        failures.push(outcome.failure)
      }
    }

    port.postMessage({
      type: 'decrypt-batch-result',
      requestId: msg.requestId,
      results,
      failures
    } satisfies WorkerToMainMessage)
  } finally {
    secureCleanup(msg.vaultKey)
  }
}

init().catch((err) => {
  console.error('Sync worker init failed:', err)
  process.exit(1)
})
