import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import type { WorkerToMainMessage } from '@memry/sync-client/worker-protocol'

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

import { MAX_CONSECUTIVE_FAILURES, MAX_PENDING_REQUESTS, SyncWorkerBridge } from './worker-bridge'

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

    it('#then drops the shutdown exit listener when the 3s timeout fires', async () => {
      // #given
      const p = bridge.start()
      mockWorkerInstance.simulateMessage({ type: 'ready' })
      await p
      const exitListenersBefore = mockWorkerInstance.listenerCount('exit')

      // #when
      const stopPromise = bridge.stop()
      expect(mockWorkerInstance.listenerCount('exit')).toBe(exitListenersBefore + 1)
      vi.advanceTimersByTime(3_001)
      await stopPromise

      // #then — only setupMessageHandler's listener is left
      expect(mockWorkerInstance.listenerCount('exit')).toBe(exitListenersBefore)
    })

    it('#then a late exit from the timed-out worker cannot reject a restarted bridge', async () => {
      // #given — a stop() that hit the 3s timeout
      const p = bridge.start()
      mockWorkerInstance.simulateMessage({ type: 'ready' })
      await p
      const abandonedWorker = mockWorkerInstance

      const stopPromise = bridge.stop()
      vi.advanceTimersByTime(3_001)
      await stopPromise

      // #and — the bridge is restarted on a fresh thread
      const restart = bridge.start()
      mockWorkerInstance.simulateMessage({ type: 'ready' })
      await restart
      expect(mockWorkerInstance).not.toBe(abandonedWorker)

      const encryptPromise = bridge.encryptBatch(
        [],
        new Uint8Array(32),
        new Uint8Array(64),
        'device-1'
      )

      // #when — terminate() lands and the abandoned thread finally reports exit
      abandonedWorker.simulateExit(0)

      // #then — the new worker's in-flight request is untouched by the old thread
      const posted = mockWorkerInstance.postMessage.mock.calls.find(
        ([m]) => m.type === 'encrypt-batch'
      )![0]
      mockWorkerInstance.simulateMessage({
        type: 'encrypt-batch-result',
        requestId: posted.requestId,
        results: [],
        errors: []
      })
      await expect(encryptPromise).resolves.toEqual({ results: [], errors: [] })
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

  describe('#given a timed-out stop() and a restart #when the abandoned thread speaks', () => {
    const startReady = async (): Promise<MockWorker> => {
      const p = bridge.start()
      mockWorkerInstance.simulateMessage({ type: 'ready' })
      await p
      return mockWorkerInstance
    }

    /**
     * stop() that hits the 3s timeout — terminate() is fired but the thread is
     * abandoned without waiting for its exit — followed by the documented
     * in-session recovery, start() on a fresh thread.
     */
    const abandonThenRestart = async (): Promise<[MockWorker, MockWorker]> => {
      const abandoned = await startReady()
      const stopPromise = bridge.stop()
      vi.advanceTimersByTime(3_001)
      await stopPromise

      const live = await startReady()
      expect(live).not.toBe(abandoned)
      return [abandoned, live]
    }

    const inFlightEncrypt = (
      live: MockWorker
    ): { promise: Promise<unknown>; requestId: string } => {
      const promise = bridge.encryptBatch([], new Uint8Array(32), new Uint8Array(64), 'device-1')
      const posted = live.postMessage.mock.calls
        .filter(([m]) => m.type === 'encrypt-batch')
        .at(-1)?.[0]
      // Never issued means the bridge refused the batch — the wedge this suite
      // is about. Keep going so the assertion reports the rejection, not a
      // TypeError on the missing message.
      return { promise, requestId: posted?.requestId ?? 'never-issued' }
    }

    it('#then a batch submitted after its exit still reaches the live worker', async () => {
      // #given
      const [abandoned, live] = await abandonThenRestart()

      // #when — terminate() lands and the abandoned thread finally exits, with
      // the non-zero code terminate() produces
      abandoned.simulateExit(1)

      // #then — the bridge still owns the live thread, so a new batch goes to
      // the worker instead of rejecting with 'Worker not started' and degrading
      // the rest of the session to main-thread crypto
      const { promise, requestId } = inFlightEncrypt(live)
      live.simulateMessage({
        type: 'encrypt-batch-result',
        requestId,
        results: [],
        errors: []
      })
      await expect(promise).resolves.toEqual({ results: [], errors: [] })
      expect(bridge.isRunning).toBe(true)
    })

    it('#then its message and error listeners are detached too, not just exit', async () => {
      // #given
      const [abandoned] = await abandonThenRestart()

      // #when
      abandoned.simulateExit(1)

      // #then — nothing of the bridge is left on the thread it walked away from
      expect(abandoned.listenerCount('message')).toBe(0)
      expect(abandoned.listenerCount('error')).toBe(0)
      expect(abandoned.listenerCount('exit')).toBe(0)
    })

    it('#then a late reply from it cannot answer the live worker request', async () => {
      // #given
      const [abandoned, live] = await abandonThenRestart()
      const { promise, requestId } = inFlightEncrypt(live)

      // #when — the abandoned thread replies against the live thread's request
      abandoned.simulateMessage({ type: 'error', requestId, error: 'ghost batch' })

      // #then — only the live worker's own reply settles it
      live.simulateMessage({
        type: 'encrypt-batch-result',
        requestId,
        results: [],
        errors: []
      })
      await expect(promise).resolves.toEqual({ results: [], errors: [] })
    })

    it('#then a late error from it cannot reject the live worker request', async () => {
      // #given
      const [abandoned, live] = await abandonThenRestart()
      const { promise, requestId } = inFlightEncrypt(live)

      // #when — terminate() tears the abandoned thread down mid-flight
      abandoned.simulateError(new Error('terminated mid-batch'))

      // #then
      live.simulateMessage({
        type: 'encrypt-batch-result',
        requestId,
        results: [],
        errors: []
      })
      await expect(promise).resolves.toEqual({ results: [], errors: [] })
    })
  })

  describe('#given a stop() inside its shutdown window #when start() races it', () => {
    const startReady = async (): Promise<MockWorker> => {
      const p = bridge.start()
      mockWorkerInstance.simulateMessage({ type: 'ready' })
      await p
      return mockWorkerInstance
    }

    /**
     * The raced start() resumes on the microtask queue behind stop()'s own
     * resolution — nothing here is timer-driven — so the fresh Worker is not
     * constructed yet when `await stopPromise` returns.
     */
    const flushMicrotasks = async (): Promise<void> => {
      for (let i = 0; i < 5; i++) await Promise.resolve()
    }

    /** stop() that hits the 3s timeout with a start() issued mid-window. */
    const raceStartAgainstTimingOutStop = async (): Promise<void> => {
      const stopPromise = bridge.stop()
      const startPromise = bridge.start()

      vi.advanceTimersByTime(3_001)
      await stopPromise
      await flushMicrotasks()

      mockWorkerInstance.simulateMessage({ type: 'ready' })
      await startPromise
    }

    it('#then a crypto batch still reaches a worker instead of "Worker not started"', async () => {
      // #given
      await startReady()

      // #when — the caller does not await the stop before starting again
      await raceStartAgainstTimingOutStop()

      // #then — start() reported success and there is a thread behind it. When
      // start() no-opped on stop()'s still-non-null `this.worker`, stop()'s
      // continuation left the bridge with no worker at all and this batch
      // rejected with 'Worker not started' — three of which latch the bridge
      // off to main-thread crypto for the rest of the session.
      const promise = bridge.encryptBatch([], new Uint8Array(32), new Uint8Array(64), 'device-1')
      const posted = mockWorkerInstance.postMessage.mock.calls
        .filter(([m]) => m.type === 'encrypt-batch')
        .at(-1)?.[0]
      mockWorkerInstance.simulateMessage({
        type: 'encrypt-batch-result',
        // Never issued means the bridge refused the batch — assert on the
        // rejection rather than a TypeError on the missing message.
        requestId: posted?.requestId ?? 'never-issued',
        results: [],
        errors: []
      })
      await expect(promise).resolves.toEqual({ results: [], errors: [] })
      expect(bridge.isRunning).toBe(true)
    })

    it('#then the raced start spawns a fresh thread, not the one shutting down', async () => {
      // #given
      const stopping = await startReady()

      // #when
      await raceStartAgainstTimingOutStop()

      // #then — terminate() was already fired at the old thread, so reusing it
      // is not an option
      expect(mockWorkerInstance).not.toBe(stopping)
      expect(stopping.terminate).toHaveBeenCalled()
    })

    it('#then the raced start still clears a latched-off bridge', async () => {
      // #given — a latched bridge, whose only in-session recovery is stop()
      // followed by start()
      await startReady()
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
        const request = bridge.encryptBatch([], new Uint8Array(32), new Uint8Array(64), 'device-1')
        vi.advanceTimersByTime(60_001)
        await expect(request).rejects.toThrow('Worker request timed out')
      }
      expect(bridge.isRunning).toBe(false)

      // #when — that recovery is issued without awaiting the stop
      await raceStartAgainstTimingOutStop()

      // #then — a start() that bails on the `this.worker` guard never reaches
      // the latch reset, so the recovery silently did nothing
      expect(bridge.isRunning).toBe(true)
    })

    it('#then isRunning is false while the thread is being shut down', async () => {
      // #given
      const worker = await startReady()

      // #when
      const stopPromise = bridge.stop()

      // #then — sync-crypto-batch gates on this, so the batch goes to
      // main-thread crypto now instead of waiting out REQUEST_TIMEOUT_MS for a
      // reply from a thread that has been told to exit
      expect(bridge.isRunning).toBe(false)

      worker.simulateExit(0)
      await stopPromise
    })

    it('#then a second stop() joins the one in flight instead of racing it', async () => {
      // #given
      const worker = await startReady()

      // #when
      const first = bridge.stop()
      const second = bridge.stop()
      worker.simulateExit(0)
      await Promise.all([first, second])

      // #then — one shutdown, one exit race, one window
      expect(worker.postMessage.mock.calls.filter(([m]) => m.type === 'shutdown')).toHaveLength(1)
      expect(bridge.isRunning).toBe(false)
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

  describe('#given running bridge #when pending requests are never answered', () => {
    const startReadyBridge = async (): Promise<void> => {
      const p = bridge.start()
      mockWorkerInstance.simulateMessage({ type: 'ready' })
      await p
    }

    const sendUnanswered = (): Promise<unknown> => {
      const request = bridge.encryptBatch([], new Uint8Array(32), new Uint8Array(64), 'device-1')
      request.catch(() => {})
      return request
    }

    it('#then rejects once the pending map is at MAX_PENDING_REQUESTS', async () => {
      // #given — the worker accepts requests and never replies
      await startReadyBridge()
      for (let i = 0; i < MAX_PENDING_REQUESTS; i++) sendUnanswered()

      // #when / #then
      await expect(
        bridge.encryptBatch([], new Uint8Array(32), new Uint8Array(64), 'device-1')
      ).rejects.toThrow('Worker request queue full')
    })

    it('#then the rejected request is never posted to the worker', async () => {
      // #given
      await startReadyBridge()
      for (let i = 0; i < MAX_PENDING_REQUESTS; i++) sendUnanswered()

      // #when
      await bridge
        .encryptBatch([], new Uint8Array(32), new Uint8Array(64), 'device-1')
        .catch(() => {})

      // #then — capped requests cost nothing: no message, no pending entry
      const posted = mockWorkerInstance.postMessage.mock.calls.filter(
        ([m]) => m.type === 'encrypt-batch'
      )
      expect(posted).toHaveLength(MAX_PENDING_REQUESTS)
    })

    it('#then a request whose own timeout never fired is swept', async () => {
      // #given
      await startReadyBridge()
      const request = sendUnanswered()

      // #when — the wall clock moves past the stale threshold without advancing
      // the timer queue, so the request's own 60s timeout has not fired
      vi.setSystemTime(Date.now() + 70_000)
      vi.advanceTimersByTime(30_000)

      // #then
      await expect(request).rejects.toThrow('Worker request abandoned')
    })

    it('#then the sweep never preempts a live per-request timeout', async () => {
      // #given
      await startReadyBridge()
      const request = sendUnanswered()

      // #when — real elapsed time, so the 60s request timeout owns the failure
      vi.advanceTimersByTime(61_000)

      // #then
      await expect(request).rejects.toThrow('Worker request timed out')
    })

    it('#then no timer is left running once the last request settles', async () => {
      // #given
      await startReadyBridge()
      const request = bridge.encryptBatch([], new Uint8Array(32), new Uint8Array(64), 'device-1')
      const posted = mockWorkerInstance.postMessage.mock.calls.find(
        ([m]) => m.type === 'encrypt-batch'
      )![0]
      expect(vi.getTimerCount()).toBeGreaterThan(0)

      // #when
      mockWorkerInstance.simulateMessage({
        type: 'encrypt-batch-result',
        requestId: posted.requestId,
        results: [],
        errors: []
      })
      await request

      // #then — the sweep interval is not left ticking for the session
      expect(vi.getTimerCount()).toBe(0)
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

  describe('#given a mixed-build worker replying protocol-known errors #when batches keep failing', () => {
    const startReady = async (): Promise<void> => {
      const p = bridge.start()
      mockWorkerInstance.simulateMessage({ type: 'ready' })
      await p
    }

    /** Answer the newest in-flight batch the way an old worker build does. */
    const replyUnknownKindError = (): void => {
      const posted = mockWorkerInstance.postMessage.mock.calls
        .filter(([m]) => m.type === 'encrypt-batch')
        .at(-1)![0]
      mockWorkerInstance.simulateMessage({
        type: 'error',
        requestId: posted.requestId,
        error: `Unsupported worker message kind: ${String(posted.type)}`
      })
    }

    it('#then every call still routes to the worker and the bridge is never latched', async () => {
      // #given
      await startReady()
      logger.warn.mockClear()

      // #when — more consecutive protocol-error replies than the latch threshold
      for (let i = 0; i <= MAX_CONSECUTIVE_FAILURES; i++) {
        const request = bridge.encryptBatch([], new Uint8Array(32), new Uint8Array(64), 'device-1')
        replyUnknownKindError()
        // #then — each CALL rejects so the caller falls back to main-thread crypto…
        await expect(request).rejects.toThrow('Unsupported worker message kind')
      }

      // #and — …but the transport was never actually failing: a latch here would
      // demote push encryption session-wide over replies the worker made in time.
      expect(bridge.isRunning).toBe(true)
      expect(
        mockWorkerInstance.postMessage.mock.calls.filter(([m]) => m.type === 'encrypt-batch')
      ).toHaveLength(MAX_CONSECUTIVE_FAILURES + 1)
      expect(logger.warn).not.toHaveBeenCalledWith(
        'Sync worker latched off after repeated failures — using main-thread crypto',
        expect.anything()
      )
    })

    it('#then a genuine timeout still engages the latch alongside them', async () => {
      // #given — a protocol-error reply, which must not advance the failure count
      await startReady()
      const errored = bridge.encryptBatch([], new Uint8Array(32), new Uint8Array(64), 'device-1')
      replyUnknownKindError()
      await expect(errored).rejects.toThrow('Unsupported worker message kind')
      expect(bridge.isRunning).toBe(true)

      // #when — real transport failures: a live-but-silent worker timing out
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
        const silent = bridge.encryptBatch([], new Uint8Array(32), new Uint8Array(64), 'device-1')
        vi.advanceTimersByTime(60_001)
        await expect(silent).rejects.toThrow('Worker request timed out')
      }

      // #then
      expect(bridge.isRunning).toBe(false)
    })
  })
  /**
   * decryptCrdtBatch is the off-thread CRDT decrypt entry point. Nothing pinned
   * it: worker.test.ts covers the worker's side of `decrypt-crdt-batch`, and
   * the CRDT coordinator tests mock the bridge object wholesale — so an empty
   * body here, or a lost `WorkerProtocolError` latch exemption, passed the
   * whole main suite.
   */
  describe('#given a running bridge #when decryptCrdtBatch round-trips', () => {
    const startReady = async (): Promise<void> => {
      const p = bridge.start()
      mockWorkerInstance.simulateMessage({ type: 'ready' })
      await p
    }

    /** requestId of the newest posted `decrypt-crdt-batch`. */
    const lastCrdtRequestId = (): string =>
      mockWorkerInstance.postMessage.mock.calls
        .filter(([m]) => m.type === 'decrypt-crdt-batch')
        .at(-1)![0].requestId

    const callDecryptCrdt = (): ReturnType<SyncWorkerBridge['decryptCrdtBatch']> =>
      bridge.decryptCrdtBatch(
        [{ index: 0, noteId: 'note-1', dataB64: 'ZA==', signerDeviceId: 'device-1' }],
        new Uint8Array(32),
        { 'device-1': 'cGs=' }
      )

    it('#then the worker reply is handed back verbatim, results and failures alike', async () => {
      // #given
      await startReady()
      const request = callDecryptCrdt()

      // #when
      mockWorkerInstance.simulateMessage({
        type: 'decrypt-crdt-batch-result',
        requestId: lastCrdtRequestId(),
        results: [{ index: 0, update: new Uint8Array([1, 2, 3]) }],
        failures: [{ index: 1, noteId: 'note-2', error: 'bad signature', isSignatureError: true }]
      })

      // #then — the caller re-indexes results by `index`, so a dropped result
      // that is not also listed in `failures` becomes an undefined CRDT update.
      await expect(request).resolves.toEqual({
        results: [{ index: 0, update: new Uint8Array([1, 2, 3]) }],
        failures: [{ index: 1, noteId: 'note-2', error: 'bad signature', isSignatureError: true }]
      })
    })

    it('#then a reply of the wrong kind rejects instead of being read as a result', async () => {
      // #given
      await startReady()
      const request = callDecryptCrdt()

      // #when — a record-decrypt result answering a CRDT-decrypt request
      mockWorkerInstance.simulateMessage({
        type: 'decrypt-batch-result',
        requestId: lastCrdtRequestId(),
        results: [],
        failures: []
      })

      // #then
      await expect(request).rejects.toThrow(/Unexpected response type/)
    })

    it('#then a mixed-build worker rejecting the kind never latches the bridge off', async () => {
      // #given — a worker bundle that predates `decrypt-crdt-batch`
      await startReady()
      logger.warn.mockClear()

      // #when — more consecutive protocol-error replies than the latch threshold
      for (let i = 0; i <= MAX_CONSECUTIVE_FAILURES; i++) {
        const request = callDecryptCrdt()
        mockWorkerInstance.simulateMessage({
          type: 'error',
          requestId: lastCrdtRequestId(),
          error: 'Unsupported worker message kind: decrypt-crdt-batch'
        })
        await expect(request).rejects.toThrow('Unsupported worker message kind')
      }

      // #then — the transport was never failing; latching here would demote ALL
      // push encryption and pull decryption to the main thread for the session.
      expect(bridge.isRunning).toBe(true)
      expect(logger.warn).not.toHaveBeenCalledWith(
        'Sync worker latched off after repeated failures — using main-thread crypto',
        expect.anything()
      )
    })

    it('#then a successful reply clears the consecutive-failure count', async () => {
      // #given — two real transport failures, one short of the latch
      await startReady()
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 1; i++) {
        const silent = callDecryptCrdt()
        vi.advanceTimersByTime(60_001)
        await expect(silent).rejects.toThrow('Worker request timed out')
      }

      // #when — the worker answers one batch cleanly
      const ok = callDecryptCrdt()
      mockWorkerInstance.simulateMessage({
        type: 'decrypt-crdt-batch-result',
        requestId: lastCrdtRequestId(),
        results: [],
        failures: []
      })
      await ok

      // #then — the streak restarts, so the same count of later timeouts is
      // still below the threshold and the bridge stays on.
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 1; i++) {
        const silent = callDecryptCrdt()
        vi.advanceTimersByTime(60_001)
        await expect(silent).rejects.toThrow('Worker request timed out')
      }
      expect(bridge.isRunning).toBe(true)
    })
  })
})
