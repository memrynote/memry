import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import { SettingsChannels } from '@memry/contracts/ipc-channels'

const mockApp = vi.hoisted(() => ({
  getPath: vi.fn((name: string) => `/mock/${name}`)
}))
const getAllWindows = vi.hoisted(() => vi.fn())
const mockFork = vi.hoisted(() => vi.fn())
const trackMainLogMock = vi.hoisted(() => vi.fn())

vi.mock('../telemetry/diagnostics', () => ({
  trackMainLog: trackMainLogMock
}))

class MockUtilityProcess extends EventEmitter {
  postMessage = vi.fn()
  // Real utilityProcess.kill() ALWAYS causes an 'exit'; the old no-op stub hid
  // every force-kill / reset exit path (where the phase-attribution bugs live).
  // Arm killExitCode to model the OS delivering that 'exit' as a LATER macrotask,
  // so it races the `shuttingDown` reset exactly as production does.
  killExitCode: number | null = null
  kill = vi.fn(() => {
    if (this.killExitCode !== null) {
      const code = this.killExitCode
      setTimeout(() => this.emit('exit', code), 0)
    }
    return true
  })
  stdout = null
  stderr = null
  pid = 1234

  simulateMessage(message: unknown): void {
    this.emit('message', message)
  }
}

class MockBrowserWindow {
  isDestroyed = () => false
  webContents = {
    isDestroyed: () => false,
    send: vi.fn()
  }
}

let mockUtilityProcessInstance: MockUtilityProcess

vi.mock('electron', () => ({
  app: mockApp,
  BrowserWindow: {
    getAllWindows
  },
  utilityProcess: {
    fork: (...args: unknown[]) => {
      mockUtilityProcessInstance = new MockUtilityProcess()
      mockFork(...args)
      return mockUtilityProcessInstance
    }
  }
}))

vi.mock('@huggingface/transformers', () => {
  throw new Error('@huggingface/transformers should only load inside embedding-worker')
})

import { resetTelemetryThrottle } from '../telemetry/throttle'
import {
  EMBEDDING_DIMENSION,
  generateEmbedding,
  getEmbeddingWorkerPhase,
  getModelInfo,
  initEmbeddingModel,
  isInformationalWorkerStderr,
  isModelLoaded,
  isModelLoading,
  resetEmbeddingModelFailure,
  stopEmbeddingModel,
  unloadModel
} from './embeddings'

describe('embeddings', () => {
  beforeEach(() => {
    unloadModel()
    mockFork.mockReset()
    trackMainLogMock.mockReset()
    resetTelemetryThrottle()
    mockApp.getPath.mockImplementation((name: string) =>
      name === 'userData' ? '/mock/user-data' : `/mock/${name}`
    )
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([])
  })

  afterEach(() => {
    unloadModel()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('loads the model through a utility process and forwards progress events', async () => {
    const window = new MockBrowserWindow()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window])

    const loadPromise = initEmbeddingModel()

    expect(mockFork).toHaveBeenCalledOnce()
    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
    await vi.waitFor(() => {
      expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(1)
    })

    const [, , options] = mockFork.mock.calls[0] ?? []
    expect(options).toEqual(
      expect.objectContaining({
        serviceName: 'Embeddings',
        env: expect.objectContaining({
          MEMRY_USER_DATA_PATH: '/mock/user-data'
        })
      })
    )

    const requestMessage = mockUtilityProcessInstance.postMessage.mock.calls[0]?.[0] as {
      type: string
      requestId: string
    }
    expect(requestMessage.type).toBe('load-model')

    mockUtilityProcessInstance.simulateMessage({
      type: 'progress',
      phase: 'downloading',
      progress: 42,
      status: 'Downloading model: 42%'
    })
    mockUtilityProcessInstance.simulateMessage({
      type: 'progress',
      phase: 'ready',
      progress: 100,
      status: 'Model ready'
    })
    mockUtilityProcessInstance.simulateMessage({
      type: 'load-model-result',
      requestId: requestMessage.requestId
    })

    await expect(loadPromise).resolves.toBe(true)
    expect(getModelInfo().loaded).toBe(true)

    expect(window.webContents.send).toHaveBeenCalledWith(
      SettingsChannels.events.EMBEDDING_PROGRESS,
      expect.objectContaining({
        phase: 'downloading',
        progress: 42
      })
    )
  })

  it('returns false and surfaces errors when model load fails', async () => {
    const loadPromise = initEmbeddingModel()

    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
    await vi.waitFor(() => {
      expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(1)
    })

    const requestMessage = mockUtilityProcessInstance.postMessage.mock.calls[0]?.[0] as {
      requestId: string
    }
    mockUtilityProcessInstance.simulateMessage({
      type: 'error',
      requestId: requestMessage.requestId,
      error: 'load failed'
    })

    await expect(loadPromise).resolves.toBe(false)
    expect(getModelInfo().error).toBe('load failed')
  })

  it('short-circuits repeat load attempts after a failure until reset', async () => {
    // First load fails.
    const first = initEmbeddingModel()
    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
    await vi.waitFor(() => {
      expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(1)
    })
    const worker = mockUtilityProcessInstance
    const req = worker.postMessage.mock.calls[0]?.[0] as { requestId: string }
    worker.simulateMessage({ type: 'error', requestId: req.requestId, error: 'load failed' })
    await expect(first).resolves.toBe(false)
    expect(mockFork).toHaveBeenCalledOnce()

    // Circuit breaker latched: the next attempt returns false without forking a
    // fresh worker or sending another load-model request — this is the per-note
    // re-download loop that made vault-open hang (#803).
    await expect(initEmbeddingModel()).resolves.toBe(false)
    expect(mockFork).toHaveBeenCalledOnce()
    expect(worker.postMessage).toHaveBeenCalledTimes(1)

    // Reset re-enables loading; the next attempt issues a fresh load-model request.
    resetEmbeddingModelFailure()
    const third = initEmbeddingModel()
    await vi.waitFor(() => {
      expect(worker.postMessage).toHaveBeenCalledTimes(2)
    })
    const req3 = worker.postMessage.mock.calls[1]?.[0] as { requestId: string }
    worker.simulateMessage({ type: 'load-model-result', requestId: req3.requestId })
    await expect(third).resolves.toBe(true)
    expect(isModelLoaded()).toBe(true)
  })

  it('tracks loading state and unloads the model', async () => {
    const loading = initEmbeddingModel()
    expect(isModelLoading()).toBe(true)

    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
    await vi.waitFor(() => {
      expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(1)
    })
    expect(isModelLoading()).toBe(true)

    const requestMessage = mockUtilityProcessInstance.postMessage.mock.calls[0]?.[0] as {
      requestId: string
    }
    mockUtilityProcessInstance.simulateMessage({
      type: 'progress',
      phase: 'ready',
      progress: 100,
      status: 'Model ready'
    })
    mockUtilityProcessInstance.simulateMessage({
      type: 'load-model-result',
      requestId: requestMessage.requestId
    })

    await loading

    expect(isModelLoading()).toBe(false)
    expect(isModelLoaded()).toBe(true)

    unloadModel()
    expect(isModelLoaded()).toBe(false)
  })

  it('returns null for text below the minimum length without starting the worker', async () => {
    const result = await generateEmbedding('short')

    expect(result).toBeNull()
    expect(mockFork).not.toHaveBeenCalled()
  })

  it('truncates long text and returns an embedding', async () => {
    const longText = 'a'.repeat(2500)
    const embeddingPromise = generateEmbedding(longText)

    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
    await vi.waitFor(() => {
      expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(1)
    })

    const requestMessage = mockUtilityProcessInstance.postMessage.mock.calls[0]?.[0] as {
      type: string
      requestId: string
      text: string
    }
    expect(requestMessage.type).toBe('embed')
    expect(requestMessage.text.length).toBe(2000)

    mockUtilityProcessInstance.simulateMessage({
      type: 'embed-result',
      requestId: requestMessage.requestId,
      embedding: Array.from(new Float32Array(EMBEDDING_DIMENSION))
    })

    const embedding = await embeddingPromise
    expect(embedding).toBeInstanceOf(Float32Array)
    expect(embedding?.length).toBe(EMBEDDING_DIMENSION)
  })

  it('returns null when embedding dimension is unexpected', async () => {
    const embeddingPromise = generateEmbedding('this is long enough for embeddings')

    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
    await vi.waitFor(() => {
      expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(1)
    })

    const requestMessage = mockUtilityProcessInstance.postMessage.mock.calls[0]?.[0] as {
      requestId: string
    }
    mockUtilityProcessInstance.simulateMessage({
      type: 'embed-result',
      requestId: requestMessage.requestId,
      embedding: Array.from(new Float32Array(10))
    })

    await expect(embeddingPromise).resolves.toBeNull()
  })

  it('reuses the utility process while active and shuts it down after idling', async () => {
    vi.useFakeTimers()
    const firstEmbedding = generateEmbedding('first content long enough')

    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
    await vi.waitFor(() => {
      expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(1)
    })

    const firstRequest = mockUtilityProcessInstance.postMessage.mock.calls[0]?.[0] as {
      requestId: string
    }
    mockUtilityProcessInstance.simulateMessage({
      type: 'embed-result',
      requestId: firstRequest.requestId,
      embedding: Array.from(new Float32Array(EMBEDDING_DIMENSION))
    })

    await expect(firstEmbedding).resolves.toBeInstanceOf(Float32Array)
    await vi.advanceTimersByTimeAsync(20_000)

    const secondEmbedding = generateEmbedding('second content long enough')
    await vi.waitFor(() => {
      expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(2)
    })

    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockUtilityProcessInstance.postMessage).not.toHaveBeenCalledWith({ type: 'shutdown' })

    const secondRequest = mockUtilityProcessInstance.postMessage.mock.calls[1]?.[0] as {
      requestId: string
    }
    mockUtilityProcessInstance.simulateMessage({
      type: 'embed-result',
      requestId: secondRequest.requestId,
      embedding: Array.from(new Float32Array(EMBEDDING_DIMENSION))
    })

    await expect(secondEmbedding).resolves.toBeInstanceOf(Float32Array)
    expect(mockFork).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(mockUtilityProcessInstance.postMessage).toHaveBeenLastCalledWith({ type: 'shutdown' })
  })

  // These exist to answer the open production question behind the
  // `Utility:crashed:*` volume: does the worker die while TEARING DOWN (user
  // impact ~zero, embedding already delivered) or while WORKING (user silently
  // loses semantic-search indexing)? Nothing in telemetry can tell them apart today.
  describe('worker exit telemetry', () => {
    const startWorker = async (): Promise<{ requestId: string }> => {
      const pending = generateEmbedding('content long enough for embeddings')
      void pending.catch(() => {})
      mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
      await vi.waitFor(() => {
        expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(1)
      })
      const request = mockUtilityProcessInstance.postMessage.mock.calls[0]?.[0] as {
        requestId: string
      }
      return { requestId: request.requestId }
    }

    it('reports idle_shutdown when the worker dies during its own teardown', async () => {
      vi.useFakeTimers()
      const { requestId } = await startWorker()

      // #given the embedding was delivered, so nothing is in flight
      mockUtilityProcessInstance.simulateMessage({
        type: 'embed-result',
        requestId,
        embedding: Array.from(new Float32Array(EMBEDDING_DIMENSION))
      })
      await vi.waitFor(() => expect(getModelInfo().loaded).toBe(true))

      // #when the 30s idle timer fires and the worker dies mid-teardown (SIGSEGV)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(mockUtilityProcessInstance.postMessage).toHaveBeenLastCalledWith({ type: 'shutdown' })
      mockUtilityProcessInstance.emit('exit', 11)

      // #then telemetry names the phase — this crash cost the user nothing
      expect(trackMainLogMock).toHaveBeenCalledWith('error', {
        scope: 'Embeddings',
        action: 'worker_exit_idle_shutdown',
        errorCode: 'EmbeddingWorkerExit',
        metrics: { value: 11 }
      })
    })

    it('reports in_flight when the worker dies with a request outstanding', async () => {
      await startWorker()

      // #when the worker dies while the embed request is still outstanding
      mockUtilityProcessInstance.emit('exit', 11)

      // #then telemetry says the user silently lost this embedding
      expect(trackMainLogMock).toHaveBeenCalledWith('error', {
        scope: 'Embeddings',
        action: 'worker_exit_in_flight',
        errorCode: 'EmbeddingWorkerExit',
        metrics: { value: 11 }
      })
    })

    it('reports idle when the worker crashes spontaneously while sitting idle', async () => {
      vi.useFakeTimers()
      const { requestId } = await startWorker()
      mockUtilityProcessInstance.simulateMessage({
        type: 'embed-result',
        requestId,
        embedding: Array.from(new Float32Array(EMBEDDING_DIMENSION))
      })
      await vi.waitFor(() => expect(getModelInfo().loaded).toBe(true))

      // #when the worker dies on its own AFTER delivering, but BEFORE the 30s idle
      // timer fires — not tearing down, nothing in flight
      mockUtilityProcessInstance.emit('exit', 11)

      // #then it is the genuine `idle` bucket, distinct from idle_shutdown (this
      // guards the force-kill latch from over-claiming idle_shutdown)
      expect(trackMainLogMock).toHaveBeenCalledWith('error', {
        scope: 'Embeddings',
        action: 'worker_exit_idle',
        errorCode: 'EmbeddingWorkerExit',
        metrics: { value: 11 }
      })
    })

    it('stays silent for a clean idle shutdown', async () => {
      vi.useFakeTimers()
      const { requestId } = await startWorker()
      mockUtilityProcessInstance.simulateMessage({
        type: 'embed-result',
        requestId,
        embedding: Array.from(new Float32Array(EMBEDDING_DIMENSION))
      })
      await vi.waitFor(() => expect(getModelInfo().loaded).toBe(true))

      await vi.advanceTimersByTimeAsync(30_000)
      // #when the worker exits(0) as designed — lifecycle, not a fault
      mockUtilityProcessInstance.emit('exit', 0)

      expect(trackMainLogMock).not.toHaveBeenCalled()
    })

    it('reports idle_shutdown when a wedged worker must be force-killed during teardown', async () => {
      vi.useFakeTimers()
      const { requestId } = await startWorker()
      mockUtilityProcessInstance.simulateMessage({
        type: 'embed-result',
        requestId,
        embedding: Array.from(new Float32Array(EMBEDDING_DIMENSION))
      })
      await vi.waitFor(() => expect(getModelInfo().loaded).toBe(true))

      // #given the worker ignores the graceful shutdown and wedges — the exact
      // onnxruntime-dispose failure mode this telemetry exists to catch
      mockUtilityProcessInstance.killExitCode = 15 // SIGTERM

      // #when the 30s idle timer fires -> stop() posts shutdown, but no clean exit
      await vi.advanceTimersByTimeAsync(30_000)
      expect(mockUtilityProcessInstance.postMessage).toHaveBeenLastCalledWith({ type: 'shutdown' })
      expect(mockUtilityProcessInstance.kill).not.toHaveBeenCalled()

      // #and the 3s force-kill timeout fires; kill() delivers 'exit' as a later
      // macrotask, AFTER the await continuation clears `shuttingDown`
      await vi.advanceTimersByTimeAsync(3_000)
      expect(mockUtilityProcessInstance.kill).toHaveBeenCalledOnce()

      // #then the teardown death is named idle_shutdown, NOT the misleading `idle`
      // ("died spontaneously doing nothing") the shuttingDown-reset race produced
      expect(trackMainLogMock).toHaveBeenCalledWith('error', {
        scope: 'Embeddings',
        action: 'worker_exit_idle_shutdown',
        errorCode: 'EmbeddingWorkerExit',
        metrics: { value: 15 }
      })
      expect(trackMainLogMock).not.toHaveBeenCalledWith(
        'error',
        expect.objectContaining({ action: 'worker_exit_idle' })
      )
    })

    it('reports idle_shutdown when reset() force-kills the running worker', async () => {
      vi.useFakeTimers()
      await startWorker()

      // #given a live worker that reset() will hard-kill to free memory
      mockUtilityProcessInstance.killExitCode = 15

      // #when unloadModel() force-kills it (no graceful shutdown message)
      unloadModel()
      await vi.advanceTimersByTimeAsync(0)

      // #then its teardown death is idle_shutdown, not the racy `idle`
      expect(trackMainLogMock).toHaveBeenCalledWith('error', {
        scope: 'Embeddings',
        action: 'worker_exit_idle_shutdown',
        errorCode: 'EmbeddingWorkerExit',
        metrics: { value: 15 }
      })
    })
  })

  describe('worker exit before ready', () => {
    it('reports worker_exit_starting when the worker dies before it becomes ready', async () => {
      const loadPromise = initEmbeddingModel()

      // #when the worker crashes during bootstrap, before ever sending 'ready'
      mockUtilityProcessInstance.emit('exit', 1)
      await expect(loadPromise).resolves.toBe(false)

      // #then the death is attributed to the startup phase
      expect(trackMainLogMock).toHaveBeenCalledWith('error', {
        scope: 'Embeddings',
        action: 'worker_exit_starting',
        errorCode: 'EmbeddingWorkerExit',
        metrics: { value: 1 }
      })
    })

    it('stays silent when shut down before the worker finishes starting', async () => {
      const loadPromise = initEmbeddingModel()
      expect(mockFork).toHaveBeenCalledOnce()

      // #given the app quits while the worker is still bootstrapping (no 'ready')
      const stopPromise = stopEmbeddingModel()

      // #when that bootstrapping worker exits cleanly in response to the shutdown
      mockUtilityProcessInstance.emit('exit', 0)
      await stopPromise
      await expect(loadPromise).resolves.toBe(false)

      // #then a clean lifecycle exit is NOT reported as a worker_exit_starting fault
      expect(trackMainLogMock).not.toHaveBeenCalled()
    })
  })

  // The `exit` event every test above drives never arrives in production for a
  // native worker crash: 107 consecutive `Utility:crashed:Embeddings` reports
  // produced zero `EmbeddingWorkerExit` events, and `embed_failed` was silent
  // too — the bridge never observes the death at all. `app.on('child-process-
  // gone')` is the path that does fire (107/107), so the phase has to be
  // readable from outside the exit handler for that report to carry it.
  describe('getEmbeddingWorkerPhase', () => {
    // Wrapped in an object, never returned bare: an async function flattens a
    // returned promise, so `await startWorker()` would block on the embedding
    // itself instead of on the worker being up.
    const startWorker = async (): Promise<{ pending: Promise<Float32Array | null> }> => {
      const pending = generateEmbedding('content long enough for embeddings')
      void pending.catch(() => {})
      mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
      await vi.waitFor(() => {
        expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(1)
      })
      return { pending }
    }

    it('returns null when no worker has been forked', () => {
      expect(getEmbeddingWorkerPhase('Embeddings')).toBeNull()
    })

    it('ignores a crash reported for a different utility worker', async () => {
      await startWorker()

      // #then CrdtPreflight's crash must not inherit the embedding worker's phase
      expect(getEmbeddingWorkerPhase('CrdtPreflight')).toBeNull()
      expect(getEmbeddingWorkerPhase(undefined)).toBeNull()
    })

    it('reports in_flight while a request is outstanding', async () => {
      await startWorker()

      // #then a crash here costs the user this note's semantic-search indexing
      expect(getEmbeddingWorkerPhase('Embeddings')).toBe('in_flight')
    })

    it('reports idle once the embedding has been delivered', async () => {
      const { pending } = await startWorker()
      const request = mockUtilityProcessInstance.postMessage.mock.calls[0]?.[0] as {
        requestId: string
      }
      mockUtilityProcessInstance.simulateMessage({
        type: 'embed-result',
        requestId: request.requestId,
        embedding: Array.from(new Float32Array(EMBEDDING_DIMENSION))
      })
      await expect(pending).resolves.toBeInstanceOf(Float32Array)

      expect(getEmbeddingWorkerPhase('Embeddings')).toBe('idle')
    })

    it('keeps the latched teardown phase after a force-kill clears the handle', async () => {
      await startWorker()

      // #when unloadModel() force-kills the worker, `process` is nulled at once
      // while child-process-gone lands a tick later
      unloadModel()

      // #then the crash still reads as a teardown death, not a spontaneous one
      expect(getEmbeddingWorkerPhase('Embeddings')).toBe('idle_shutdown')
    })

    it('does not leak a teardown latch into the next worker generation', async () => {
      await startWorker()
      unloadModel()

      // #given a second reset with no live worker to kill
      unloadModel()

      // #then a later unrelated crash must not inherit the stale latch
      expect(getEmbeddingWorkerPhase('Embeddings')).toBeNull()
    })
  })

  describe('embedding failure visibility', () => {
    it('reports failed embeddings so silent loss of indexing is measurable', async () => {
      const embeddingPromise = generateEmbedding('content long enough for embeddings')

      mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
      await vi.waitFor(() => {
        expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(1)
      })

      // #when the worker dies outright, rejecting the in-flight request
      mockUtilityProcessInstance.emit('exit', 11)
      await expect(embeddingPromise).resolves.toBeNull()

      // #then the failure reaches telemetry instead of only electron-log
      expect(trackMainLogMock).toHaveBeenCalledWith('error', {
        scope: 'Embeddings',
        action: 'embed_failed',
        errorCode: 'Error'
      })
    })

    it('throttles repeated embed failures so a crash loop cannot flood the queue', async () => {
      // #given a broken worker and several notes edited in quick succession
      for (let i = 0; i < 3; i++) {
        const embeddingPromise = generateEmbedding(`content long enough for embeddings ${i}`)
        mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
        await vi.waitFor(() => {
          expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalled()
        })
        mockUtilityProcessInstance.emit('exit', 11)
        await expect(embeddingPromise).resolves.toBeNull()
      }

      // #then only the first embed_failed leaves the process
      const embedFailures = trackMainLogMock.mock.calls.filter(
        (call) => call[1]?.action === 'embed_failed'
      )
      expect(embedFailures).toHaveLength(1)
    })
  })

  describe('worker stderr classification', () => {
    it('treats the transformers.js content-length note as informational', () => {
      expect(
        isInformationalWorkerStderr(
          'Unable to determine content-length from response headers, will expand buffer when needed.'
        )
      ).toBe(true)
    })

    it('treats a real worker failure as an error', () => {
      expect(isInformationalWorkerStderr('Error: ENOSPC: no space left on device')).toBe(false)
    })

    it('keeps a chunk at error when a real failure is interleaved with benign notes', () => {
      const chunk = [
        'Unable to determine content-length from response headers, will expand buffer when needed.',
        'Error: ENOSPC: no space left on device'
      ].join('\n')

      expect(isInformationalWorkerStderr(chunk)).toBe(false)
    })

    it('does not classify an empty chunk as informational', () => {
      expect(isInformationalWorkerStderr('   \n  ')).toBe(false)
    })
  })
})
