import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  isModelLoaded: vi.fn(),
  initEmbeddingModel: vi.fn(),
  generateEmbedding: vi.fn(),
  notes: vi.fn(),
  chunks: vi.fn(),
  images: vi.fn(),
  voice: vi.fn()
}))

vi.mock('../database', () => ({
  getDatabase: vi.fn(() => ({})),
  getRawIndexDatabase: vi.fn(() => ({
    prepare: (sql: string) => ({
      all: sql.includes('vec_images')
        ? mocks.images
        : sql.includes('vec_note_chunks')
          ? mocks.chunks
          : mocks.notes
    })
  }))
}))
vi.mock('../database/voice-vectors', () => ({ nearestVoiceItems: mocks.voice }))
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
    mocks.notes.mockReturnValue([])
    mocks.chunks.mockReturnValue([])
    mocks.images.mockReturnValue([])
    mocks.voice.mockReturnValue([])
  })

  it('embeds the query with the search prefix and drops hits under the query floor', async () => {
    mocks.notes.mockReturnValue([
      { id: 'near', distance: 0.2 },
      { id: 'unrelated', distance: 0.3 }
    ])
    const hits = await semanticNoteHits('cat')
    expect(mocks.generateEmbedding).toHaveBeenCalledWith('task: search result | query: cat')
    expect(hits).toEqual([{ id: 'near', cosine: 0.8 }])
  })

  it('returns the note that owns a near image, under the image floor', async () => {
    mocks.images.mockReturnValue([
      { image_key: 'photo/', distance: 0.3 },
      { image_key: 'note1/cat.jpg', distance: 0.31 },
      { image_key: 'unrelated/', distance: 0.33 }
    ])
    const hits = await semanticNoteHits('cat')
    expect(hits.map((hit) => hit.id)).toEqual(['photo', 'note1'])
    expect(hits[0].cosine).toBeCloseTo(0.745)
  })

  it('keeps the best of a note vector and its image vector', async () => {
    mocks.notes.mockReturnValue([{ id: 'n', distance: 0.2 }])
    mocks.images.mockReturnValue([{ image_key: 'n/a.png', distance: 0.1 }])
    const hits = await semanticNoteHits('cat')
    expect(hits).toHaveLength(1)
    expect(hits[0].cosine).toBeCloseTo(0.945)
  })

  it('keeps note hits when the image query fails', async () => {
    mocks.notes.mockReturnValue([{ id: 'n', distance: 0.2 }])
    mocks.images.mockImplementation(() => {
      throw new Error('no such table: vec_images')
    })
    expect(await semanticNoteHits('cat')).toEqual([{ id: 'n', cosine: 0.8 }])
  })

  it('leaves images out when image embeddings are off', async () => {
    mocks.getSetting.mockImplementation((_db: unknown, key: string) =>
      key === 'ai.imageEmbeddings' ? 'false' : 'true'
    )
    mocks.images.mockReturnValue([{ image_key: 'photo/', distance: 0.1 }])
    expect(await semanticNoteHits('cat')).toEqual([])
  })

  it('adds voice memos, holding transcripts to the text floor and audio to its own', async () => {
    mocks.notes.mockReturnValue([{ id: 'note', distance: 0.25 }])
    mocks.voice.mockReturnValue([
      { id: 'spoken', cosine: 0.74, source: 'transcript' },
      { id: 'mumbled', cosine: 0.7, source: 'transcript' },
      { id: 'clip', cosine: 0.76, source: 'audio' },
      { id: 'faint', cosine: 0.69, source: 'audio' },
      { id: 'noise', cosine: 0.66, source: 'audio' }
    ])
    const hits = await semanticNoteHits('applause')
    expect(hits.map((hit) => hit.id)).toEqual(['clip', 'note', 'spoken', 'faint'])
    expect(hits[0].cosine).toBeCloseTo(0.805)
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
