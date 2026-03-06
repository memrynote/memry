import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'path'
import { SettingsChannels } from '@memry/contracts/ipc-channels'
import { mockApp, MockBrowserWindow } from '@tests/utils/mock-electron'
import { BrowserWindow } from 'electron'

const mockPipeline = vi.fn()
const mockEnv = { cacheDir: '' }

vi.mock('electron', () => ({
  app: mockApp,
  BrowserWindow: {
    getAllWindows: vi.fn()
  }
}))

vi.mock('@huggingface/transformers', () => ({
  pipeline: mockPipeline,
  env: mockEnv
}))

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
    mockPipeline.mockReset()
    mockEnv.cacheDir = ''
    mockApp.getPath.mockImplementation((name: string) =>
      name === 'userData' ? '/mock/user-data' : `/mock/${name}`
    )
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([])
  })

  afterEach(() => {
    unloadModel()
    vi.clearAllMocks()
  })

  it('loads the model, configures cache dir, and emits progress events', async () => {
    const window = new MockBrowserWindow()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window])

    const mockExtractor = vi.fn().mockResolvedValue({
      data: new Float32Array(EMBEDDING_DIMENSION)
    })

    mockPipeline.mockImplementationOnce(async (_task, _model, options) => {
      options?.progress_callback?.({ status: 'progress', progress: 42 })
      options?.progress_callback?.({ status: 'done' })
      return mockExtractor
    })

    const result = await initEmbeddingModel()

    expect(result).toBe(true)
    expect(mockEnv.cacheDir).toBe(path.join('/mock/user-data', 'models', 'transformers'))
    expect(getModelInfo().loaded).toBe(true)

    const phases = window.webContents.send.mock.calls
      .filter(([channel]) => channel === SettingsChannels.events.EMBEDDING_PROGRESS)
      .map(([, payload]) => (payload as { phase: string }).phase)

    expect(phases).toEqual(expect.arrayContaining(['loading', 'downloading', 'ready']))
  })

  it('returns false and surfaces errors when model load fails', async () => {
    const window = new MockBrowserWindow()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window])

    mockPipeline.mockImplementationOnce(async () => {
      throw new Error('load failed')
    })

    const result = await initEmbeddingModel()

    expect(result).toBe(false)
    expect(getModelInfo().error).toBe('load failed')

    expect(window.webContents.send).toHaveBeenCalledWith(
      SettingsChannels.events.EMBEDDING_PROGRESS,
      expect.objectContaining({ phase: 'error' })
    )
  })

  it('tracks loading state and unloads the model', async () => {
    const mockExtractor = vi.fn()
    let resolvePipeline: () => void
    const pipelineReady = new Promise<void>((resolve) => {
      resolvePipeline = resolve
    })

    mockPipeline.mockImplementationOnce(async () => {
      await pipelineReady
      return mockExtractor
    })

    const loading = initEmbeddingModel()
    expect(isModelLoading()).toBe(true)

    resolvePipeline!()
    await loading

    expect(isModelLoading()).toBe(false)
    expect(isModelLoaded()).toBe(true)

    unloadModel()
    expect(isModelLoaded()).toBe(false)
  })

  it('returns null for text below the minimum length', async () => {
    const result = await generateEmbedding('short')
    expect(result).toBeNull()
  })

  it('truncates long text and returns an embedding', async () => {
    const mockExtractor = vi.fn().mockResolvedValue({
      data: new Float32Array(EMBEDDING_DIMENSION)
    })

    mockPipeline.mockImplementationOnce(async () => mockExtractor)

    const longText = 'a'.repeat(2500)
    const embedding = await generateEmbedding(longText)

    expect(embedding).toBeInstanceOf(Float32Array)
    expect(embedding?.length).toBe(EMBEDDING_DIMENSION)
    expect(mockExtractor).toHaveBeenCalled()

    const [inputText] = mockExtractor.mock.calls[0]
    expect(typeof inputText).toBe('string')
    expect((inputText as string).length).toBe(2000)
  })

  it('returns null when embedding dimension is unexpected', async () => {
    const mockExtractor = vi.fn().mockResolvedValue({
      data: new Float32Array(10)
    })

    mockPipeline.mockImplementationOnce(async () => mockExtractor)

    const embedding = await generateEmbedding('this is long enough for embeddings')

    expect(embedding).toBeNull()
  })
})
