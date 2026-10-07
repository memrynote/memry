import { EventEmitter } from 'events'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMBEDDING_DIMENSION } from './embeddings-constants'

const mockModelLoad = vi.hoisted(() => vi.fn())
const mockTokenizerLoad = vi.hoisted(() => vi.fn())
const mockConfigLoad = vi.hoisted(() => vi.fn())
const mockEnv = vi.hoisted(() => ({ cacheDir: '' }))

class MockParentPort extends EventEmitter {
  postMessage = vi.fn()
}

vi.mock('@huggingface/transformers', () => ({
  AutoConfig: { from_pretrained: mockConfigLoad },
  AutoModel: { from_pretrained: mockModelLoad },
  AutoTokenizer: { from_pretrained: mockTokenizerLoad },
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
    mockModelLoad.mockReset()
    mockTokenizerLoad.mockReset()
    mockConfigLoad.mockReset()
    mockConfigLoad.mockResolvedValue({ vision_config: {}, audio_config: {}, text_config: {} })
    mockTokenizerLoad.mockResolvedValue(vi.fn().mockReturnValue({ input_ids: 'ids' }))
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

  it('loads only the text model and returns a 256d re-normalized embedding', async () => {
    const port = new MockParentPort()
    Object.defineProperty(process, 'parentPort', {
      configurable: true,
      writable: true,
      value: port
    })

    // 768d output whose first 256 dims are all 2: truncation then
    // re-normalization must give 1/sqrt(256) = 1/16 everywhere.
    const full = new Float32Array(768).fill(0.5)
    full.fill(2, 0, EMBEDDING_DIMENSION)
    const model = Object.assign(vi.fn().mockResolvedValue({ sentence_embedding: { data: full } }), {
      dispose: vi.fn()
    })
    const tokenizer = vi.fn().mockReturnValue({ input_ids: 'ids' })
    mockTokenizerLoad.mockResolvedValue(tokenizer)
    mockModelLoad.mockImplementationOnce(async (_model, options) => {
      options?.progress_callback?.({
        status: 'progress',
        file: 'onnx/model_q4.onnx_data',
        loaded: 42,
        total: 100
      })
      options?.progress_callback?.({ status: 'done' })
      return model
    })

    await import('./embedding-worker')

    port.emit('message', {
      data: {
        type: 'embed',
        requestId: 'req-1',
        text: 'a'.repeat(4500)
      }
    })

    await vi.waitFor(() => {
      expect(port.postMessage).toHaveBeenCalledWith({
        type: 'embed-result',
        requestId: 'req-1',
        embedding: Array.from(new Float32Array(EMBEDDING_DIMENSION).fill(1 / 16))
      })
    })

    expect(mockEnv.cacheDir).toBe(path.join(tempDir, 'models', 'transformers'))
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'progress',
      phase: 'downloading',
      progress: 42,
      status: 'Downloading model: 42%'
    })
    const [repo, options] = mockModelLoad.mock.calls[0]
    expect(repo).toBe('onnx-community/embeddinggemma-2-ONNX')
    expect(options).toMatchObject({ dtype: 'q4', device: 'cpu' })
    // Text only: without these sections no vision/audio session is built or downloaded.
    expect(options.config).toMatchObject({ vision_config: null, audio_config: null })
    expect(tokenizer).toHaveBeenCalledWith(['a'.repeat(4000)], { padding: true, truncation: true })
  })

  describe('shutdown', () => {
    const loadWorker = async (
      port: MockParentPort,
      dispose: () => Promise<unknown>
    ): Promise<void> => {
      Object.defineProperty(process, 'parentPort', {
        configurable: true,
        writable: true,
        value: port
      })
      const model = Object.assign(vi.fn(), { dispose })
      mockModelLoad.mockResolvedValue(model)

      await import('./embedding-worker')
      port.emit('message', { data: { type: 'load-model', requestId: 'load-1' } })
      await vi.waitFor(() => {
        expect(port.postMessage).toHaveBeenCalledWith({
          type: 'load-model-result',
          requestId: 'load-1'
        })
      })
    }

    // `process.exit()` under a loaded onnxruntime skips JS cleanup and runs the
    // native static destructors with sessions still live, which aborts with
    // SIGABRT after the worker's own clean exit 0 (#1990).
    it('disposes the pipeline and lets the loop drain instead of exiting hard', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
      const dispose = vi.fn().mockResolvedValue(undefined)
      const port = new MockParentPort()
      await loadWorker(port, dispose)

      port.emit('message', { data: { type: 'shutdown' } })

      await vi.waitFor(() => {
        expect(dispose).toHaveBeenCalledTimes(1)
      })
      expect(exit).not.toHaveBeenCalled()
      // Electron's ParentPort pauses itself once the last 'message' listener is
      // gone, releasing the handle that keeps this process alive.
      expect(port.listenerCount('message')).toBe(0)
      exit.mockRestore()
    })

    // The main process force-kills at 3s, and a kill mid-teardown is exactly the
    // death this fix exists to avoid, so the worker has to give up first.
    it('falls back to exiting when disposal never settles', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
      const dispose = vi.fn().mockReturnValue(new Promise<void>(() => {}))
      const port = new MockParentPort()
      await loadWorker(port, dispose)

      vi.useFakeTimers()
      try {
        port.emit('message', { data: { type: 'shutdown' } })
        await vi.advanceTimersByTimeAsync(1_499)
        expect(exit).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(1)
        expect(exit).toHaveBeenCalledWith(0)
      } finally {
        vi.useRealTimers()
        exit.mockRestore()
      }
    })
  })
})
