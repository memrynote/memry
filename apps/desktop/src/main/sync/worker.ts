import { parentPort } from 'worker_threads'
import sodium from 'libsodium-wrappers-sumo'
import { encryptItemForPush } from './encrypt'
import { decryptSingleItem } from './decrypt-item'
import { decryptCrdtUpdate } from './crdt-encrypt'
import { SignatureVerificationError } from './decrypt'
import { ItemTooLargeError } from '@memry/sync-client/note-size'
import { base64ToBytes } from '@memry/sync-client/worker-protocol'
import { secureCleanup } from '../crypto/primitives'
import { createLogger } from '../lib/logger'
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  EncryptedPushResult,
  DecryptedPullItem,
  DecryptionFailure,
  CrdtDecryptFailure
} from '@memry/sync-client/worker-protocol'
if (!parentPort) {
  throw new Error('worker.ts must be run as a worker_threads Worker')
}

const port = parentPort
const log = createLogger('SyncWorker')
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
      case 'decrypt-crdt-batch':
        handleDecryptCrdtBatch(msg)
        break
      case 'shutdown':
        // The exit is delegated to the `if (shuttingDown)` line below (which
        // already existed for exactly this) rather than called inline, so this
        // case can `break` and a `default:` can follow it without falling
        // through. Same tick, same behaviour as the previous inline exit.
        shuttingDown = true
        port.postMessage({ type: 'shutdown-ack' } satisfies WorkerToMainMessage)
        break
      default:
        handleUnknownMessage(msg)
        break
    }
    if (shuttingDown) process.exit(0)
  })

  port.postMessage({ type: 'ready' } satisfies WorkerToMainMessage)
}

/**
 * Reply to a message kind this worker build does not know about.
 *
 * A packaged install can end up with a main bundle and a worker bundle from
 * different builds (partial update, stale asar). Before this existed the switch
 * above simply dropped such a message with no reply, so the parent's promise
 * only settled when worker-bridge's REQUEST_TIMEOUT_MS (60s) fired — every
 * crypto batch stalled a full minute. A typed `error` reply lets
 * SyncWorkerBridge.encryptBatch/decryptBatch reject immediately instead.
 *
 * Compat: unreachable when main and worker come from the same build, because
 * every kind in `MainToWorkerMessage` is handled above — which is why `msg`
 * narrows to `never` here. Same-build installs see no behaviour change at all.
 */
function handleUnknownMessage(msg: never): void {
  const unknown = msg as { type?: unknown; requestId?: unknown }
  const kind = typeof unknown.type === 'string' ? unknown.type : String(unknown.type)

  log.warn('Unsupported message kind from main process', { kind })

  // `shutdown` is the only known kind with no requestId, and an unknown kind
  // without one has no pending promise to settle. Replying `requestId:
  // undefined` would put an off-protocol message on the wire that
  // worker-bridge's `'requestId' in msg` check would accept and then look up as
  // the key `undefined`, so stay silent in that case.
  if (typeof unknown.requestId !== 'string') return

  port.postMessage({
    type: 'error',
    requestId: unknown.requestId,
    error: `Unsupported worker message kind: ${kind}`
  } satisfies WorkerToMainMessage)
}

function handleEncryptBatch(msg: Extract<MainToWorkerMessage, { type: 'encrypt-batch' }>): void {
  const results: EncryptedPushResult[] = []
  const errors: Array<{
    queueId: string
    itemId: string
    error: string
    code?: 'item_too_large'
  }> = []

  try {
    for (const item of msg.items) {
      try {
        const content = new TextEncoder().encode(item.payload)
        const result = encryptItemForPush({
          id: item.itemId,
          type: item.type,
          operation: item.operation,
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
          error: err instanceof Error ? err.message : String(err),
          ...(err instanceof ItemTooLargeError ? { code: 'item_too_large' as const } : {})
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
          isCryptoError: false,
          isSignatureError: false
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
  const message = err instanceof Error ? err.message : String(err)
  log.error('Sync worker init failed', { message })
  process.exit(1)
})

/**
 * Decrypt a page of CRDT snapshot/update payloads off the main thread — the
 * same `decryptCrdtUpdate` the main-thread fallback runs, so a verdict cannot
 * differ by thread. Exactly one of `data` / `dataB64` is set per item; the
 * base64 decode of server payloads (the `atob` + charCode loop) happens here.
 */
function handleDecryptCrdtBatch(
  msg: Extract<MainToWorkerMessage, { type: 'decrypt-crdt-batch' }>
): void {
  const results: Array<{ index: number; update: Uint8Array }> = []
  const failures: CrdtDecryptFailure[] = []

  try {
    for (const item of msg.items) {
      const signerKeyB64 = msg.signerKeys[item.signerDeviceId]
      if (!signerKeyB64) {
        failures.push({
          index: item.index,
          noteId: item.noteId,
          error: `No public key for signer device ${item.signerDeviceId}`,
          isSignatureError: false
        })
        continue
      }

      const packed = item.data ?? base64ToBytes(item.dataB64 as string)
      const signerPublicKey = sodium.from_base64(signerKeyB64, sodium.base64_variants.ORIGINAL)

      try {
        const update = decryptCrdtUpdate(packed, msg.vaultKey, item.noteId, signerPublicKey)
        results.push({ index: item.index, update })
      } catch (err) {
        failures.push({
          index: item.index,
          noteId: item.noteId,
          error: err instanceof Error ? err.message : String(err),
          isSignatureError: err instanceof SignatureVerificationError
        })
      }
    }

    port.postMessage({
      type: 'decrypt-crdt-batch-result',
      requestId: msg.requestId,
      results,
      failures
    } satisfies WorkerToMainMessage)
  } finally {
    secureCleanup(msg.vaultKey)
  }
}
