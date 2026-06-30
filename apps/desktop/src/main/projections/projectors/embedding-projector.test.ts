import { beforeEach, describe, expect, it, vi } from 'vitest'

const getDatabase = vi.hoisted(() => vi.fn())
const getIndexDatabase = vi.hoisted(() => vi.fn())
const getRawIndexDatabase = vi.hoisted(() => vi.fn())
const getSetting = vi.hoisted(() => vi.fn())
const generateEmbedding = vi.hoisted(() => vi.fn())
const initEmbeddingModel = vi.hoisted(() => vi.fn())
const isModelLoaded = vi.hoisted(() => vi.fn())
const getAllWindows = vi.hoisted(() => vi.fn())
const readFile = vi.hoisted(() => vi.fn())
const parseNote = vi.hoisted(() => vi.fn())

vi.mock('../../database', () => ({
  getDatabase,
  getIndexDatabase,
  getRawIndexDatabase
}))

vi.mock('fs/promises', () => ({
  default: { readFile },
  readFile
}))

vi.mock('@main/database/queries/settings', () => ({
  getSetting
}))

vi.mock('../../vault/frontmatter', () => ({
  parseNote
}))

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
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
import { EMBEDDING_INPUT_VERSION } from '../../lib/embedding-input'

describe('embedding projector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAllWindows.mockReturnValue([])
    getDatabase.mockReturnValue({})
    getSetting.mockReturnValue('true')
    isModelLoaded.mockReturnValue(true)
    initEmbeddingModel.mockResolvedValue(true)
    generateEmbedding.mockResolvedValue(new Float32Array([0.1, 0.2]))
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

    // Embedding input version already current → skip the migration rebuild and
    // exercise only the stale-row reconcile delete.
    getSetting.mockImplementation((_db: unknown, key: string) =>
      key === 'ai.embeddingInputVersion' ? String(EMBEDDING_INPUT_VERSION) : 'true'
    )

    getRawIndexDatabase.mockReturnValue({ prepare })
    getIndexDatabase.mockReturnValue({
      all: vi.fn(() => [{ id: 'note-1' }])
    })

    const projector = createEmbeddingProjector(() => '/vault')

    await projector.reconcile()

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM vec_notes'))
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('handles note events by storing, deleting, or skipping embeddings', async () => {
    const run = vi.fn()
    const prepare = vi.fn(() => ({ run }))
    getRawIndexDatabase.mockReturnValue({ prepare })

    const projector = createEmbeddingProjector(() => '/vault')

    expect(projector.handles({ type: 'note.upserted' } as never)).toBe(true)
    expect(projector.handles({ type: 'note.deleted', noteId: 'note-1' } as never)).toBe(true)
    expect(projector.handles({ type: 'task.updated' } as never)).toBe(false)

    await projector.project({
      type: 'note.upserted',
      note: {
        kind: 'markdown',
        noteId: 'note-1',
        parsedContent: 'long enough markdown body'
      }
    } as never)

    expect(generateEmbedding).toHaveBeenCalledWith('long enough markdown body')
    expect(prepare).toHaveBeenCalledWith('DELETE FROM vec_notes WHERE note_id = ?')
    expect(prepare).toHaveBeenCalledWith('INSERT INTO vec_notes (note_id, embedding) VALUES (?, ?)')
    expect(run).toHaveBeenCalledWith('note-1', new Float32Array([0.1, 0.2]))

    await projector.project({
      type: 'note.upserted',
      note: {
        kind: 'attachment',
        noteId: 'note-2',
        parsedContent: 'ignored attachment content'
      }
    } as never)
    await projector.project({ type: 'note.deleted', noteId: 'note-3' } as never)
    await projector.project({ type: 'calendar.changed' } as never)

    expect(run).toHaveBeenCalledWith('note-2')
    expect(run).toHaveBeenCalledWith('note-3')
  })

  it('deletes stale embeddings when AI is disabled, content is short, or generation fails', async () => {
    const run = vi.fn()
    getRawIndexDatabase.mockReturnValue({ prepare: vi.fn(() => ({ run })) })

    const projector = createEmbeddingProjector(() => '/vault')

    await projector.project({
      type: 'note.upserted',
      note: { kind: 'markdown', noteId: 'short-note', parsedContent: 'short' }
    } as never)

    getSetting.mockReturnValue('false')
    await projector.project({
      type: 'note.upserted',
      note: { kind: 'markdown', noteId: 'disabled-note', parsedContent: 'long enough content' }
    } as never)

    getSetting.mockReturnValue('true')
    generateEmbedding.mockResolvedValueOnce(null)
    await projector.project({
      type: 'note.upserted',
      note: { kind: 'markdown', noteId: 'null-note', parsedContent: 'long enough content' }
    } as never)

    expect(run).toHaveBeenCalledWith('short-note')
    expect(run).toHaveBeenCalledWith('disabled-note')
    expect(run).not.toHaveBeenCalledWith('null-note', expect.anything())
  })

  it('rebuilds markdown note embeddings and reports skipped files', async () => {
    const run = vi.fn()
    const prepare = vi.fn(() => ({ run }))
    const send = vi.fn()
    getAllWindows.mockReturnValue([{ webContents: { send } }])
    getRawIndexDatabase.mockReturnValue({ prepare })
    getIndexDatabase.mockReturnValue({
      all: vi.fn(() => [
        { id: 'note-1', path: 'notes/one.md', fileType: 'markdown' },
        { id: 'note-2', path: 'notes/two.md', fileType: 'markdown' }
      ])
    })
    isModelLoaded.mockReturnValue(false)
    readFile.mockResolvedValueOnce('raw markdown').mockRejectedValueOnce(new Error('missing'))
    parseNote.mockReturnValue({ content: 'parsed markdown long enough' })

    const projector = createEmbeddingProjector(() => '/vault')

    await expect(projector.rebuild()).resolves.toEqual({
      success: true,
      computed: 1,
      skipped: 1
    })
    expect(initEmbeddingModel).toHaveBeenCalled()
    expect(readFile).toHaveBeenCalledWith('/vault/notes/one.md', 'utf-8')
    expect(prepare).toHaveBeenCalledWith('DELETE FROM vec_notes')
    expect(send).toHaveBeenCalledWith(
      'settings:embeddingProgress',
      expect.objectContaining({ phase: 'complete', current: 2, total: 2 })
    )
  })

  it('reports rebuild setup failures before scanning notes', async () => {
    await expect(createEmbeddingProjector(() => null).rebuild()).resolves.toEqual({
      success: false,
      computed: 0,
      skipped: 0,
      error: 'No vault is open'
    })

    isModelLoaded.mockReturnValue(false)
    initEmbeddingModel.mockResolvedValue(false)

    await expect(createEmbeddingProjector(() => '/vault').rebuild()).resolves.toEqual({
      success: false,
      computed: 0,
      skipped: 0,
      error: 'Failed to load embedding model'
    })
  })
})
