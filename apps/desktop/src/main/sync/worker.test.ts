import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import type { MainToWorkerMessage, WorkerToMainMessage } from './worker-protocol'

const mockPort = Object.assign(new EventEmitter(), {
  postMessage: vi.fn()
})

vi.mock('worker_threads', () => ({
  parentPort: mockPort
}))

vi.mock('libsodium-wrappers-sumo', () => ({
  default: {
    ready: Promise.resolve(),
    from_base64: vi.fn().mockReturnValue(new Uint8Array(32)),
    base64_variants: { ORIGINAL: 0 }
  }
}))

const mockEncryptResult = {
  pushItem: {
    id: 'item1',
    type: 'note',
    operation: 'update',
    encryptedKey: 'ek',
    keyNonce: 'kn',
    encryptedData: 'ed',
    dataNonce: 'dn',
    signature: 'sig',
    signerDeviceId: 'device-1'
  },
  sizeBytes: 200
}

const mockEncryptFn = vi.fn().mockReturnValue(mockEncryptResult)
vi.mock('./encrypt', () => ({
  encryptItemForPush: (...args: unknown[]) => mockEncryptFn(...args)
}))

const mockDecryptFn = vi.fn().mockReturnValue({
  ok: true,
  item: {
    id: 'item1',
    type: 'note',
    operation: 'update',
    content: '{"title":"test"}',
    signerDeviceId: 'device-1'
  }
})
vi.mock('./decrypt-item', () => ({
  decryptSingleItem: (...args: unknown[]) => mockDecryptFn(...args)
}))

const mockCleanup = vi.fn()
vi.mock('../crypto/primitives', () => ({
  secureCleanup: (...args: unknown[]) => mockCleanup(...args)
}))

function captureNextPostMessage(): Promise<WorkerToMainMessage> {
  const baseline = mockPort.postMessage.mock.calls.length
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('No postMessage within 1s')), 1000)
    const interval = setInterval(() => {
      if (mockPort.postMessage.mock.calls.length > baseline) {
        clearTimeout(timeout)
        clearInterval(interval)
        resolve(mockPort.postMessage.mock.calls[mockPort.postMessage.mock.calls.length - 1][0])
      }
    }, 5)
  })
}

describe('worker', () => {
  beforeAll(async () => {
    await import('./worker')

    await vi.waitFor(() => {
      expect(
        mockPort.postMessage.mock.calls.some(([msg]: [WorkerToMainMessage]) => msg.type === 'ready')
      ).toBe(true)
    })
  })

  beforeEach(() => {
    mockPort.postMessage.mockClear()
    mockEncryptFn.mockClear().mockReturnValue(mockEncryptResult)
    mockDecryptFn.mockClear().mockReturnValue({
      ok: true,
      item: {
        id: 'item1',
        type: 'note',
        operation: 'update',
        content: '{"title":"test"}',
        signerDeviceId: 'device-1'
      }
    })
    mockCleanup.mockClear()
  })

  describe('#given worker ready #when encrypt-batch message received', () => {
    it('#then posts encrypt-batch-result with encrypted items', async () => {
      // #given
      const msg: MainToWorkerMessage = {
        type: 'encrypt-batch',
        requestId: 'req_enc_1',
        items: [
          {
            queueId: 'q1',
            itemId: 'item1',
            type: 'note',
            operation: 'update',
            payload: '{"title":"test"}'
          }
        ],
        vaultKey: new Uint8Array(32),
        signingSecretKey: new Uint8Array(64),
        signerDeviceId: 'device-1'
      }

      // #when
      const resultPromise = captureNextPostMessage()
      mockPort.emit('message', msg)
      const result = await resultPromise

      // #then
      expect(result.type).toBe('encrypt-batch-result')
      if (result.type === 'encrypt-batch-result') {
        expect(result.requestId).toBe('req_enc_1')
        expect(result.results).toHaveLength(1)
        expect(result.results[0].queueId).toBe('q1')
        expect(result.errors).toHaveLength(0)
      }
    })

    it('#then reports per-item errors without crashing batch', async () => {
      // #given
      mockEncryptFn.mockImplementationOnce(() => {
        throw new Error('sodium encrypt failed')
      })

      const msg: MainToWorkerMessage = {
        type: 'encrypt-batch',
        requestId: 'req_enc_2',
        items: [
          {
            queueId: 'q1',
            itemId: 'item1',
            type: 'note',
            operation: 'update',
            payload: '{"title":"bad"}'
          }
        ],
        vaultKey: new Uint8Array(32),
        signingSecretKey: new Uint8Array(64),
        signerDeviceId: 'device-1'
      }

      // #when
      const resultPromise = captureNextPostMessage()
      mockPort.emit('message', msg)
      const result = await resultPromise

      // #then
      expect(result.type).toBe('encrypt-batch-result')
      if (result.type === 'encrypt-batch-result') {
        expect(result.results).toHaveLength(0)
        expect(result.errors).toHaveLength(1)
        expect(result.errors[0].error).toBe('sodium encrypt failed')
      }
    })

    it('#then calls secureCleanup on vaultKey and signingSecretKey', async () => {
      // #given
      const vaultKey = new Uint8Array(32)
      const signingSecretKey = new Uint8Array(64)

      const msg: MainToWorkerMessage = {
        type: 'encrypt-batch',
        requestId: 'req_enc_3',
        items: [],
        vaultKey,
        signingSecretKey,
        signerDeviceId: 'device-1'
      }

      // #when
      const resultPromise = captureNextPostMessage()
      mockPort.emit('message', msg)
      await resultPromise

      // #then
      expect(mockCleanup).toHaveBeenCalledWith(vaultKey, signingSecretKey)
    })
  })

  describe('#given worker ready #when decrypt-batch message received', () => {
    it('#then posts decrypt-batch-result with decrypted items', async () => {
      // #given
      const msg: MainToWorkerMessage = {
        type: 'decrypt-batch',
        requestId: 'req_dec_1',
        items: [
          {
            id: 'item1',
            type: 'note',
            operation: 'update',
            encryptedKey: 'ek',
            keyNonce: 'kn',
            encryptedData: 'ed',
            dataNonce: 'dn',
            signature: 'sig',
            signerDeviceId: 'device-1',
            cryptoVersion: 1
          }
        ],
        vaultKey: new Uint8Array(32),
        signerKeys: { 'device-1': 'cHVia2V5' }
      }

      // #when
      const resultPromise = captureNextPostMessage()
      mockPort.emit('message', msg)
      const result = await resultPromise

      // #then
      expect(result.type).toBe('decrypt-batch-result')
      if (result.type === 'decrypt-batch-result') {
        expect(result.requestId).toBe('req_dec_1')
        expect(result.results).toHaveLength(1)
        expect(result.failures).toHaveLength(0)
      }
    })

    it('#then records failure when signer key is missing', async () => {
      // #given
      const msg: MainToWorkerMessage = {
        type: 'decrypt-batch',
        requestId: 'req_dec_2',
        items: [
          {
            id: 'item1',
            type: 'note',
            operation: 'update',
            encryptedKey: 'ek',
            keyNonce: 'kn',
            encryptedData: 'ed',
            dataNonce: 'dn',
            signature: 'sig',
            signerDeviceId: 'unknown-device',
            cryptoVersion: 1
          }
        ],
        vaultKey: new Uint8Array(32),
        signerKeys: {}
      }

      // #when
      const resultPromise = captureNextPostMessage()
      mockPort.emit('message', msg)
      const result = await resultPromise

      // #then
      expect(result.type).toBe('decrypt-batch-result')
      if (result.type === 'decrypt-batch-result') {
        expect(result.results).toHaveLength(0)
        expect(result.failures).toHaveLength(1)
        expect(result.failures[0].isCryptoError).toBe(false)
        expect(result.failures[0].error).toContain('No public key')
      }
    })

    it('#then records crypto failure from decryptSingleItem', async () => {
      // #given
      mockDecryptFn.mockReturnValueOnce({
        ok: false,
        failure: {
          id: 'item1',
          type: 'note',
          signerDeviceId: 'device-1',
          error: 'could not decrypt',
          isCryptoError: true,
          isSignatureError: false
        }
      })

      const msg: MainToWorkerMessage = {
        type: 'decrypt-batch',
        requestId: 'req_dec_3',
        items: [
          {
            id: 'item1',
            type: 'note',
            operation: 'update',
            encryptedKey: 'ek',
            keyNonce: 'kn',
            encryptedData: 'ed',
            dataNonce: 'dn',
            signature: 'sig',
            signerDeviceId: 'device-1',
            cryptoVersion: 1
          }
        ],
        vaultKey: new Uint8Array(32),
        signerKeys: { 'device-1': 'cHVia2V5' }
      }

      // #when
      const resultPromise = captureNextPostMessage()
      mockPort.emit('message', msg)
      const result = await resultPromise

      // #then
      expect(result.type).toBe('decrypt-batch-result')
      if (result.type === 'decrypt-batch-result') {
        expect(result.results).toHaveLength(0)
        expect(result.failures).toHaveLength(1)
        expect(result.failures[0].isCryptoError).toBe(true)
      }
    })

    it('#then calls secureCleanup on vaultKey', async () => {
      // #given
      const vaultKey = new Uint8Array(32)

      const msg: MainToWorkerMessage = {
        type: 'decrypt-batch',
        requestId: 'req_dec_4',
        items: [],
        vaultKey,
        signerKeys: {}
      }

      // #when
      const resultPromise = captureNextPostMessage()
      mockPort.emit('message', msg)
      await resultPromise

      // #then
      expect(mockCleanup).toHaveBeenCalledWith(vaultKey)
    })
  })

  // A packaged install can end up with a main bundle and a worker bundle from
  // different builds (partial update, stale asar), which is the only way an
  // unknown kind reaches this switch. Both halves matter and fail in opposite
  // directions, so both are pinned.
  describe('#given worker ready #when an unknown message kind is received', () => {
    const emitUnknown = (msg: unknown): void => {
      mockPort.emit('message', msg as MainToWorkerMessage)
    }

    it('#then replies with a typed error for a request-shaped message', async () => {
      // #given a kind this build does not implement, carrying a requestId — so
      // the parent has a pending promise waiting on it.
      const resultPromise = captureNextPostMessage()

      // #when
      emitUnknown({ type: 'compact-batch', requestId: 'req-9' })
      const result = await resultPromise

      // #then the bridge can reject immediately instead of stalling until its
      // 60s REQUEST_TIMEOUT_MS fires, which is what a silent drop used to cost
      // every crypto batch.
      expect(result).toEqual({
        type: 'error',
        requestId: 'req-9',
        error: 'Unsupported worker message kind: compact-batch'
      })
    })

    it('#then stays silent when the message carries no requestId', async () => {
      // #given no requestId, so there is no pending promise to settle.
      // #when
      emitUnknown({ type: 'flush-cache' })
      await new Promise((resolve) => setTimeout(resolve, 20))

      // #then replying `requestId: undefined` would put an off-protocol message
      // on the wire that worker-bridge's `'requestId' in msg` check accepts and
      // then looks up under the key `undefined`. Silence is the contract.
      expect(mockPort.postMessage).not.toHaveBeenCalled()
    })

    it('#then does not throw when `type` is not a string', async () => {
      // #given a bundle mismatch can deliver anything, including a message with
      // no usable discriminant. String(undefined) keeps the log line readable
      // rather than crashing the worker on a property access.
      const resultPromise = captureNextPostMessage()

      // #when
      emitUnknown({ requestId: 'req-10' })
      const result = await resultPromise

      // #then
      expect(result).toEqual({
        type: 'error',
        requestId: 'req-10',
        error: 'Unsupported worker message kind: undefined'
      })
    })
  })
})
