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
  cancelAudioModelLoad,
  EMBEDDING_DIMENSION,
  generateEmbedding,
  generateAudioEmbedding,
  getEmbeddingWorkerCrashContext,
  unloadModel
} from './embeddings'

const AUDIO = new Float32Array([0.1, 0.2, 0.3])

/** Fork the worker, mark it ready, and return the request the bridge sent. */
async function nextRequest(): Promise<{ type: string; requestId: string }> {
  const before = worker?.postMessage.mock.calls.length ?? 0
  worker.simulateMessage({ type: 'ready' })
  await vi.waitFor(() => expect(worker.postMessage.mock.calls.length).toBeGreaterThan(before))
  return worker.postMessage.mock.calls.at(-1)?.[0]
}

describe('audio embeddings', () => {
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

  it('sends the samples to the worker and returns the 256d vector', async () => {
    const pending = generateAudioEmbedding(AUDIO)
    const request = await nextRequest()
    expect(request).toMatchObject({ type: 'embed-audio', audio: AUDIO })

    worker.simulateMessage({
      type: 'embed-result',
      requestId: request.requestId,
      embedding: Array.from(new Float32Array(EMBEDDING_DIMENSION).fill(0.5))
    })

    await expect(pending).resolves.toHaveLength(EMBEDDING_DIMENSION)
  })

  it('does not fork a worker for empty audio', async () => {
    await expect(generateAudioEmbedding(new Float32Array())).resolves.toBeNull()
    expect(mockFork).not.toHaveBeenCalled()
  })

  it('forwards encoder download progress tagged as audio and reports it in the crash context', async () => {
    const pending = generateAudioEmbedding(AUDIO)
    await nextRequest()
    worker.simulateMessage({
      type: 'progress',
      phase: 'downloading',
      progress: 40,
      status: 'Downloading audio model: 40%',
      modality: 'audio'
    })

    expect(broadcastMock).toHaveBeenCalledWith(SettingsChannels.events.EMBEDDING_PROGRESS, {
      phase: 'downloading',
      progress: 40,
      status: 'Downloading audio model: 40%',
      modality: 'audio'
    })
    expect(getEmbeddingWorkerCrashContext('Embeddings', 'crashed')).toMatchObject({
      phase: 'in_flight',
      audio: 'loading',
      audioCache: 'absent',
      vision: 'off'
    })
    void pending.catch(() => {})
  })

  it('keeps text embedding out of an audio failure and backs the audio path off', async () => {
    vi.useFakeTimers()
    const audio = generateAudioEmbedding(AUDIO)
    const request = await nextRequest()
    worker.simulateMessage({ type: 'error', requestId: request.requestId, error: 'offline' })
    await expect(audio).resolves.toBeNull()

    const posted = worker.postMessage.mock.calls.length
    await expect(generateAudioEmbedding(AUDIO)).resolves.toBeNull()
    expect(worker.postMessage.mock.calls.length).toBe(posted)

    const text = generateEmbedding('content long enough for embeddings')
    await vi.waitFor(() => expect(worker.postMessage.mock.calls.length).toBe(posted + 1))
    const textRequest = worker.postMessage.mock.calls.at(-1)?.[0]
    expect(textRequest.type).toBe('embed')
    worker.simulateMessage({
      type: 'embed-result',
      requestId: textRequest.requestId,
      embedding: Array.from(new Float32Array(EMBEDDING_DIMENSION).fill(0.5))
    })
    await expect(text).resolves.toBeInstanceOf(Float32Array)
  })

  it('cancelling the audio download stops the worker without counting a failure', async () => {
    const pending = generateAudioEmbedding(AUDIO)
    await nextRequest()

    cancelAudioModelLoad()

    await expect(pending).resolves.toBeNull()
    expect(worker.kill).toHaveBeenCalled()
    const retry = generateAudioEmbedding(AUDIO)
    expect(mockFork).toHaveBeenCalledTimes(2)
    void retry.catch(() => {})
  })
})
