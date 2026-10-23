import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsChannels } from '@memry/contracts/ipc-channels'

const mockFork = vi.hoisted(() => vi.fn())
const trackMainLogMock = vi.hoisted(() => vi.fn())
const broadcastMock = vi.hoisted(() => vi.fn())

vi.mock('../telemetry/diagnostics', () => ({
  trackMainLog: trackMainLogMock,
  isChildProcessFault: (reason: string): boolean =>
    reason !== 'clean-exit' && reason !== 'memory-eviction'
}))
vi.mock('./window-broadcast', () => ({ broadcastToAllWindows: broadcastMock }))

class MockUtilityProcess extends EventEmitter {
  postMessage = vi.fn()
  kill = vi.fn(() => true)
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pid = 4321
  simulateMessage(message: unknown): void {
    this.emit('message', message)
  }
}

let worker: MockUtilityProcess

vi.mock('electron', () => ({
  app: { getPath: (name: string) => `/mock/${name}` },
  BrowserWindow: { getAllWindows: () => [] },
  utilityProcess: {
    fork: (...args: unknown[]) => {
      worker = new MockUtilityProcess()
      mockFork(...args)
      return worker
    }
  }
}))

vi.mock('@huggingface/transformers', () => {
  throw new Error('@huggingface/transformers should only load inside embedding-worker')
})

import { resetTelemetryThrottle } from '../telemetry/throttle'
import {
  cancelImageModelLoad,
  EMBEDDING_DIMENSION,
  generateEmbedding,
  generateImageEmbedding,
  getEmbeddingWorkerCrashContext,
  unloadModel
} from './embeddings'

const IMAGE = new Uint8Array([1, 2, 3])

/** Fork the worker, mark it ready, and return the request the bridge sent. */
async function nextRequest(): Promise<{ type: string; requestId: string }> {
  const before = worker?.postMessage.mock.calls.length ?? 0
  worker.simulateMessage({ type: 'ready' })
  await vi.waitFor(() => {
    expect(worker.postMessage.mock.calls.length).toBeGreaterThan(before)
  })
  return worker.postMessage.mock.calls.at(-1)?.[0]
}

describe('image embeddings', () => {
  beforeEach(() => {
    unloadModel()
    mockFork.mockReset()
    trackMainLogMock.mockReset()
    broadcastMock.mockReset()
    resetTelemetryThrottle()
  })

  afterEach(() => {
    unloadModel()
    vi.useRealTimers()
  })

  it('sends the image bytes to the worker and returns the 256d vector', async () => {
    const pending = generateImageEmbedding(IMAGE)
    const request = await nextRequest()
    expect(request).toMatchObject({ type: 'embed-image', image: IMAGE })

    worker.simulateMessage({
      type: 'embed-result',
      requestId: request.requestId,
      embedding: Array.from(new Float32Array(EMBEDDING_DIMENSION).fill(0.5))
    })

    await expect(pending).resolves.toHaveLength(EMBEDDING_DIMENSION)
  })

  it('does not fork a worker for an empty image', async () => {
    await expect(generateImageEmbedding(new Uint8Array())).resolves.toBeNull()
    expect(mockFork).not.toHaveBeenCalled()
  })

  it('forwards encoder download progress tagged as vision and reports it in the crash context', async () => {
    const pending = generateImageEmbedding(IMAGE)
    await nextRequest()
    worker.simulateMessage({
      type: 'progress',
      phase: 'downloading',
      progress: 40,
      status: 'Downloading image model: 40%',
      modality: 'vision'
    })

    expect(broadcastMock).toHaveBeenCalledWith(SettingsChannels.events.EMBEDDING_PROGRESS, {
      phase: 'downloading',
      progress: 40,
      status: 'Downloading image model: 40%',
      modality: 'vision'
    })
    expect(getEmbeddingWorkerCrashContext('Embeddings', 'crashed')).toMatchObject({
      phase: 'in_flight',
      vision: 'loading',
      visionCache: 'absent'
    })
    void pending.catch(() => {})
  })

  it('keeps text embedding and the text circuit breaker out of an image failure', async () => {
    vi.useFakeTimers()
    const image = generateImageEmbedding(IMAGE)
    const request = await nextRequest()
    worker.simulateMessage({ type: 'error', requestId: request.requestId, error: 'offline' })
    await expect(image).resolves.toBeNull()

    // the image path backs off ...
    const posted = worker.postMessage.mock.calls.length
    await expect(generateImageEmbedding(IMAGE)).resolves.toBeNull()
    expect(worker.postMessage.mock.calls.length).toBe(posted)

    // ... while text embedding still reaches the worker
    const text = generateEmbedding('content long enough for embeddings')
    await vi.waitFor(() => {
      expect(worker.postMessage.mock.calls.length).toBe(posted + 1)
    })
    const textRequest = worker.postMessage.mock.calls.at(-1)?.[0]
    expect(textRequest.type).toBe('embed')
    worker.simulateMessage({
      type: 'embed-result',
      requestId: textRequest.requestId,
      embedding: Array.from(new Float32Array(EMBEDDING_DIMENSION).fill(0.5))
    })
    await expect(text).resolves.toBeInstanceOf(Float32Array)
  })

  it('retries images after the backoff window', async () => {
    vi.useFakeTimers()
    const first = generateImageEmbedding(IMAGE)
    const request = await nextRequest()
    worker.simulateMessage({ type: 'error', requestId: request.requestId, error: 'offline' })
    await first

    await vi.advanceTimersByTimeAsync(60_000)
    const second = generateImageEmbedding(IMAGE)
    void second.catch(() => {})
    // the idle shutdown in between recycled the worker, so a fresh one gets the request
    expect((await nextRequest()).type).toBe('embed-image')
  })

  it('cancelling the encoder download stops the worker without counting a failure', async () => {
    const pending = generateImageEmbedding(IMAGE)
    await nextRequest()

    cancelImageModelLoad()

    await expect(pending).resolves.toBeNull()
    expect(worker.kill).toHaveBeenCalled()
    // not a fault: no backoff, so a deliberate retry goes straight through
    const retry = generateImageEmbedding(IMAGE)
    expect(mockFork).toHaveBeenCalledTimes(2)
    void retry.catch(() => {})
  })

  it('ignores a cancel when no encoder download is running', async () => {
    const text = generateEmbedding('content long enough for embeddings')
    await nextRequest()

    cancelImageModelLoad()

    expect(worker.kill).not.toHaveBeenCalled()
    void text.catch(() => {})
  })
})
