import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  isModelLoaded: vi.fn(),
  initEmbeddingModel: vi.fn(),
  generateEmbedding: vi.fn(),
  all: vi.fn()
}))

vi.mock('../database', () => ({
  getDatabase: vi.fn(() => ({})),
  getRawIndexDatabase: vi.fn(() => ({ prepare: () => ({ all: mocks.all }) }))
}))
vi.mock('@main/database/queries/settings', () => ({ getSetting: mocks.getSetting }))
vi.mock('../lib/embeddings', () => ({
  isModelLoaded: mocks.isModelLoaded,
  initEmbeddingModel: mocks.initEmbeddingModel,
  generateEmbedding: mocks.generateEmbedding
}))

import { semanticNoteHits } from './semantic'

describe('semanticNoteHits', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.getSetting.mockReturnValue('true')
    mocks.isModelLoaded.mockReturnValue(true)
    mocks.initEmbeddingModel.mockResolvedValue(true)
    mocks.generateEmbedding.mockResolvedValue(new Float32Array([1, 0]))
  })

  it('embeds the query with the search prefix and drops hits under the query floor', async () => {
    mocks.all.mockReturnValue([
      { note_id: 'near', distance: 0.2 },
      { note_id: 'far', distance: 0.4 }
    ])
    const hits = await semanticNoteHits('cat')
    expect(mocks.generateEmbedding).toHaveBeenCalledWith('task: search result | query: cat')
    expect(hits).toEqual([{ id: 'near', cosine: 0.8 }])
  })

  it('answers empty without embedding for short, operator or AI-off queries', async () => {
    expect(await semanticNoteHits('ab')).toEqual([])
    expect(await semanticNoteHits('cat AND dog')).toEqual([])
    mocks.getSetting.mockReturnValue('false')
    expect(await semanticNoteHits('cat')).toEqual([])
    expect(mocks.generateEmbedding).not.toHaveBeenCalled()
  })

  it('starts the model load instead of waiting for it when the model is cold', async () => {
    mocks.isModelLoaded.mockReturnValue(false)
    expect(await semanticNoteHits('cat')).toEqual([])
    expect(mocks.initEmbeddingModel).toHaveBeenCalledOnce()
    expect(mocks.generateEmbedding).not.toHaveBeenCalled()
  })
})
