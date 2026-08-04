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
  parseNote,
  serializeNote: vi.fn(),
  serializeParsedNote: vi.fn()
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
    // note-1 already has a vector, so the backfill finds no work and only the
    // orphan-prune DELETE runs.
    const prepare = vi.fn(() => ({ run, all: () => [{ note_id: 'note-1' }] }))

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
    // note-1 already embedded → no re-embed
    expect(generateEmbedding).not.toHaveBeenCalled()
  })

  it('defers embedding while indexing and backfills the deferred notes on reconcile', async () => {
    const run = vi.fn()
    const prepare = vi.fn(() => ({ run, all: () => [] as Array<{ note_id: string }> }))
    getRawIndexDatabase.mockReturnValue({ prepare })
    getIndexDatabase.mockReturnValue({
      all: vi.fn(() => [
        { id: 'note-1', path: 'notes/one.md', title: 'One' },
        { id: 'note-2', path: 'notes/two.md', title: 'Two' }
      ])
    })
    getSetting.mockImplementation((_db: unknown, key: string) =>
      key === 'ai.embeddingInputVersion' ? String(EMBEDDING_INPUT_VERSION) : 'true'
    )
    readFile.mockResolvedValue('raw markdown')
    parseNote.mockReturnValue({ content: 'parsed markdown long enough' })

    let indexing = true
    const projector = createEmbeddingProjector(
      () => '/vault',
      () => indexing
    )

    // While indexing, project() must NOT load the model or embed inline.
    await projector.project({
      type: 'note.upserted',
      note: {
        kind: 'markdown',
        noteId: 'note-1',
        title: 'One',
        parsedContent: 'body one long enough'
      }
    } as never)
    await projector.project({
      type: 'note.upserted',
      note: {
        kind: 'markdown',
        noteId: 'note-2',
        title: 'Two',
        parsedContent: 'body two long enough'
      }
    } as never)

    expect(generateEmbedding).not.toHaveBeenCalled()
    expect(initEmbeddingModel).not.toHaveBeenCalled()

    // After indexing, the backgrounded reconcile embeds the deferred notes.
    indexing = false
    await projector.reconcile()

    expect(generateEmbedding).toHaveBeenCalledTimes(2)
    expect(readFile).toHaveBeenCalledWith('/vault/notes/one.md', 'utf-8')
    expect(readFile).toHaveBeenCalledWith('/vault/notes/two.md', 'utf-8')
  })

  it('retains deferred ids when the model fails to load, then embeds them on a later reconcile', async () => {
    const run = vi.fn()
    // note-1 already has a (stale) vector, so it is only in the work list because
    // it was deferred — the missing-vector filter alone would not re-catch it.
    const prepare = vi.fn(() => ({ run, all: () => [{ note_id: 'note-1' }] }))
    getRawIndexDatabase.mockReturnValue({ prepare })
    getIndexDatabase.mockReturnValue({
      all: vi.fn(() => [{ id: 'note-1', path: 'notes/one.md', title: 'One' }])
    })
    getSetting.mockImplementation((_db: unknown, key: string) =>
      key === 'ai.embeddingInputVersion' ? String(EMBEDDING_INPUT_VERSION) : 'true'
    )
    readFile.mockResolvedValue('raw markdown')
    parseNote.mockReturnValue({ content: 'parsed markdown long enough' })

    let indexing = true
    const projector = createEmbeddingProjector(
      () => '/vault',
      () => indexing
    )

    // Defer note-1 during indexing.
    await projector.project({
      type: 'note.upserted',
      note: {
        kind: 'markdown',
        noteId: 'note-1',
        title: 'One',
        parsedContent: 'body one long enough'
      }
    } as never)
    indexing = false

    // First reconcile: the model won't load → the deferred id must be kept, not embedded.
    isModelLoaded.mockReturnValue(false)
    initEmbeddingModel.mockResolvedValueOnce(false)
    await projector.reconcile()
    expect(generateEmbedding).not.toHaveBeenCalled()

    // Second reconcile: the model loads → the retained deferred id is embedded even
    // though it still has a stale vector row.
    initEmbeddingModel.mockResolvedValue(true)
    await projector.reconcile()
    expect(generateEmbedding).toHaveBeenCalledTimes(1)
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
    getAllWindows.mockReturnValue([
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }
    ])
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
