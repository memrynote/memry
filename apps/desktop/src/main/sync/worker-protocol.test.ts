import type { PushItem } from '@memry/contracts/sync-api'
import { describe, expect, it } from 'vitest'
import type {
  DecryptedPullItem,
  DecryptionFailure,
  EncryptedPushResult,
  MainToWorkerMessage,
  PullItemForDecrypt,
  RawPushItem,
  WorkerToMainMessage
} from './worker-protocol'
import { isCryptoErrorMessage } from './worker-protocol'

/**
 * `worker_threads.postMessage` uses the structured clone algorithm, which is
 * exactly what `structuredClone` implements — so cloning here reproduces what
 * a message actually looks like on the far side of the thread boundary.
 */
const overWire = <T>(msg: T): T => structuredClone(msg)

const pushItem: PushItem = {
  id: 'item-1',
  type: 'note',
  operation: 'update',
  encryptedKey: 'ek',
  keyNonce: 'kn',
  encryptedData: 'ed',
  dataNonce: 'dn',
  signature: 'sig',
  signerDeviceId: 'device-a',
  clock: { 'device-a': 4 },
  stateVector: 'sv'
}

const rawPushItem: RawPushItem = {
  queueId: 'q-1',
  itemId: 'item-1',
  type: 'note',
  operation: 'update',
  payload: '{"title":"hello"}',
  clock: { 'device-a': 4, 'device-b': 1 },
  stateVector: 'AQID',
  deletedAt: 1_760_000_000_000
}

const pullItem: PullItemForDecrypt = {
  id: 'item-1',
  type: 'note',
  operation: 'update',
  cryptoVersion: 1,
  encryptedKey: 'ek',
  keyNonce: 'kn',
  encryptedData: 'ed',
  dataNonce: 'dn',
  signature: 'sig',
  signerDeviceId: 'device-a',
  clock: { 'device-a': 4 },
  stateVector: 'AQID',
  deletedAt: 1_760_000_000_000
}

describe('worker message contract', () => {
  describe('key material across the thread boundary', () => {
    it('hands the worker a Uint8Array copy, not a view onto the caller’s key', () => {
      // Load-bearing: worker.ts wipes msg.vaultKey / msg.signingSecretKey with
      // secureCleanup() in a `finally`. Structured clone copies rather than
      // transfers, so that zeroing must not reach back into the main process's
      // vault key — if it ever did, every subsequent push/pull in that session
      // would encrypt with a zeroed key.
      const vaultKey = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
      const signingSecretKey = new Uint8Array([9, 8, 7, 6])

      const msg: MainToWorkerMessage = {
        type: 'encrypt-batch',
        requestId: 'req-1',
        items: [rawPushItem],
        vaultKey,
        signingSecretKey,
        signerDeviceId: 'device-a'
      }

      const received = overWire(msg)
      if (received.type !== 'encrypt-batch') throw new Error('unreachable')

      expect(received.vaultKey).toBeInstanceOf(Uint8Array)
      expect(Array.from(received.vaultKey)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      expect(received.vaultKey).not.toBe(vaultKey)
      expect(received.vaultKey.buffer).not.toBe(vaultKey.buffer)

      received.vaultKey.fill(0)
      received.signingSecretKey.fill(0)

      expect(Array.from(vaultKey)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      expect(Array.from(signingSecretKey)).toEqual([9, 8, 7, 6])
    })
  })

  describe('round-trips', () => {
    it('preserves an encrypt-batch request, clocks and optional fields included', () => {
      const msg: MainToWorkerMessage = {
        type: 'encrypt-batch',
        requestId: 'req-1',
        items: [rawPushItem, { ...rawPushItem, queueId: 'q-2', clock: undefined }],
        vaultKey: new Uint8Array(32),
        signingSecretKey: new Uint8Array(64),
        signerDeviceId: 'device-a'
      }

      const received = overWire(msg)
      if (received.type !== 'encrypt-batch') throw new Error('unreachable')

      expect(received.items[0]).toEqual(rawPushItem)
      // A VectorClock is a plain Record<string, number>; nothing in it needs a
      // custom serializer, and an absent clock must not become `{}` (the push
      // path treats a clock as "this item is clock-tracked").
      expect(received.items[0].clock).toEqual({ 'device-a': 4, 'device-b': 1 })
      expect(received.items[1].clock).toBeUndefined()
      expect(received.items[0].deletedAt).toBe(1_760_000_000_000)
    })

    it('preserves a decrypt-batch request including the signer key map', () => {
      const msg: MainToWorkerMessage = {
        type: 'decrypt-batch',
        requestId: 'req-2',
        items: [pullItem, { ...pullItem, id: 'item-2', clock: undefined, deletedAt: undefined }],
        vaultKey: new Uint8Array([7, 7, 7]),
        signerKeys: { 'device-a': 'base64-public-key', 'device-b': 'other-key' }
      }

      const received = overWire(msg)
      if (received.type !== 'decrypt-batch') throw new Error('unreachable')

      expect(received.items[0]).toEqual(pullItem)
      expect(received.signerKeys).toEqual({
        'device-a': 'base64-public-key',
        'device-b': 'other-key'
      })
      expect(received.items[1].clock).toBeUndefined()
    })

    it('preserves both batch results and the error reply', () => {
      const encryptResult: EncryptedPushResult = { queueId: 'q-1', pushItem, sizeBytes: 412 }
      const decrypted: DecryptedPullItem = {
        id: 'item-1',
        type: 'note',
        operation: 'update',
        content: '{"title":"hello"}',
        clock: { 'device-a': 4 },
        deletedAt: undefined,
        signerDeviceId: 'device-a'
      }
      const failure: DecryptionFailure = {
        id: 'item-2',
        type: 'note',
        signerDeviceId: 'device-b',
        error: 'incorrect signature',
        isCryptoError: true,
        isSignatureError: true
      }

      const replies: WorkerToMainMessage[] = [
        {
          type: 'encrypt-batch-result',
          requestId: 'req-1',
          results: [encryptResult],
          errors: [{ queueId: 'q-3', itemId: 'item-3', error: 'boom' }]
        },
        {
          type: 'decrypt-batch-result',
          requestId: 'req-2',
          results: [decrypted],
          failures: [failure]
        },
        { type: 'error', requestId: 'req-2', error: 'worker blew up' },
        { type: 'ready' },
        { type: 'shutdown-ack' }
      ]

      for (const reply of replies) {
        expect(overWire(reply)).toEqual(reply)
      }
      expect(overWire<MainToWorkerMessage>({ type: 'shutdown' })).toEqual({ type: 'shutdown' })
    })
  })

  describe('mixed-version safety', () => {
    // A packaged app can end up with a main bundle and a worker bundle from
    // different builds (partial update, stale asar). Neither side may crash on
    // a kind it does not know.
    const KNOWN_MAIN_TO_WORKER = ['encrypt-batch', 'decrypt-batch', 'shutdown']
    const KNOWN_WORKER_TO_MAIN = [
      'encrypt-batch-result',
      'decrypt-batch-result',
      'error',
      'ready',
      'shutdown-ack'
    ]

    it('carries an unknown kind across intact, requestId included, so it can be answered', () => {
      const fromNewerBuild = { type: 'compact-batch', requestId: 'req-9', docIds: ['a', 'b'] }

      const received = overWire(fromNewerBuild)

      expect(received.type).toBe('compact-batch')
      expect(KNOWN_MAIN_TO_WORKER).not.toContain(received.type)
      // The requestId survives, which is what lets a receiver reply with a
      // typed `error` instead of leaving the sender's promise dangling.
      expect(received.requestId).toBe('req-9')
    })

    it('lets the worker answer an unknown kind with a reply the bridge can route', () => {
      // worker.ts's `default:` branch builds exactly this from the unknown
      // request. worker-bridge.ts routes replies with `'requestId' in msg` and
      // then rejects on `type === 'error'`, so this shape settles the caller's
      // promise immediately instead of leaving it to the 60s REQUEST_TIMEOUT_MS.
      const fromNewerBuild = overWire({ type: 'compact-batch', requestId: 'req-9' })

      const reply: WorkerToMainMessage = {
        type: 'error',
        requestId: fromNewerBuild.requestId,
        error: `Unsupported worker message kind: ${fromNewerBuild.type}`
      }

      const received = overWire(reply)

      expect(received).toEqual(reply)
      expect('requestId' in received).toBe(true)
      if (received.type !== 'error') throw new Error('unreachable')
      expect(received.requestId).toBe('req-9')
      expect(received.error).toContain('compact-batch')
    })

    it('has no reply to route when an unknown kind carries no requestId', () => {
      // `shutdown` is the only known kind without one. An unknown kind that also
      // lacks it has no pending promise, and a reply with `requestId:
      // undefined` would pass worker-bridge's `'requestId' in msg` check and be
      // looked up under the key `undefined` — so worker.ts stays silent.
      const fromNewerBuild = overWire({ type: 'flush-cache' }) as { requestId?: unknown }

      expect(typeof fromNewerBuild.requestId).not.toBe('string')
    })

    it('keeps the two kind namespaces disjoint so a reply is never mistaken for a request', () => {
      for (const kind of KNOWN_WORKER_TO_MAIN) {
        expect(KNOWN_MAIN_TO_WORKER).not.toContain(kind)
      }
    })

    it('lets a receiver discriminate on `type` without touching unknown payloads', () => {
      const fromNewerBuild = overWire({
        type: 'encrypt-batch-result',
        requestId: 'req-9',
        results: [],
        errors: [],
        // Field a future build added; this build must ignore it, not choke.
        compressionCodec: 'zstd'
      }) as WorkerToMainMessage & { compressionCodec?: string }

      expect(KNOWN_WORKER_TO_MAIN).toContain(fromNewerBuild.type)
      expect(fromNewerBuild.compressionCodec).toBe('zstd')
    })
  })
})

describe('isCryptoErrorMessage', () => {
  // Drives DecryptionFailure.isCryptoError, which the pull coordinator uses to
  // decide whether to re-fetch an item from the server and to emit ITEM_CORRUPT
  // to the user. False positives cause pointless refetch storms; false
  // negatives leave a genuinely corrupt item unrecovered on this device.

  it('classifies the sodium/decrypt failures it was written for', () => {
    for (const message of [
      'incorrect signature for the given public key',
      'unable to decrypt the ciphertext',
      'sodium is not ready',
      'invalid nonce length',
      'invalid input: not base64'
    ]) {
      expect(isCryptoErrorMessage(message)).toBe(true)
    }
  })

  it('matches regardless of case', () => {
    expect(isCryptoErrorMessage('Signature Verification Failed')).toBe(true)
    expect(isCryptoErrorMessage('DECRYPT FAILED')).toBe(true)
    expect(isCryptoErrorMessage('Invalid Base64 Encoding')).toBe(true)
  })

  it('does not classify transport, disk or server failures as crypto failures', () => {
    // These are retried by other machinery; marking them crypto would refetch
    // the blob and tell the user their item is corrupt.
    for (const message of [
      'fetch failed',
      'read ECONNRESET',
      'ENOSPC: no space left on device',
      'HTTP 500 from sync server',
      'Worker exited with code 1',
      ''
    ]) {
      expect(isCryptoErrorMessage(message)).toBe(false)
    }
  })

  it('does not classify a newer crypto version as a corrupt payload', () => {
    // decrypt.ts throws this for an item written by a newer app version. It is
    // not corruption and refetching it would change nothing — the user needs an
    // update, so this must stay out of the crypto/refetch path.
    expect(isCryptoErrorMessage('Crypto version 3 is not supported. Please update the app.')).toBe(
      false
    )
    expect(isCryptoErrorMessage('Invalid crypto version: 0. Version must be >= 1.')).toBe(false)
  })
})
