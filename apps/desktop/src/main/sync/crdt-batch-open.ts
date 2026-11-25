import sodium from 'libsodium-wrappers-sumo'
import { decryptCrdtUpdate } from './crdt-encrypt'
import { SignatureVerificationError } from './decrypt'
import { base64ToBytes } from '@memry/sync-client/worker-protocol'
import type { CrdtDecryptFailure, MainToWorkerMessage } from '@memry/sync-client/worker-protocol'

/**
 * Open a page of CRDT snapshot/update payloads: the body of the worker's
 * `decrypt-crdt-batch` handler, kept free of `worker_threads` so tests can run
 * the real walk. Runs the same `decryptCrdtUpdate` as the main-thread fallback,
 * so a verdict cannot differ by thread. Exactly one of `data` / `dataB64` is
 * set per item; the base64 decode of server payloads happens here.
 */
export function openCrdtBatch(
  msg: Pick<
    Extract<MainToWorkerMessage, { type: 'decrypt-crdt-batch' }>,
    'items' | 'vaultKey' | 'signerKeys' | 'stopAtFirstOpen'
  >
): { results: Array<{ index: number; update: Uint8Array }>; failures: CrdtDecryptFailure[] } {
  const results: Array<{ index: number; update: Uint8Array }> = []
  const failures: CrdtDecryptFailure[] = []

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

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- item.data and item.dataB64 are alternatives; one is always present for a well-formed item
    const packed = item.data ?? base64ToBytes(item.dataB64 as string)
    // oxlint-disable-next-line import/no-named-as-default-member -- default import required: tests vi.mock libsodium-wrappers-sumo with only a default export
    const signerPublicKey = sodium.from_base64(signerKeyB64, sodium.base64_variants.ORIGINAL)

    try {
      const update = decryptCrdtUpdate(packed, msg.vaultKey, item.noteId, signerPublicKey)
      results.push({ index: item.index, update })
      if (msg.stopAtFirstOpen) break
    } catch (err) {
      failures.push({
        index: item.index,
        noteId: item.noteId,
        error: err instanceof Error ? err.message : String(err),
        isSignatureError: err instanceof SignatureVerificationError
      })
    }
  }

  return { results, failures }
}
