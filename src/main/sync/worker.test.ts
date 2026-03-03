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
})
