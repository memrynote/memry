import { EventEmitter } from 'events'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMBEDDING_DIMENSION } from './embeddings-constants'

const mockPipeline = vi.hoisted(() => vi.fn())
const mockEnv = vi.hoisted(() => ({ cacheDir: '' }))

class MockParentPort extends EventEmitter {
  postMessage = vi.fn()
}

vi.mock('@huggingface/transformers', () => ({
  pipeline: mockPipeline,
  env: mockEnv
}))

vi.mock('./logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

describe('embedding worker', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-embedding-worker-'))
    process.env.MEMRY_USER_DATA_PATH = tempDir
    mockPipeline.mockReset()
    mockEnv.cacheDir = ''
  })

  afterEach(() => {
    Reflect.deleteProperty(process, 'parentPort')
    Reflect.deleteProperty(process.env, 'MEMRY_USER_DATA_PATH')
    fs.rmSync(tempDir, { recursive: true, force: true })
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('announces ready through process.parentPort on startup', async () => {
    const port = new MockParentPort()
    Object.defineProperty(process, 'parentPort', {
      configurable: true,
      writable: true,
      value: port
    })

    await import('./embedding-worker')

    expect(port.postMessage).toHaveBeenCalledWith({ type: 'ready' })
  })

  it('loads the feature-extraction pipeline and returns a serializable embedding', async () => {
    const port = new MockParentPort()
    Object.defineProperty(process, 'parentPort', {
      configurable: true,
      writable: true,
      value: port
    })

    const mockExtractor = vi.fn().mockResolvedValue({
      data: new Float32Array(EMBEDDING_DIMENSION)
    })
    mockPipeline.mockImplementationOnce(async (_task, _model, options) => {
      options?.progress_callback?.({ status: 'progress', progress: 42 })
      options?.progress_callback?.({ status: 'done' })
      return mockExtractor
    })

    await import('./embedding-worker')

    port.emit('message', {
      data: {
        type: 'embed',
        requestId: 'req-1',
        text: 'a'.repeat(2500)
      }
    })

    await vi.waitFor(() => {
      expect(port.postMessage).toHaveBeenCalledWith({
        type: 'embed-result',
        requestId: 'req-1',
        embedding: Array.from(new Float32Array(EMBEDDING_DIMENSION))
      })
    })

    expect(mockEnv.cacheDir).toBe(path.join(tempDir, 'models', 'transformers'))
    expect(mockPipeline).toHaveBeenCalledWith(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2',
      expect.objectContaining({
        dtype: 'fp32'
      })
    )
    expect(mockExtractor).toHaveBeenCalledWith('a'.repeat(2000), {
      pooling: 'mean',
      normalize: true
    })
  })
})
