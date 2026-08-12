import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { inboxItems, filingHistory } from '@memry/db-schema/schema/inbox'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { settings } from '@memry/db-schema/schema/settings'
import {
  createTestDatabase,
  createTestIndexDb,
  cleanupTestDatabase,
  type TestDatabaseResult
} from '@tests/utils/test-db'

const mockIsModelLoaded = vi.hoisted(() => vi.fn())
const mockInitEmbeddingModel = vi.hoisted(() => vi.fn())
const mockGenerateEmbedding = vi.hoisted(() => vi.fn())
const mockGetNoteById = vi.hoisted(() => vi.fn())
const mockGetConfig = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [])
  }
}))

vi.mock('../database', () => ({
  getDatabase: vi.fn(),
  requireDatabase: vi.fn(),
  getIndexDatabase: vi.fn(),
  getRawIndexDatabase: vi.fn()
}))

vi.mock('../lib/embeddings', () => ({
  generateEmbedding: mockGenerateEmbedding,
  isModelLoaded: mockIsModelLoaded,
  initEmbeddingModel: mockInitEmbeddingModel
}))

vi.mock('../vault/notes', () => ({
  getNoteById: mockGetNoteById
}))

vi.mock('../vault', () => ({
  getConfig: mockGetConfig
}))

import { getDatabase, requireDatabase, getIndexDatabase, getRawIndexDatabase } from '../database'
import {
  deleteNoteEmbedding,
  getEmbeddingCount,
  getNoteFolderSuggestions,
  getSuggestionStats,
  getSuggestions,
  hasEmbedding,
  reindexAllEmbeddings,
  storeNoteEmbedding,
  trackSuggestionFeedback,
  updateNoteEmbedding
} from './suggestions'

function createRawDbMock() {
  const statement = {
    run: vi.fn(),
    get: vi.fn(),
    all: vi.fn()
  }
  return {
    rawDb: {
      prepare: vi.fn(() => statement)
    },
    statement
  }
}

describe('inbox suggestions', () => {
  let testDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDatabase()
    indexDb = createTestIndexDb()
    vi.mocked(getDatabase).mockReturnValue(testDb.db)
    vi.mocked(requireDatabase).mockReturnValue(testDb.db)
    vi.mocked(getIndexDatabase).mockReturnValue(indexDb.db)

    mockIsModelLoaded.mockReset()
    mockGenerateEmbedding.mockReset()
    mockInitEmbeddingModel.mockReset()
    mockGetNoteById.mockReset()
    mockGetConfig.mockReturnValue({
      excludePatterns: [],
      defaultNoteFolder: 'notes',
      journalFolder: 'journal',
      attachmentsFolder: 'attachments'
    })
  })

  afterEach(() => {
    cleanupTestDatabase(testDb)
    cleanupTestDatabase(indexDb)
    vi.clearAllMocks()
  })

  // ==========================================================================
  // T608: suggestion generation, ranking, dedupe
  // ==========================================================================
  it('generates ranked suggestions from filing history and recents', async () => {
    const now = new Date().toISOString()

    testDb.db
      .insert(inboxItems)
      .values({
        id: 'item-1',
        type: 'link',
        title: 'Interesting link',
        content: 'Some content',
        createdAt: now,
        modifiedAt: now
      })
      .run()

    testDb.db
      .insert(filingHistory)
      .values([
        {
          id: 'fh-1',
          itemType: 'link',
          itemContent: 'content',
          filedTo: 'notes/projects/ProjectA/note.md',
          filedAction: 'folder',
          tags: ['work'],
          filedAt: now
        },
        {
          id: 'fh-2',
          itemType: 'link',
          itemContent: 'content',
          filedTo: 'notes/projects/ProjectA/note.md',
          filedAction: 'folder',
          tags: ['work'],
          filedAt: now
        },
        {
          id: 'fh-3',
          itemType: 'link',
          itemContent: 'content',
          filedTo: 'notes/archive/note.md',
          filedAction: 'folder',
          tags: ['archive'],
          filedAt: now
        },
        {
          id: 'fh-4',
          itemType: 'note',
          itemContent: 'content',
          filedTo: 'notes/recent/note.md',
          filedAction: 'folder',
          tags: [],
          filedAt: now
        }
      ])
      .run()

    mockIsModelLoaded.mockReturnValue(false)

    const suggestions = await getSuggestions('item-1')

    expect(suggestions).toHaveLength(3)
    expect(suggestions[0]?.destination.path).toBe('notes/projects/ProjectA')
    expect(suggestions[0]?.suggestedTags).toEqual(['work'])
    expect(suggestions[1]?.destination.path).toBe('notes/archive')
    expect(suggestions[2]?.destination.path).toBe('notes/recent')

    expect(suggestions[0].confidence).toBeGreaterThan(suggestions[1].confidence)
    expect(suggestions[1].confidence).toBeGreaterThan(suggestions[2].confidence)
  })

  // ==========================================================================
  // T609: source mapping (recent, tags, project folders)
  // ==========================================================================
  it('maps filing history paths to folder destinations and tags', async () => {
    const now = new Date().toISOString()

    testDb.db
      .insert(inboxItems)
      .values({
        id: 'item-2',
        type: 'link',
        title: 'Another link',
        content: 'content',
        createdAt: now,
        modifiedAt: now
      })
      .run()

    testDb.db
      .insert(filingHistory)
      .values({
        id: 'fh-5',
        itemType: 'link',
        itemContent: 'content',
        filedTo: 'notes/projects/ProjectB/note.md',
        filedAction: 'folder',
        tags: ['alpha', 'beta'],
        filedAt: now
      })
      .run()

    mockIsModelLoaded.mockReturnValue(false)

    const suggestions = await getSuggestions('item-2')

    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]?.destination.path).toBe('notes/projects/ProjectB')
    expect(suggestions[0]?.suggestedTags).toEqual(['alpha', 'beta'])
  })

  it('returns empty suggestions when AI is disabled or item is missing', async () => {
    testDb.db.insert(settings).values({ key: 'ai.enabled', value: 'false' }).run()

    const disabled = await getSuggestions('missing')
    expect(disabled).toEqual([])

    testDb.db.delete(settings).run()
    const missing = await getSuggestions('missing')
    expect(missing).toEqual([])
  })

  it('stores, checks, deletes, and counts note embeddings through sqlite-vec', () => {
    const { rawDb, statement } = createRawDbMock()
    vi.mocked(getRawIndexDatabase).mockReturnValue(rawDb as never)

    storeNoteEmbedding('note-1', new Float32Array([0.1, 0.2]))
    expect(rawDb.prepare).toHaveBeenCalledWith('DELETE FROM vec_notes WHERE note_id = ?')
    expect(rawDb.prepare).toHaveBeenCalledWith(
      'INSERT INTO vec_notes (note_id, embedding) VALUES (?, ?)'
    )
    expect(statement.run).toHaveBeenCalledWith('note-1')
    expect(statement.run).toHaveBeenCalledWith('note-1', new Float32Array([0.1, 0.2]))

    statement.get.mockReturnValueOnce({ '1': 1 })
    expect(hasEmbedding('note-1')).toBe(true)

    statement.get.mockReturnValueOnce(undefined)
    expect(hasEmbedding('missing')).toBe(false)

    statement.get.mockReturnValueOnce({ count: 4 })
    expect(getEmbeddingCount()).toBe(4)

    deleteNoteEmbedding('note-1')
    expect(rawDb.prepare).toHaveBeenCalledWith('DELETE FROM vec_notes WHERE note_id = ?')
  })

  it('updates and reindexes embeddings only for eligible notes', async () => {
    const { rawDb, statement } = createRawDbMock()
    vi.mocked(getRawIndexDatabase).mockReturnValue(rawDb as never)
    mockIsModelLoaded.mockReturnValue(false)
    mockInitEmbeddingModel.mockResolvedValue(true)
    mockGenerateEmbedding.mockResolvedValue(new Float32Array([0.1, 0.2]))
    mockGetNoteById.mockImplementation(async (id: string) => {
      if (id === 'short') return { id, path: 'notes/short.md', title: 'Short', content: 'tiny' }
      return {
        id,
        path: `notes/${id}.md`,
        title: id,
        content: 'long enough note content'
      }
    })

    expect(await updateNoteEmbedding('note-1')).toBe(true)
    expect(mockGenerateEmbedding).toHaveBeenCalledWith('long enough note content')
    expect(statement.run).toHaveBeenCalledWith('note-1', new Float32Array([0.1, 0.2]))

    indexDb.db
      .insert(noteCache)
      .values([
        {
          id: 'note-1',
          path: 'notes/note-1.md',
          title: 'Note 1',
          createdAt: '2026-05-09T00:00:00.000Z',
          modifiedAt: '2026-05-09T00:00:00.000Z'
        },
        {
          id: 'short',
          path: 'notes/short.md',
          title: 'Short',
          createdAt: '2026-05-09T00:00:00.000Z',
          modifiedAt: '2026-05-09T00:00:00.000Z'
        }
      ])
      .run()

    const result = await reindexAllEmbeddings()

    expect(result).toEqual({ success: true, computed: 1, skipped: 1 })
    expect(mockInitEmbeddingModel).toHaveBeenCalledTimes(1)
    expect(rawDb.prepare).toHaveBeenCalledWith('DELETE FROM vec_notes')
  })

  it('combines similar-note folder and direct-note suggestions when model starts cold', async () => {
    const now = new Date().toISOString()
    const { rawDb, statement } = createRawDbMock()
    statement.all.mockReturnValue([
      { note_id: 'note-match', distance: 0.2 },
      { note_id: 'note-too-far', distance: 1.5 }
    ])
    vi.mocked(getRawIndexDatabase).mockReturnValue(rawDb as never)
    mockIsModelLoaded.mockReturnValue(false)
    mockGenerateEmbedding.mockResolvedValue(new Float32Array([0.1, 0.2]))

    testDb.db
      .insert(inboxItems)
      .values({
        id: 'item-similar',
        type: 'link',
        title: 'Research memo',
        content: 'long enough content for matching',
        createdAt: now,
        modifiedAt: now
      })
      .run()
    indexDb.db
      .insert(noteCache)
      .values({
        id: 'note-match',
        path: 'notes/research/memo.md',
        title: 'Memo',
        snippet: 'Existing memo snippet',
        emoji: 'M',
        createdAt: now,
        modifiedAt: now
      })
      .run()

    const suggestions = await getSuggestions('item-similar')

    expect(mockGenerateEmbedding).toHaveBeenCalledWith(
      'Research memo\n\nlong enough content for matching'
    )
    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          destination: { type: 'folder', path: 'notes/research' },
          reason: 'Similar to "Memo" in notes/research'
        }),
        expect.objectContaining({
          destination: { type: 'note', noteId: 'note-match', noteTitle: 'Memo' },
          suggestedNote: expect.objectContaining({
            id: 'note-match',
            snippet: 'Existing memo snippet'
          })
        })
      ])
    )
  })

  it('tracks feedback stats and suggests folders for moving notes', async () => {
    const now = new Date().toISOString()
    mockIsModelLoaded.mockReturnValue(false)
    mockGetNoteById.mockResolvedValue({
      id: 'note-current',
      path: 'notes/current/today.md',
      title: 'Today',
      content: 'long enough content'
    })

    trackSuggestionFeedback('item-1', 'link', 'research', 'research', 0.87, ['work'], ['work'])
    trackSuggestionFeedback('item-2', 'link', 'research', 'archive', 0.32)

    expect(getSuggestionStats()).toEqual({
      totalSuggestions: 2,
      acceptedCount: 1,
      rejectedCount: 1,
      acceptanceRate: 0.5
    })

    testDb.db
      .insert(filingHistory)
      .values([
        {
          id: 'note-history-1',
          itemType: 'note',
          itemContent: 'note',
          filedTo: 'notes/research/old.md',
          filedAction: 'folder',
          tags: [],
          filedAt: now
        },
        {
          id: 'note-history-2',
          itemType: 'link',
          itemContent: 'link',
          filedTo: 'notes/recent/link.md',
          filedAction: 'folder',
          tags: [],
          filedAt: now
        }
      ])
      .run()

    const folders = await getNoteFolderSuggestions('note-current')

    expect(folders.map((folder) => folder.path)).toEqual(['notes/research', 'notes/recent'])
    expect(folders[0]?.reason).toBe("You've moved 1 notes here before")
  })

  it('returns safe fallbacks when settings, raw vec storage, or model loading fail', async () => {
    vi.mocked(getDatabase).mockImplementation(() => {
      throw new Error('closed')
    })
    expect(await updateNoteEmbedding('note-closed')).toBe(false)
    expect(await reindexAllEmbeddings()).toEqual({
      success: false,
      computed: 0,
      skipped: 0,
      error: 'AI is disabled'
    })
    expect(await getSuggestions('item-closed')).toEqual([])
    expect(await getNoteFolderSuggestions('note-closed')).toEqual([])

    vi.mocked(getDatabase).mockReturnValue(testDb.db)
    vi.mocked(getRawIndexDatabase).mockImplementation(() => {
      throw new Error('raw unavailable')
    })
    expect(hasEmbedding('missing')).toBe(false)
    expect(getEmbeddingCount()).toBe(0)
    expect(() => deleteNoteEmbedding('missing')).not.toThrow()

    mockIsModelLoaded.mockReturnValue(false)
    mockInitEmbeddingModel.mockResolvedValue(false)
    expect(await reindexAllEmbeddings()).toEqual({
      success: false,
      computed: 0,
      skipped: 0,
      error: 'Failed to load embedding model'
    })
  })

  it('suggests note move folders from similar notes while excluding the current folder', async () => {
    const now = new Date().toISOString()
    const { rawDb, statement } = createRawDbMock()
    statement.all.mockReturnValue([
      { note_id: 'same-folder', distance: 0.1 },
      { note_id: 'root-note', distance: 0.2 },
      { note_id: 'other-folder', distance: 0.4 }
    ])
    vi.mocked(getRawIndexDatabase).mockReturnValue(rawDb as never)
    mockIsModelLoaded.mockReturnValue(true)
    mockGenerateEmbedding.mockResolvedValue(new Float32Array([0.1, 0.2]))
    mockGetNoteById.mockResolvedValue({
      id: 'current',
      path: 'notes/current/today.md',
      title: 'Current',
      content: 'long enough current note content'
    })

    indexDb.db
      .insert(noteCache)
      .values([
        {
          id: 'same-folder',
          path: 'notes/current/related.md',
          title: 'Same Folder',
          snippet: 'same',
          createdAt: now,
          modifiedAt: now
        },
        {
          id: 'root-note',
          path: 'notes/root.md',
          title: 'Root Note',
          snippet: 'root',
          createdAt: now,
          modifiedAt: now
        },
        {
          id: 'other-folder',
          path: 'notes/archive/old.md',
          title: 'Archive Note',
          snippet: 'archive',
          createdAt: now,
          modifiedAt: now
        }
      ])
      .run()

    const folders = await getNoteFolderSuggestions('current')

    expect(folders).toEqual([
      expect.objectContaining({
        path: 'notes',
        reason: 'Similar to "Root Note" in notes'
      }),
      expect.objectContaining({
        path: 'notes/archive',
        reason: 'Similar to "Archive Note" in notes/archive'
      })
    ])
  })

  // ==========================================================================
  // Folder-centric scoring (end-to-end through getSuggestions)
  // ==========================================================================
  it('ranks a clustered folder above a single-fluke folder end-to-end', async () => {
    const now = new Date().toISOString()
    const { rawDb, statement } = createRawDbMock()
    // 'misc' is the single closest hit; 'recipes' has three solid hits.
    statement.all.mockReturnValue([
      { note_id: 'misc-x', distance: 0.2 },
      { note_id: 'rec-a', distance: 0.3 },
      { note_id: 'rec-b', distance: 0.3 },
      { note_id: 'rec-c', distance: 0.3 }
    ])
    vi.mocked(getRawIndexDatabase).mockReturnValue(rawDb as never)
    mockIsModelLoaded.mockReturnValue(true)
    mockGenerateEmbedding.mockResolvedValue(new Float32Array([0.1, 0.2]))

    testDb.db
      .insert(inboxItems)
      .values({
        id: 'item-pasta',
        type: 'link',
        title: 'Dinner',
        content: 'cook something with tomato',
        createdAt: now,
        modifiedAt: now
      })
      .run()
    indexDb.db
      .insert(noteCache)
      .values([
        { id: 'misc-x', path: 'notes/misc/x.md', title: 'X', createdAt: now, modifiedAt: now },
        { id: 'rec-a', path: 'notes/recipes/a.md', title: 'A', createdAt: now, modifiedAt: now },
        { id: 'rec-b', path: 'notes/recipes/b.md', title: 'B', createdAt: now, modifiedAt: now },
        { id: 'rec-c', path: 'notes/recipes/c.md', title: 'C', createdAt: now, modifiedAt: now }
      ])
      .run()

    const suggestions = await getSuggestions('item-pasta')
    const folders = suggestions.filter((s) => s.destination.type === 'folder')

    expect(folders[0]?.destination.path).toBe('notes/recipes')
    expect(folders.find((f) => f.destination.path === 'notes/misc')?.confidence ?? 1).toBeLessThan(
      folders[0]!.confidence
    )
  })

  it('suggests a folder by name match when there is no embedding hit', async () => {
    const now = new Date().toISOString()
    const { rawDb, statement } = createRawDbMock()
    statement.all.mockReturnValue([])
    vi.mocked(getRawIndexDatabase).mockReturnValue(rawDb as never)
    mockIsModelLoaded.mockReturnValue(false)
    // generateEmbedding unmocked → undefined → no similarity hits (cold start).

    testDb.db
      .insert(inboxItems)
      .values({
        id: 'item-rec',
        type: 'link',
        title: 'Recipes',
        content: 'pasta night ideas',
        createdAt: now,
        modifiedAt: now
      })
      .run()
    indexDb.db
      .insert(noteCache)
      .values({
        id: 'r1',
        path: 'notes/recipes/old.md',
        title: 'Old',
        createdAt: now,
        modifiedAt: now
      })
      .run()

    const suggestions = await getSuggestions('item-rec')
    const folders = suggestions.filter((s) => s.destination.type === 'folder')

    expect(folders.some((f) => f.destination.path === 'notes/recipes')).toBe(true)
  })

  it('suppresses a folder whose only hit is below the confidence floor', async () => {
    const now = new Date().toISOString()
    const { rawDb, statement } = createRawDbMock()
    // distance 0.9 → similarity 0.55 → lone-hit 0.55*0.7 = 0.385 < 0.45 floor.
    statement.all.mockReturnValue([{ note_id: 'w1', distance: 0.9 }])
    vi.mocked(getRawIndexDatabase).mockReturnValue(rawDb as never)
    mockIsModelLoaded.mockReturnValue(true)
    mockGenerateEmbedding.mockResolvedValue(new Float32Array([0.1, 0.2]))

    testDb.db
      .insert(inboxItems)
      .values({
        id: 'item-weak',
        type: 'link',
        title: 'Zzz',
        content: 'unrelated musings here',
        createdAt: now,
        modifiedAt: now
      })
      .run()
    indexDb.db
      .insert(noteCache)
      .values({ id: 'w1', path: 'notes/qqq/w.md', title: 'W', createdAt: now, modifiedAt: now })
      .run()

    const suggestions = await getSuggestions('item-weak')
    const folders = suggestions.filter((s) => s.destination.type === 'folder')

    expect(folders.find((f) => f.destination.path === 'qqq')).toBeUndefined()
  })
})
