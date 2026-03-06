import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { inboxItems, filingHistory } from '@memry/db-schema/schema/inbox'
import { settings } from '@memry/db-schema/schema/settings'
import {
  createTestDatabase,
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

import { getDatabase } from '../database'
import { getSuggestions } from './suggestions'

describe('inbox suggestions', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDatabase()
    vi.mocked(getDatabase).mockReturnValue(testDb.db)

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
    expect(suggestions[0]?.destination.path).toBe('projects/ProjectA')
    expect(suggestions[0]?.suggestedTags).toEqual(['work'])
    expect(suggestions[1]?.destination.path).toBe('archive')
    expect(suggestions[2]?.destination.path).toBe('recent')

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
    expect(suggestions[0]?.destination.path).toBe('projects/ProjectB')
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
})
