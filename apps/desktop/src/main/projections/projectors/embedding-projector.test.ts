import { describe, expect, it, vi, beforeEach } from 'vitest'

const getDatabase = vi.hoisted(() => vi.fn())
const getIndexDatabase = vi.hoisted(() => vi.fn())
const getRawIndexDatabase = vi.hoisted(() => vi.fn())
const getSetting = vi.hoisted(() => vi.fn())
const generateEmbedding = vi.hoisted(() => vi.fn())
const initEmbeddingModel = vi.hoisted(() => vi.fn())
const isModelLoaded = vi.hoisted(() => vi.fn())
const getAllWindows = vi.hoisted(() => vi.fn())

vi.mock('../../database', () => ({
  getDatabase,
  getIndexDatabase,
  getRawIndexDatabase
}))

vi.mock('@main/database/queries/settings', () => ({
  getSetting
}))

vi.mock('../../lib/embeddings', () => ({
  generateEmbedding,
  initEmbeddingModel,
  isModelLoaded
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows
  }
}))

import { createEmbeddingProjector } from './embedding-projector'

describe('embedding projector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAllWindows.mockReturnValue([])
  })

  it('rebuild returns a disabled result when AI embeddings are turned off', async () => {
    getDatabase.mockReturnValue({})
    getSetting.mockReturnValue('false')

    const projector = createEmbeddingProjector(() => '/vault')

    await expect(projector.rebuild()).resolves.toEqual({
      success: false,
      computed: 0,
      skipped: 0,
      error: 'AI is disabled'
    })
  })

  it('reconcile removes embeddings for notes that no longer exist', async () => {
    const run = vi.fn()
    const prepare = vi.fn(() => ({ run }))

    getRawIndexDatabase.mockReturnValue({ prepare })
    getIndexDatabase.mockReturnValue({
      all: vi.fn(() => [{ id: 'note-1' }])
    })

    const projector = createEmbeddingProjector(() => '/vault')

    await projector.reconcile()

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM vec_notes'))
    expect(run).toHaveBeenCalledTimes(1)
  })
})
