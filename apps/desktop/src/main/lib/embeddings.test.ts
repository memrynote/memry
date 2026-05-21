import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import { SettingsChannels } from '@memry/contracts/ipc-channels'

const mockApp = vi.hoisted(() => ({
  getPath: vi.fn((name: string) => `/mock/${name}`)
}))
const getAllWindows = vi.hoisted(() => vi.fn())
const mockFork = vi.hoisted(() => vi.fn())

class MockUtilityProcess extends EventEmitter {
  postMessage = vi.fn()
  kill = vi.fn().mockReturnValue(true)
  stdout = null
  stderr = null
  pid = 1234

  simulateMessage(message: unknown): void {
    this.emit('message', message)
  }
}

class MockBrowserWindow {
  webContents = {
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

import {
  EMBEDDING_DIMENSION,
  generateEmbedding,
  getModelInfo,
  initEmbeddingModel,
  isModelLoaded,
  isModelLoading,
  unloadModel
} from './embeddings'

describe('embeddings', () => {
  beforeEach(() => {
    unloadModel()
    mockFork.mockReset()
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
})
