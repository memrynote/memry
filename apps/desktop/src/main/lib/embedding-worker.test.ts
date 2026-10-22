import { EventEmitter } from 'events'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMBEDDING_DIMENSION } from './embeddings-constants'

const mockModelLoad = vi.hoisted(() => vi.fn())
const mockTokenizerLoad = vi.hoisted(() => vi.fn())
const mockConfigLoad = vi.hoisted(() => vi.fn())
const mockProcessorLoad = vi.hoisted(() => vi.fn())
const mockFromBlob = vi.hoisted(() => vi.fn())
const mockEnv = vi.hoisted(() => ({ cacheDir: '' }))

class MockParentPort extends EventEmitter {
  postMessage = vi.fn()
}

vi.mock('@huggingface/transformers', () => ({
  AutoConfig: { from_pretrained: mockConfigLoad },
  AutoModel: { from_pretrained: mockModelLoad },
  AutoTokenizer: { from_pretrained: mockTokenizerLoad },
  AutoProcessor: { from_pretrained: mockProcessorLoad },
  RawImage: { fromBlob: mockFromBlob },
  env: mockEnv
}))

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
}))

vi.mock('./logger', () => ({
  createLogger: () => mockLogger
}))

describe('embedding worker', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-embedding-worker-'))
    process.env.MEMRY_USER_DATA_PATH = tempDir
    mockModelLoad.mockReset()
    mockTokenizerLoad.mockReset()
    mockConfigLoad.mockReset()
    mockProcessorLoad.mockReset()
    mockFromBlob.mockReset()
    mockConfigLoad.mockImplementation(async () => ({
      vision_config: {},
      audio_config: {},
      text_config: {}
    }))
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

  describe('image encoder', () => {
    const start = (): MockParentPort => {
      const port = new MockParentPort()
      Object.defineProperty(process, 'parentPort', {
        configurable: true,
        writable: true,
        value: port
      })
      return port
    }
    const output = (fill: number) => ({
      sentence_embedding: { data: new Float32Array(768).fill(fill) }
    })

    it('never loads the processor or the encoder for text-only use', async () => {
      const port = start()
      const model = Object.assign(vi.fn().mockResolvedValue(output(1)), { dispose: vi.fn() })
      mockModelLoad.mockResolvedValue(model)
      await import('./embedding-worker')

      port.emit('message', { data: { type: 'embed', requestId: 't1', text: 'hello world text' } })
      await vi.waitFor(() =>
        expect(port.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'embed-result', requestId: 't1' })
        )
      )

      expect(mockProcessorLoad).not.toHaveBeenCalled()
      expect(mockModelLoad.mock.calls[0][1].config.vision_config).toBeNull()
    })

    it('upgrades to the vision model on the first image, frees the text-only model, and reuses it after', async () => {
      const port = start()
      const textOnly = Object.assign(vi.fn().mockResolvedValue(output(1)), { dispose: vi.fn() })
      const withVision = Object.assign(vi.fn().mockResolvedValue(output(2)), { dispose: vi.fn() })
      mockModelLoad.mockResolvedValueOnce(textOnly).mockResolvedValueOnce(withVision)
      const processor = Object.assign(vi.fn().mockResolvedValue({ pixel_values: 'px' }), {
        image_processor: { max_soft_tokens: 280 }
      })
      mockProcessorLoad.mockResolvedValue(processor)
      mockFromBlob.mockResolvedValue('raw-image')
      await import('./embedding-worker')

      port.emit('message', { data: { type: 'load-model', requestId: 'l1' } })
      await vi.waitFor(() =>
        expect(port.postMessage).toHaveBeenCalledWith({
          type: 'load-model-result',
          requestId: 'l1'
        })
      )

      port.emit('message', {
        data: { type: 'embed-image', requestId: 'i1', image: new Uint8Array([1, 2, 3]) }
      })
      await vi.waitFor(() =>
        expect(port.postMessage).toHaveBeenCalledWith({
          type: 'embed-result',
          requestId: 'i1',
          embedding: Array.from(new Float32Array(EMBEDDING_DIMENSION).fill(1 / 16))
        })
      )

      expect(mockModelLoad.mock.calls[1][1].config).toMatchObject({ audio_config: null })
      expect(mockModelLoad.mock.calls[1][1].config.vision_config).not.toBeNull()
      expect(processor.image_processor.max_soft_tokens).toBe(140)
      expect(processor).toHaveBeenCalledWith(null, 'raw-image')
      expect(withVision).toHaveBeenCalledWith({ pixel_values: 'px' })
      expect(textOnly.dispose).toHaveBeenCalledTimes(1)
      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'progress', phase: 'ready', modality: 'vision' })
      )

      // Text now runs on the vision-enabled model; nothing is loaded twice.
      port.emit('message', { data: { type: 'embed', requestId: 't2', text: 'hello world text' } })
      await vi.waitFor(() =>
        expect(port.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'embed-result', requestId: 't2' })
        )
      )
      expect(withVision).toHaveBeenCalledTimes(2)
      expect(mockModelLoad).toHaveBeenCalledTimes(2)
    })

    it('keeps the text model working when the encoder download fails', async () => {
      const port = start()
      const textOnly = Object.assign(vi.fn().mockResolvedValue(output(1)), { dispose: vi.fn() })
      mockModelLoad.mockResolvedValueOnce(textOnly).mockRejectedValueOnce(new Error('network down'))
      mockProcessorLoad.mockResolvedValue(vi.fn())
      await import('./embedding-worker')

      port.emit('message', { data: { type: 'load-model', requestId: 'l1' } })
      await vi.waitFor(() =>
        expect(port.postMessage).toHaveBeenCalledWith({
          type: 'load-model-result',
          requestId: 'l1'
        })
      )
      port.emit('message', {
        data: { type: 'embed-image', requestId: 'i1', image: new Uint8Array([1]) }
      })
      await vi.waitFor(() =>
        expect(port.postMessage).toHaveBeenCalledWith({
          type: 'error',
          requestId: 'i1',
          error: 'network down'
        })
      )
      expect(textOnly.dispose).not.toHaveBeenCalled()

      port.emit('message', { data: { type: 'embed', requestId: 't1', text: 'hello world text' } })
      await vi.waitFor(() =>
        expect(port.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'embed-result', requestId: 't1' })
        )
      )
    })
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
        expect(mockLogger.warn).toHaveBeenCalledWith(
          'Embedding worker disposal did not settle; exiting'
        )
      } finally {
        vi.useRealTimers()
        exit.mockRestore()
      }
    })

    // Windows keeps onnxruntime threads alive after a clean dispose, so this
    // fallback runs on every idle shutdown. At warn it reached the worker's
    // console, which main relays as error-level stderr (#3280).
    it('exits quietly when disposal settled but the loop stayed open', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
      const port = new MockParentPort()
      await loadWorker(port, vi.fn().mockResolvedValue(undefined))
      mockLogger.warn.mockClear()

      vi.useFakeTimers()
      try {
        port.emit('message', { data: { type: 'shutdown' } })
        await vi.advanceTimersByTimeAsync(1_500)
        expect(exit).toHaveBeenCalledWith(0)
        expect(mockLogger.warn).not.toHaveBeenCalled()
        expect(mockLogger.error).not.toHaveBeenCalled()
        expect(mockLogger.info).toHaveBeenCalledWith('Embedding worker exiting after disposal')
      } finally {
        vi.useRealTimers()
        exit.mockRestore()
      }
    })
  })
})
