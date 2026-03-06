import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import type { WorkerToMainMessage } from './worker-protocol'

class MockWorker extends EventEmitter {
  postMessage = vi.fn()
  terminate = vi.fn().mockResolvedValue(undefined)

  simulateMessage(msg: WorkerToMainMessage): void {
    this.emit('message', msg)
  }

  simulateError(err: Error): void {
    this.emit('error', err)
  }

  simulateExit(code: number): void {
    this.emit('exit', code)
  }
}

let mockWorkerInstance: MockWorker

vi.mock('worker_threads', () => {
  return {
    Worker: class {
      constructor() {
        mockWorkerInstance = new MockWorker()
        return mockWorkerInstance
      }
    }
  }
})

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { SyncWorkerBridge } from './worker-bridge'

describe('SyncWorkerBridge', () => {
  let bridge: SyncWorkerBridge

  beforeEach(() => {
    vi.useFakeTimers()
    bridge = new SyncWorkerBridge()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('#given new bridge #when start() called', () => {
    it('#then resolves after worker sends ready', async () => {
      // #given
      const startPromise = bridge.start()
      // #when
      mockWorkerInstance.simulateMessage({ type: 'ready' })
      // #then
      await expect(startPromise).resolves.toBeUndefined()
      expect(bridge.isRunning).toBe(true)
    })

    it('#then rejects if worker errors during init', async () => {
      // #given
      const startPromise = bridge.start()
      // #when
      mockWorkerInstance.simulateError(new Error('init boom'))
      // #then
      await expect(startPromise).rejects.toThrow('init boom')
    })

    it('#then rejects if worker does not send ready within timeout', async () => {
      // #given
      const startPromise = bridge.start()
      // #when
      vi.advanceTimersByTime(10_001)
      // #then
      await expect(startPromise).rejects.toThrow('Worker failed to start within timeout')
    })

    it('#then removes init error listener after ready', async () => {
      // #given
      const startPromise = bridge.start()
      const listenerCountBefore = mockWorkerInstance.listenerCount('error')
      // #when
      mockWorkerInstance.simulateMessage({ type: 'ready' })
      await startPromise
      // #then — setupMessageHandler adds 1 error listener; init listener removed
      const listenerCountAfter = mockWorkerInstance.listenerCount('error')
      expect(listenerCountAfter).toBe(listenerCountBefore)
    })

    it('#then no-ops if already started', async () => {
      // #given
      const p = bridge.start()
      mockWorkerInstance.simulateMessage({ type: 'ready' })
      await p
      // #when
      await bridge.start()
      // #then — no error, still running
      expect(bridge.isRunning).toBe(true)
    })
  })

  describe('#given running bridge #when stop() called', () => {
    it('#then sends shutdown and resolves after worker exits', async () => {
      // #given
      const p = bridge.start()
      mockWorkerInstance.simulateMessage({ type: 'ready' })
      await p

      // #when
      const stopPromise = bridge.stop()
      mockWorkerInstance.simulateExit(0)
      await stopPromise

      // #then
      expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith({ type: 'shutdown' })
      expect(bridge.isRunning).toBe(false)
    })

    it('#then terminates worker if exit does not come within 3s', async () => {
      // #given
      const p = bridge.start()
      mockWorkerInstance.simulateMessage({ type: 'ready' })
      await p

      // #when
      const stopPromise = bridge.stop()
      vi.advanceTimersByTime(3_001)
      await stopPromise

      // #then
      expect(mockWorkerInstance.terminate).toHaveBeenCalled()
      expect(bridge.isRunning).toBe(false)
    })

    it('#then no-ops if not running', async () => {
      // #given bridge never started
      // #when / #then
      await expect(bridge.stop()).resolves.toBeUndefined()
    })

    it('#then lets in-flight request resolve before rejecting stragglers', async () => {
      // #given
      const p = bridge.start()
      mockWorkerInstance.simulateMessage({ type: 'ready' })
      await p

      const encryptPromise = bridge.encryptBatch(
        [
          {
            queueId: 'q1',
            itemId: 'item1',
            type: 'note',
            operation: 'update',
            payload: '{"title":"draining"}'
          }
        ],
        new Uint8Array(32),
        new Uint8Array(64),
        'device-1'
      )

      const postedMsg = mockWorkerInstance.postMessage.mock.calls.find(
        ([m]) => m.type === 'encrypt-batch'
      )![0]

      // #when — stop is called, but worker sends result before exiting
      const stopPromise = bridge.stop()

      mockWorkerInstance.simulateMessage({
        type: 'encrypt-batch-result',
        requestId: postedMsg.requestId,
        results: [{ queueId: 'q1', pushItem: { id: 'item1' } as never, sizeBytes: 50 }],
        errors: []
      })

      mockWorkerInstance.simulateExit(0)
      await stopPromise

      // #then — in-flight request resolved successfully
      const result = await encryptPromise
      expect(result.results).toHaveLength(1)
      expect(result.results[0].queueId).toBe('q1')
    })
  })

  describe('#given running bridge #when encryptBatch called', () => {
    it('#then sends message and returns result', async () => {
      // #given
      const p = bridge.start()
      mockWorkerInstance.simulateMessage({ type: 'ready' })
      await p

      const encryptPromise = bridge.encryptBatch(
        [
          {
            queueId: 'q1',
            itemId: 'item1',
            type: 'note',
            operation: 'update',
            payload: '{"title":"test"}'
          }
        ],
        new Uint8Array(32),
        new Uint8Array(64),
        'device-1'
      )

      // #when — extract the requestId from the posted message
      const postedMsg = mockWorkerInstance.postMessage.mock.calls.find(
        ([m]) => m.type === 'encrypt-batch'
      )![0]

      mockWorkerInstance.simulateMessage({
        type: 'encrypt-batch-result',
        requestId: postedMsg.requestId,
        results: [{ queueId: 'q1', pushItem: { id: 'item1' } as never, sizeBytes: 100 }],
        errors: []
      })

      // #then
      const result = await encryptPromise
      expect(result.results).toHaveLength(1)
      expect(result.errors).toHaveLength(0)
    })

    it('#then rejects on error response', async () => {
      // #given
      const p = bridge.start()
      mockWorkerInstance.simulateMessage({ type: 'ready' })
      await p

      const encryptPromise = bridge.encryptBatch(
        [],
        new Uint8Array(32),
        new Uint8Array(64),
        'device-1'
      )

      const postedMsg = mockWorkerInstance.postMessage.mock.calls.find(
        ([m]) => m.type === 'encrypt-batch'
      )![0]

      // #when
      mockWorkerInstance.simulateMessage({
        type: 'error',
        requestId: postedMsg.requestId,
        error: 'batch failed'
      })

      // #then
      await expect(encryptPromise).rejects.toThrow('batch failed')
    })
  })

  describe('#given running bridge #when decryptBatch called', () => {
    it('#then sends message and returns result', async () => {
      // #given
      const p = bridge.start()
      mockWorkerInstance.simulateMessage({ type: 'ready' })
      await p

      const decryptPromise = bridge.decryptBatch(
        [
          {
            id: 'item1',
            type: 'note',
            operation: 'update',
            encryptedKey: 'ek',
            keyNonce: 'kn',
            encryptedData: 'ed',
            dataNonce: 'dn',
            signature: 'sig',
            signerDeviceId: 'device-1'
          }
        ],
        new Uint8Array(32),
        { 'device-1': 'pubkey-base64' }
      )

      const postedMsg = mockWorkerInstance.postMessage.mock.calls.find(
        ([m]) => m.type === 'decrypt-batch'
      )![0]

      // #when
      mockWorkerInstance.simulateMessage({
        type: 'decrypt-batch-result',
        requestId: postedMsg.requestId,
        results: [
          {
            id: 'item1',
            type: 'note',
            operation: 'update',
            content: '{"title":"test"}',
            signerDeviceId: 'device-1'
          }
        ],
        failures: []
      })

      // #then
      const result = await decryptPromise
      expect(result.results).toHaveLength(1)
      expect(result.failures).toHaveLength(0)
    })
  })

  describe('#given running bridge #when request times out', () => {
    it('#then rejects with timeout error after 60s', async () => {
      // #given
      const p = bridge.start()
      mockWorkerInstance.simulateMessage({ type: 'ready' })
      await p

      // #when
      const encryptPromise = bridge.encryptBatch(
        [],
        new Uint8Array(32),
        new Uint8Array(64),
        'device-1'
      )

      vi.advanceTimersByTime(60_001)

      // #then
      await expect(encryptPromise).rejects.toThrow('Worker request timed out')
    })
  })

  describe('#given running bridge #when worker exits unexpectedly', () => {
    it('#then rejects all pending requests', async () => {
      // #given
      const p = bridge.start()
      mockWorkerInstance.simulateMessage({ type: 'ready' })
      await p

      const encryptPromise = bridge.encryptBatch(
        [],
        new Uint8Array(32),
        new Uint8Array(64),
        'device-1'
      )

      // #when
      mockWorkerInstance.simulateExit(1)

      // #then
      await expect(encryptPromise).rejects.toThrow('Worker exited with code 1')
      expect(bridge.isRunning).toBe(false)
    })
  })

  describe('#given stopped bridge #when encryptBatch called', () => {
    it('#then rejects with worker not started error', async () => {
      // #given — bridge never started
      // #when / #then
      await expect(
        bridge.encryptBatch([], new Uint8Array(32), new Uint8Array(64), 'device-1')
      ).rejects.toThrow('Worker not started')
    })
  })

  describe('#given running bridge #when worker runtime error occurs', () => {
    it('#then rejects pending requests with the error', async () => {
      // #given
      const p = bridge.start()
      mockWorkerInstance.simulateMessage({ type: 'ready' })
      await p

      const encryptPromise = bridge.encryptBatch(
        [],
        new Uint8Array(32),
        new Uint8Array(64),
        'device-1'
      )

      // #when
      mockWorkerInstance.simulateError(new Error('OOM'))

      // #then
      await expect(encryptPromise).rejects.toThrow('OOM')
    })
  })
})
