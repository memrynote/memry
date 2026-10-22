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
const readExtractedOpening = vi.hoisted(() => vi.fn())
const getNoteCacheById = vi.hoisted(() => vi.fn())

vi.mock('../../database', () => ({
  getDatabase,
  getIndexDatabase,
  getRawIndexDatabase
}))

vi.mock('../../lib/paths', () => ({
  readVaultFile: (vault: string, relativePath: string) =>
    readFile(`${vault}/${relativePath}`, 'utf-8')
}))

vi.mock('@main/database/queries/settings', () => ({
  getSetting,
  setSetting
}))

vi.mock('@main/database/queries/extracted-text', () => ({
  readExtractedOpening
}))

vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById
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

/** Stands in for better-sqlite3: transactions run inline and unmocked reads find nothing. */
function mockRawDb(db: { prepare: (statement: string) => object }): void {
  getRawIndexDatabase.mockReturnValue({
    prepare: (statement: string) => ({ get: () => undefined, ...db.prepare(statement) }),
    transaction: (fn: () => void) => fn
  })
}

describe('embedding projector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAllWindows.mockReturnValue([])
    getDatabase.mockReturnValue({})
    getSetting.mockReturnValue('true')
    isModelLoaded.mockReturnValue(true)
    initEmbeddingModel.mockResolvedValue(true)
    generateEmbedding.mockResolvedValue(new Float32Array([0.1, 0.2]))
    readExtractedOpening.mockReturnValue('')
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

    mockRawDb({ prepare })
    getIndexDatabase.mockReturnValue({
      all: vi.fn(() => [{ id: 'note-1' }])
    })

    const projector = createEmbeddingProjector(() => '/vault')

    await projector.reconcile()

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM vec_notes'))
    // vec_notes + vec_note_similar + note_embedding_state prune
    expect(run).toHaveBeenCalledTimes(3)
    // note-1 already embedded → no re-embed
    expect(generateEmbedding).not.toHaveBeenCalled()
  })

  it('defers embedding while indexing and backfills the deferred notes on reconcile', async () => {
    const run = vi.fn()
    const prepare = vi.fn(() => ({ run, all: () => [] as Array<{ note_id: string }> }))
    mockRawDb({ prepare })
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

    expect(generateEmbedding).toHaveBeenCalledTimes(4)
    expect(readFile).toHaveBeenCalledWith('/vault/notes/one.md', 'utf-8')
    expect(readFile).toHaveBeenCalledWith('/vault/notes/two.md', 'utf-8')
  })

  it('retains deferred ids when the model fails to load, then embeds them on a later reconcile', async () => {
    const run = vi.fn()
    // note-1 already has a (stale) vector, so it is only in the work list because
    // it was deferred — the missing-vector filter alone would not re-catch it.
    const prepare = vi.fn(() => ({ run, all: () => [{ note_id: 'note-1' }] }))
    mockRawDb({ prepare })
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
    expect(generateEmbedding).toHaveBeenCalledTimes(2)
  })

  it('handles note events by storing, deleting, or skipping embeddings', async () => {
    const run = vi.fn()
    const prepare = vi.fn(() => ({ run }))
    mockRawDb({ prepare })

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

    expect(generateEmbedding).toHaveBeenCalledWith('title: none | text: long enough markdown body')
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

  it('embeds a filed PDF from its extracted text and drops the vector once the text is gone', async () => {
    const run = vi.fn()
    mockRawDb({ prepare: vi.fn(() => ({ run })) })
    getNoteCacheById.mockReturnValue({ id: 'pdf-1', title: 'Logbook', fileType: 'pdf' })
    readExtractedOpening.mockReturnValue('The heron left the marsh at dawn')

    const projector = createEmbeddingProjector(() => '/vault')
    await projector.project({ type: 'note.text-extracted', noteId: 'pdf-1' })

    expect(generateEmbedding).toHaveBeenCalledWith(
      'title: Logbook | text: The heron left the marsh at dawn'
    )
    expect(run).toHaveBeenCalledWith('pdf-1', new Float32Array([0.1, 0.2]))

    readExtractedOpening.mockReturnValue('')
    run.mockClear()
    await projector.project({ type: 'note.text-extracted', noteId: 'pdf-1' })

    expect(run).toHaveBeenCalledWith('pdf-1')
    expect(run).not.toHaveBeenCalledWith('pdf-1', expect.anything())
  })

  it('embeds a markdown note with the text read from its attachments after its body', async () => {
    const run = vi.fn()
    mockRawDb({ prepare: vi.fn(() => ({ run })) })
    getNoteCacheById.mockReturnValue({
      id: 'note-1',
      path: 'notes/trip.md',
      title: 'Trip',
      fileType: 'markdown'
    })
    readFile.mockResolvedValue('raw note')
    parseNote.mockReturnValue({ content: 'Packing list for the coast' })
    readExtractedOpening.mockReturnValue('Ferry ticket 7:40 to the estuary')

    const projector = createEmbeddingProjector(() => '/vault')
    await projector.project({ type: 'note.text-extracted', noteId: 'note-1' })

    expect(generateEmbedding).toHaveBeenCalledWith(
      'title: Trip | text: Packing list for the coast\n\nFerry ticket 7:40 to the estuary'
    )
    expect(run).toHaveBeenCalledWith('note-1', new Float32Array([0.1, 0.2]))
  })

  it('defers a filed PDF while the vault is indexing, then embeds it from its text in a rebuild', async () => {
    const run = vi.fn()
    mockRawDb({ prepare: vi.fn(() => ({ run })) })
    getIndexDatabase.mockReturnValue({
      all: vi.fn(() => [
        { id: 'pdf-1', path: 'files/logbook.pdf', title: 'Logbook', fileType: 'pdf' }
      ])
    })
    readExtractedOpening.mockReturnValue('The heron left the marsh at dawn')
    let indexing = true
    const projector = createEmbeddingProjector(
      () => '/vault',
      () => indexing
    )

    await projector.project({
      type: 'note.upserted',
      note: { kind: 'file', noteId: 'pdf-1', title: 'Logbook' }
    } as never)
    expect(generateEmbedding).not.toHaveBeenCalled()

    indexing = false
    await expect(projector.rebuild()).resolves.toEqual({ success: true, computed: 1, skipped: 0 })
    expect(generateEmbedding).toHaveBeenCalledWith(
      'title: Logbook | text: The heron left the marsh at dawn'
    )
    expect(readFile).not.toHaveBeenCalled()
  })

  it('deletes stale embeddings when AI is disabled, content is short, or generation fails', async () => {
    const run = vi.fn()
    mockRawDb({ prepare: vi.fn(() => ({ run })) })

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
    mockRawDb({ prepare })
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
    mockRawDb({ prepare })
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

    expect(generateEmbedding).toHaveBeenCalledTimes(2)
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

  it('re-embeds stale vectors in the background without ever emptying vec_notes, and resumes after a quit', async () => {
    // A small stand-in for vec_notes and note_embedding_state.
    const vectors = new Set<string>()
    const state = new Map<string, number>()
    const prepare = vi.fn((statement: string) => ({
      run: (noteId?: string, version?: number) => {
        if (statement === 'DELETE FROM vec_notes') vectors.clear()
        else if (statement.startsWith('DELETE FROM vec_notes WHERE note_id'))
          vectors.delete(noteId!)
        else if (statement.startsWith('INSERT INTO vec_notes')) vectors.add(noteId!)
        else if (statement.startsWith('INSERT OR REPLACE INTO note_embedding_state'))
          state.set(noteId!, version!)
      },
      all: () =>
        statement.includes('note_embedding_state')
          ? [...state].map(([note_id]) => ({ note_id }))
          : [...vectors].map((note_id) => ({ note_id }))
    }))
    mockRawDb({ prepare })
    getIndexDatabase.mockReturnValue({
      all: vi.fn(() => [
        { id: 'note-1', path: 'notes/one.md', title: 'One', fileType: 'markdown' },
        { id: 'note-2', path: 'notes/two.md', title: 'Two', fileType: 'markdown' },
        { id: 'note-3', path: 'notes/three.md', title: 'Three', fileType: 'markdown' }
      ])
    })
    // Vectors written under the previous input formula: no state rows.
    vectors.add('note-1').add('note-2').add('note-3')
    getSetting.mockImplementation(() => 'true')
    readFile.mockResolvedValue('raw markdown')
    parseNote.mockReturnValue({ content: 'parsed markdown long enough' })

    // The app quits right after the first note of the re-embed.
    const controller = new AbortController()
    generateEmbedding.mockImplementation(async () => {
      controller.abort()
      return new Float32Array([0.1, 0.2])
    })
    await createEmbeddingProjector(() => '/vault').reconcile(controller.signal)

    // Old vectors keep serving search and similarity meanwhile.
    expect([...vectors].sort()).toEqual(['note-1', 'note-2', 'note-3'])
    expect([...state.keys()]).toEqual(['note-1'])

    // The next launch re-embeds only the notes the first pass never reached.
    generateEmbedding.mockResolvedValue(new Float32Array([0.1, 0.2]))
    await createEmbeddingProjector(() => '/vault').reconcile()

    expect(generateEmbedding).toHaveBeenCalledTimes(6)
    expect(readFile.mock.calls.filter(([path]) => path === '/vault/notes/one.md')).toHaveLength(1)
    expect([...vectors].sort()).toEqual(['note-1', 'note-2', 'note-3'])
    expect([...state.values()]).toEqual([
      EMBEDDING_INPUT_VERSION,
      EMBEDDING_INPUT_VERSION,
      EMBEDDING_INPUT_VERSION
    ])
  })

  it('skips the backfill when the signal aborts while the model is loading', async () => {
    const run = vi.fn()
    const prepare = vi.fn(() => ({ run, all: () => [] as Array<{ note_id: string }> }))
    mockRawDb({ prepare })
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
    mockRawDb({ prepare })
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
