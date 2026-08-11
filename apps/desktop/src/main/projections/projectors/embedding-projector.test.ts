import { beforeEach, describe, expect, it, vi } from 'vitest'

const getDatabase = vi.hoisted(() => vi.fn())
const getIndexDatabase = vi.hoisted(() => vi.fn())
const getRawIndexDatabase = vi.hoisted(() => vi.fn())
const getSetting = vi.hoisted(() => vi.fn())
const setSetting = vi.hoisted(() => vi.fn())
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
  getSetting,
  setSetting
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
import { createProjectionRuntime } from '../runtime'

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

  it('stops the backfill when the reconcile signal aborts and keeps the unreached notes deferred', async () => {
    const run = vi.fn()
    const prepare = vi.fn(() => ({ run, all: () => [] as Array<{ note_id: string }> }))
    getRawIndexDatabase.mockReturnValue({ prepare })
    getIndexDatabase.mockReturnValue({
      all: vi.fn(() => [
        { id: 'note-1', path: 'notes/one.md', title: 'One' },
        { id: 'note-2', path: 'notes/two.md', title: 'Two' },
        { id: 'note-3', path: 'notes/three.md', title: 'Three' }
      ])
    })
    getSetting.mockImplementation((_db: unknown, key: string) =>
      key === 'ai.embeddingInputVersion' ? String(EMBEDDING_INPUT_VERSION) : 'true'
    )
    readFile.mockResolvedValue('raw markdown')
    parseNote.mockReturnValue({ content: 'parsed markdown long enough' })

    // Aborts the moment the first note is embedded, i.e. exactly where a vault
    // close or switch lands: mid work list.
    const controller = new AbortController()
    generateEmbedding.mockImplementation(async () => {
      controller.abort()
      return new Float32Array([0.1, 0.2])
    })

    const projector = createEmbeddingProjector(() => '/vault')

    await projector.reconcile(controller.signal)

    expect(generateEmbedding).toHaveBeenCalledTimes(1)
    expect(readFile).toHaveBeenCalledWith('/vault/notes/one.md', 'utf-8')
    // The notes past the abort were never read, so nothing from this vault can
    // land in whatever index database the next vault installs.
    expect(readFile).not.toHaveBeenCalledWith('/vault/notes/two.md', 'utf-8')
    expect(run).not.toHaveBeenCalledWith('note-2', expect.anything())

    // The work is owed, not lost: a later reconcile picks the rest up.
    generateEmbedding.mockResolvedValue(new Float32Array([0.1, 0.2]))
    await projector.reconcile()
    expect(readFile).toHaveBeenCalledWith('/vault/notes/two.md', 'utf-8')
    expect(readFile).toHaveBeenCalledWith('/vault/notes/three.md', 'utf-8')
  })

  it('does not load the model when the reconcile signal is already aborted', async () => {
    isModelLoaded.mockReturnValue(false)
    const controller = new AbortController()
    controller.abort()

    const projector = createEmbeddingProjector(() => '/vault')

    await projector.reconcile(controller.signal)

    expect(initEmbeddingModel).not.toHaveBeenCalled()
    expect(getRawIndexDatabase).not.toHaveBeenCalled()
    expect(generateEmbedding).not.toHaveBeenCalled()
  })

  it('does not stamp the embedding input version when the migration rebuild aborts', async () => {
    const run = vi.fn()
    const prepare = vi.fn(() => ({ run, all: () => [] as Array<{ note_id: string }> }))
    getRawIndexDatabase.mockReturnValue({ prepare })
    getIndexDatabase.mockReturnValue({
      all: vi.fn(() => [{ id: 'note-1', path: 'notes/one.md', title: 'One', fileType: 'markdown' }])
    })
    // Stored version is stale → reconcile takes the full-rebuild migration path.
    getSetting.mockImplementation((_db: unknown, key: string) =>
      key === 'ai.embeddingInputVersion' ? 'stale' : 'true'
    )

    const controller = new AbortController()
    isModelLoaded.mockReturnValue(false)
    initEmbeddingModel.mockImplementation(async () => {
      controller.abort()
      return true
    })

    const projector = createEmbeddingProjector(() => '/vault')

    await projector.reconcile(controller.signal)

    // Aborting after the (slow) model load must not wipe the vector table it is
    // no longer going to refill, and must not record the migration as done.
    expect(prepare).not.toHaveBeenCalledWith('DELETE FROM vec_notes')
    expect(setSetting).not.toHaveBeenCalled()
    expect(generateEmbedding).not.toHaveBeenCalled()
  })

  it('does not stamp the embedding input version when the migration rebuild aborts mid-list', async () => {
    const run = vi.fn()
    const prepare = vi.fn(() => ({ run, all: () => [] as Array<{ note_id: string }> }))
    getRawIndexDatabase.mockReturnValue({ prepare })
    getIndexDatabase.mockReturnValue({
      all: vi.fn(() => [
        { id: 'note-1', path: 'notes/one.md', title: 'One', fileType: 'markdown' },
        { id: 'note-2', path: 'notes/two.md', title: 'Two', fileType: 'markdown' }
      ])
    })
    getSetting.mockImplementation((_db: unknown, key: string) =>
      key === 'ai.embeddingInputVersion' ? 'stale' : 'true'
    )
    readFile.mockResolvedValue('raw markdown')
    parseNote.mockReturnValue({ content: 'parsed markdown long enough' })

    const controller = new AbortController()
    generateEmbedding.mockImplementation(async () => {
      controller.abort()
      return new Float32Array([0.1, 0.2])
    })

    const projector = createEmbeddingProjector(() => '/vault')

    await projector.reconcile(controller.signal)

    // A half-finished rebuild must not record the new input version: doing so
    // would permanently skip the migration for the notes it never reached.
    expect(generateEmbedding).toHaveBeenCalledTimes(1)
    expect(setSetting).not.toHaveBeenCalled()
  })

  it('skips the backfill when the signal aborts while the model is loading', async () => {
    const run = vi.fn()
    const prepare = vi.fn(() => ({ run, all: () => [] as Array<{ note_id: string }> }))
    getRawIndexDatabase.mockReturnValue({ prepare })
    getIndexDatabase.mockReturnValue({
      all: vi.fn(() => [{ id: 'note-1', path: 'notes/one.md', title: 'One' }])
    })
    getSetting.mockImplementation((_db: unknown, key: string) =>
      key === 'ai.embeddingInputVersion' ? String(EMBEDDING_INPUT_VERSION) : 'true'
    )

    // The load is the multi-second step, so a close landing inside it is the
    // common case — the work list must not be embedded once it returns.
    const controller = new AbortController()
    isModelLoaded.mockReturnValue(false)
    initEmbeddingModel.mockImplementation(async () => {
      controller.abort()
      return true
    })

    const projector = createEmbeddingProjector(() => '/vault')

    await projector.reconcile(controller.signal)

    expect(initEmbeddingModel).toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
    expect(generateEmbedding).not.toHaveBeenCalled()
  })

  it('lets the projection runtime stop without waiting for a large backfill', async () => {
    const noteCount = 200
    const run = vi.fn()
    const prepare = vi.fn(() => ({ run, all: () => [] as Array<{ note_id: string }> }))
    getRawIndexDatabase.mockReturnValue({ prepare })
    getIndexDatabase.mockReturnValue({
      all: vi.fn(() =>
        Array.from({ length: noteCount }, (_, index) => ({
          id: `note-${index}`,
          path: `notes/${index}.md`,
          title: `Note ${index}`
        }))
      )
    })
    getSetting.mockImplementation((_db: unknown, key: string) =>
      key === 'ai.embeddingInputVersion' ? String(EMBEDDING_INPUT_VERSION) : 'true'
    )
    readFile.mockResolvedValue('raw markdown')
    parseNote.mockReturnValue({ content: 'parsed markdown long enough' })

    const runtime = createProjectionRuntime({
      projectors: [createEmbeddingProjector(() => '/vault')]
    })

    const reconciling = runtime.reconcile()
    // Let the pass get inside the work list before the close lands.
    await Promise.resolve()
    await Promise.resolve()

    // closeVault awaits this, and stop() awaits the aborted pass before the
    // caller closes the databases — so an un-abortable backfill would hold the
    // close path open for the whole 200-note list (#803/#805).
    await runtime.stop({ drain: false })
    await reconciling

    expect(generateEmbedding.mock.calls.length).toBeLessThan(noteCount)
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
