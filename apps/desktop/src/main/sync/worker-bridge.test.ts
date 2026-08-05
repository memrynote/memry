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

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => logger
}))

import { MAX_CONSECUTIVE_FAILURES, SyncWorkerBridge } from './worker-bridge'

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

    it('#then cleans up the worker after an init error so isRunning is false', async () => {
      // #given
      const startPromise = bridge.start()
      // #when
      mockWorkerInstance.simulateError(new Error('init boom'))
      // #then — a worker that never came up must not report as running,
      // otherwise sync-crypto-batch routes requests to a dead worker
      await expect(startPromise).rejects.toThrow('init boom')
      expect(bridge.isRunning).toBe(false)
      expect(mockWorkerInstance.terminate).toHaveBeenCalled()
    })

    it('#then cleans up the worker after an init timeout so isRunning is false', async () => {
      // #given
      const startPromise = bridge.start()
      // #when
      vi.advanceTimersByTime(10_001)
      // #then
      await expect(startPromise).rejects.toThrow('Worker failed to start within timeout')
      expect(bridge.isRunning).toBe(false)
      expect(mockWorkerInstance.terminate).toHaveBeenCalled()
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

  describe('#given running bridge #when a reply matches no pending request', () => {
    it('#then logs the dropped reply instead of vanishing', async () => {
      // #given
      const p = bridge.start()
      mockWorkerInstance.simulateMessage({ type: 'ready' })
      await p
      logger.warn.mockClear()

      // #when — a reply for a request this bridge never issued (or one that
      // already timed out)
      mockWorkerInstance.simulateMessage({
        type: 'error',
        requestId: 'req_stale_1',
        error: 'boom'
      })

      // #then
      expect(logger.warn).toHaveBeenCalledWith('Dropped worker reply with no pending request', {
        type: 'error',
        requestId: 'req_stale_1'
      })
    })

    it('#then logs an off-protocol message that carries no requestId', async () => {
      // #given
      const p = bridge.start()
      mockWorkerInstance.simulateMessage({ type: 'ready' })
      await p
      logger.warn.mockClear()

      // #when
      mockWorkerInstance.simulateMessage({ type: 'nonsense' } as never)

      // #then
      expect(logger.warn).toHaveBeenCalledWith('Dropped off-protocol worker message', {
        type: 'nonsense'
      })
    })

    it('#then stays quiet for shutdown-ack, which legitimately has no requestId', async () => {
      // #given
      const p = bridge.start()
      mockWorkerInstance.simulateMessage({ type: 'ready' })
      await p
      logger.warn.mockClear()

      // #when
      mockWorkerInstance.simulateMessage({ type: 'shutdown-ack' })

      // #then — a clean stop() must not warn on every shutdown
      expect(logger.warn).not.toHaveBeenCalled()
    })
  })

  describe('#given running bridge #when requests keep failing', () => {
    const startReady = async (): Promise<void> => {
      const p = bridge.start()
      mockWorkerInstance.simulateMessage({ type: 'ready' })
      await p
    }

    const encryptBatchRequests = (): unknown[] =>
      mockWorkerInstance.postMessage.mock.calls.filter(([m]) => m.type === 'encrypt-batch')

    /** One batch against a worker that is alive but never answers. */
    const silentBatch = async (): Promise<void> => {
      const request = bridge.encryptBatch([], new Uint8Array(32), new Uint8Array(64), 'device-1')
      vi.advanceTimersByTime(60_001)
      await expect(request).rejects.toThrow('Worker request timed out')
    }

    const answeredBatch = async (): Promise<void> => {
      const request = bridge.encryptBatch([], new Uint8Array(32), new Uint8Array(64), 'device-1')
      const posted = encryptBatchRequests().at(-1)![0]
      mockWorkerInstance.simulateMessage({
        type: 'encrypt-batch-result',
        requestId: posted.requestId,
        results: [],
        errors: []
      })
      await request
    }

    it('#then still routes to the worker below the latch threshold', async () => {
      // #given
      await startReady()

      // #when — one short of the threshold; a lone hiccup must not cost the
      // session its worker
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 1; i++) await silentBatch()

      // #then
      expect(bridge.isRunning).toBe(true)
      expect(encryptBatchRequests()).toHaveLength(MAX_CONSECUTIVE_FAILURES - 1)
    })

    it('#then latches off at the threshold so no further round trip is paid', async () => {
      // #given
      await startReady()

      // #when
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) await silentBatch()

      // #then — sync-crypto-batch gates on isRunning (its only two call sites),
      // so a false here is exactly "main-thread crypto, no worker request". The
      // timeout penalty is now bounded at MAX_CONSECUTIVE_FAILURES for the whole
      // session instead of one per batch.
      expect(bridge.isRunning).toBe(false)
      expect(encryptBatchRequests()).toHaveLength(MAX_CONSECUTIVE_FAILURES)
      expect(logger.warn).toHaveBeenCalledWith(
        'Sync worker latched off after repeated failures — using main-thread crypto',
        expect.objectContaining({ consecutiveFailures: MAX_CONSECUTIVE_FAILURES })
      )
    })

    it('#then a successful batch clears the failure count', async () => {
      // #given — failures stop one short of the threshold
      await startReady()
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 1; i++) await silentBatch()

      // #when — the worker recovers, then stumbles again
      await answeredBatch()
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 1; i++) await silentBatch()

      // #then — failures must be *consecutive* to latch. Without the reset the
      // count would already stand at 2 * (MAX - 1) and this would be latched.
      expect(bridge.isRunning).toBe(true)

      // #and — the threshold is still enforced, just counted from the success
      await silentBatch()
      expect(bridge.isRunning).toBe(false)
    })

    it('#then a restarted bridge is no longer latched', async () => {
      // #given — a latched bridge
      await startReady()
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) await silentBatch()
      expect(bridge.isRunning).toBe(false)

      // #when — the only in-session recovery path: drop the thread and respawn
      const stopPromise = bridge.stop()
      mockWorkerInstance.simulateExit(0)
      await stopPromise
      await startReady()

      // #then — a fresh thread is not the thread that failed
      expect(bridge.isRunning).toBe(true)
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
