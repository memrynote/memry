import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TestDatabaseResult, TestDb } from '@tests/utils/test-db'
import { createTestDataDb, createTestIndexDb, sql } from '@tests/utils/test-db'
import type { NewNoteCache, PropertyType } from '@memry/db-schema/schema/notes-cache'
import {
  insertNoteCache,
  updateNoteCache,
  deleteNoteCache,
  getNoteCacheById,
  getNoteCacheByPath,
  noteCacheExists,
  listNotesFromCache,
  countNotes,
  setNoteTags,
  getNoteTags,
  getAllTags,
  findNotesByTag,
  findNotesWithTagInfo,
  pinNoteToTag,
  unpinNoteFromTag,
  renameTag,
  deleteTag,
  removeTagFromNote,
  getOrCreateTag,
  getAllTagDefinitions,
  renameTagDefinition,
  deleteTagDefinition,
  updateTagColor,
  setNoteLinks,
  getOutgoingLinks,
  getIncomingLinks,
  deleteLinksToNote,
  resolveNoteByTitle,
  updateLinkTargets,
  bulkInsertNotes,
  clearNoteCache,
  setNoteProperties,
  getNoteProperties,
  getNotePropertiesAsRecord,
  insertPropertyDefinition,
  updatePropertyDefinition,
  getPropertyDefinition,
  getAllPropertyDefinitions,
  filterNotesByProperty,
  insertNoteSnapshot,
  getNoteSnapshots,
  getLatestSnapshot,
  snapshotExistsWithHash,
  pruneOldSnapshots,
  getJournalEntryByDate,
  journalEntryExistsByDate,
  getHeatmapData,
  getJournalMonthEntries,
  getJournalYearStats,
  getJournalStreak
} from '.'

const BASE_TIME = new Date('2026-01-15T00:00:00.000Z')

describe('notes cache queries', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  const createNote = (id: string, overrides: Partial<NewNoteCache> = {}) => {
    return insertNoteCache(db, {
      id,
      path: overrides.path ?? `notes/${id}.md`,
      title: overrides.title ?? `Note ${id}`,
      emoji: overrides.emoji ?? null,
      contentHash: overrides.contentHash ?? `hash-${id}`,
      wordCount: overrides.wordCount ?? 10,
      characterCount: overrides.characterCount ?? 100,
      date: overrides.date ?? null,
      createdAt: overrides.createdAt ?? '2026-01-10T00:00:00.000Z',
      modifiedAt: overrides.modifiedAt ?? '2026-01-12T00:00:00.000Z'
    })
  }

  beforeEach(() => {
    dbResult = createTestIndexDb()
    db = dbResult.db
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
  })

  afterEach(() => {
    vi.useRealTimers()
    dbResult.close()
  })

  it('inserts and retrieves notes by id and path', () => {
    const note = createNote('note-1', { title: 'First Note' })

    expect(getNoteCacheById(db, note.id)?.title).toBe('First Note')
    expect(getNoteCacheByPath(db, note.path)?.id).toBe(note.id)
  })

  it('updates and deletes notes in cache', () => {
    createNote('note-2', { title: 'Old Title' })
    const updated = updateNoteCache(db, 'note-2', { title: 'New Title' })

    expect(updated?.title).toBe('New Title')
    expect(noteCacheExists(db, 'note-2')).toBe(true)

    deleteNoteCache(db, 'note-2')
    expect(noteCacheExists(db, 'note-2')).toBe(false)
  })

  it('lists notes with pagination, folder, tags, and sorting', () => {
    createNote('note-3', { path: 'projects/note-3.md', modifiedAt: '2026-01-11T00:00:00.000Z' })
    createNote('note-4', { path: 'projects/note-4.md', modifiedAt: '2026-01-12T00:00:00.000Z' })
    createNote('note-5', { path: 'archive/note-5.md' })
    createNote('note-6', { path: 'journal/2026-01-10.md', date: '2026-01-10' })

    setNoteTags(db, 'note-3', ['alpha', 'beta'])
    setNoteTags(db, 'note-4', ['alpha'])

    const paged = listNotesFromCache(db, { limit: 1, offset: 1, sortBy: 'title', sortOrder: 'asc' })
    expect(paged).toHaveLength(1)

    const folderFiltered = listNotesFromCache(db, { folder: 'projects' })
    expect(folderFiltered.map((n) => n.id).sort()).toEqual(['note-3', 'note-4'])

    const tagFiltered = listNotesFromCache(db, { tags: ['alpha', 'beta'] })
    expect(tagFiltered.map((n) => n.id)).toEqual(['note-3'])

    const sorted = listNotesFromCache(db, { sortBy: 'modified', sortOrder: 'desc' })
    expect(sorted[0].id).toBe('note-4')
  })

  it('counts notes with folder filters', () => {
    createNote('note-7', { path: 'projects/note-7.md' })
    createNote('note-8', { path: 'projects/note-8.md' })
    createNote('note-9', { path: 'archive/note-9.md' })
    createNote('note-10', { path: 'journal/2026-01-11.md', date: '2026-01-11' })

    expect(countNotes(db)).toBe(3)
    expect(countNotes(db, 'projects')).toBe(2)
  })

  it('manages note tags and tag listings', () => {
    createNote('note-11')
    setNoteTags(db, 'note-11', ['Work', 'Personal'])

    expect(getNoteTags(db, 'note-11').sort()).toEqual(['personal', 'work'])
    const tags = getAllTags(db)
    expect(tags).toEqual(
      expect.arrayContaining([
        { tag: 'work', count: 1 },
        { tag: 'personal', count: 1 }
      ])
    )
  })

  it('finds notes by tags with pinned metadata', () => {
    createNote('note-12', { title: 'Pinned Note' })
    createNote('note-13', { title: 'Regular Note' })
    setNoteTags(db, 'note-12', ['alpha'])
    setNoteTags(db, 'note-13', ['alpha'])

    pinNoteToTag(db, 'note-12', 'alpha')

    const results = findNotesWithTagInfo(db, 'alpha')
    expect(results[0].id).toBe('note-12')
    expect(results[0].isPinned).toBe(true)
    expect(findNotesByTag(db, 'alpha').length).toBe(2)
  })

  it('supports tag pinning, renaming, deletion, and removal', () => {
    createNote('note-14')
    setNoteTags(db, 'note-14', ['alpha'])

    pinNoteToTag(db, 'note-14', 'alpha')
    unpinNoteFromTag(db, 'note-14', 'alpha')

    expect(getNoteTags(db, 'note-14')).toEqual(['alpha'])

    renameTag(db, 'alpha', 'beta')
    expect(getNoteTags(db, 'note-14')).toEqual(['beta'])

    removeTagFromNote(db, 'note-14', 'beta')
    expect(getNoteTags(db, 'note-14')).toEqual([])

    setNoteTags(db, 'note-14', ['gamma'])
    deleteTag(db, 'gamma')
    expect(getNoteTags(db, 'note-14')).toEqual([])
  })

  it('manages tag definitions and colors', () => {
    const dataDbResult = createTestDataDb()
    const dataDb = dataDbResult.db

    try {
      getOrCreateTag(dataDb, 'alpha')
      getOrCreateTag(dataDb, 'beta')
      updateTagColor(dataDb, 'alpha', 'red')
      renameTagDefinition(dataDb, 'beta', 'gamma')

      const definitions = getAllTagDefinitions(dataDb)
      const alpha = definitions.find((t) => t.name === 'alpha')
      const gamma = definitions.find((t) => t.name === 'gamma')

      expect(alpha?.color).toBe('red')
      expect(gamma).toBeDefined()

      deleteTagDefinition(dataDb, 'alpha')
      const afterDelete = getAllTagDefinitions(dataDb)
      expect(afterDelete.find((t) => t.name === 'alpha')).toBeUndefined()
    } finally {
      dataDbResult.close()
    }
  })

  it('manages note links and link resolution', () => {
    createNote('note-16', { title: 'Source' })
    createNote('note-17', { title: 'Target' })

    setNoteLinks(db, 'note-16', [
      { targetTitle: 'Target', targetId: 'note-17' },
      { targetTitle: 'Unresolved' }
    ])

    expect(getOutgoingLinks(db, 'note-16')).toHaveLength(2)
    expect(getIncomingLinks(db, 'note-17')[0].sourceId).toBe('note-16')

    expect(resolveNoteByTitle(db, 'Target')?.id).toBe('note-17')

    updateLinkTargets(db, 'note-16')
    const updated = db.get<{ target_id: string | null }>(sql`
      SELECT target_id FROM note_links WHERE target_title = 'Unresolved'
    `)
    expect(updated?.target_id).toBeNull()

    deleteLinksToNote(db, 'note-17')
    expect(getIncomingLinks(db, 'note-17')).toHaveLength(0)
  })

  it('bulk inserts notes and clears cache', () => {
    bulkInsertNotes(db, [
      {
        id: 'note-18',
        path: 'notes/note-18.md',
        title: 'Bulk 1',
        contentHash: 'hash-18',
        wordCount: 1,
        characterCount: 10,
        date: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        modifiedAt: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'note-19',
        path: 'notes/note-19.md',
        title: 'Bulk 2',
        contentHash: 'hash-19',
        wordCount: 1,
        characterCount: 10,
        date: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        modifiedAt: '2026-01-01T00:00:00.000Z'
      }
    ])

    expect(countNotes(db)).toBe(2)

    setNoteTags(db, 'note-18', ['alpha'])
    setNoteLinks(db, 'note-18', [{ targetTitle: 'Bulk 2', targetId: 'note-19' }])
    clearNoteCache(db)
    expect(countNotes(db)).toBe(0)
  })

  it('stores and retrieves note properties', () => {
    createNote('note-20')
    const inferType = (name: string, value: unknown): PropertyType => {
      if (typeof value === 'number') return 'number'
      if (typeof value === 'boolean') return 'checkbox'
      // Arrays no longer supported, fallback to text
      if (Array.isArray(value)) return 'text'
      if (name === 'date') return 'date'
      return 'text'
    }

    setNoteProperties(
      db,
      'note-20',
      { priority: 5, archived: false, date: '2026-01-10' },
      inferType
    )

    const properties = getNoteProperties(db, 'note-20')
    expect(properties).toEqual(
      expect.arrayContaining([
        { name: 'priority', value: 5, type: 'number' },
        { name: 'archived', value: false, type: 'checkbox' }
      ])
    )

    const record = getNotePropertiesAsRecord(db, 'note-20')
    expect(record.priority).toBe(5)
  })

  it('manages property definitions', () => {
    insertPropertyDefinition(db, {
      name: 'priority',
      type: 'number',
      options: null,
      defaultValue: null,
      color: null
    })

    updatePropertyDefinition(db, 'priority', { type: 'rating' })
    expect(getPropertyDefinition(db, 'priority')?.type).toBe('rating')

    const defs = getAllPropertyDefinitions(db)
    expect(defs.map((d) => d.name)).toContain('priority')
  })

  it('filters notes by properties', () => {
    createNote('note-21')
    setNoteProperties(
      db,
      'note-21',
      { status: 'open', score: 3, due: '2026-01-20', kind: 'alpha' },
      (_name, value) => (typeof value === 'number' ? 'number' : 'text')
    )

    expect(filterNotesByProperty(db, 'status', 'open').map((n) => n.id)).toEqual(['note-21'])
    expect(filterNotesByProperty(db, 'score', '3').map((n) => n.id)).toEqual(['note-21'])
    expect(filterNotesByProperty(db, 'due', '2026-01-20').map((n) => n.id)).toEqual(['note-21'])
    expect(filterNotesByProperty(db, 'kind', 'alpha').map((n) => n.id)).toEqual(['note-21'])
  })

  it('manages note snapshots', () => {
    createNote('note-22')
    insertNoteSnapshot(db, {
      id: 'snap-1',
      noteId: 'note-22',
      fileContent: 'Content 1',
      title: 'Note 22',
      wordCount: 2,
      contentHash: 'hash-1',
      reason: 'auto',
      createdAt: '2026-01-15T00:00:00.000Z'
    })
    insertNoteSnapshot(db, {
      id: 'snap-2',
      noteId: 'note-22',
      fileContent: 'Content 2',
      title: 'Note 22',
      wordCount: 3,
      contentHash: 'hash-2',
      reason: 'auto',
      createdAt: '2026-01-16T00:00:00.000Z'
    })

    const snapshots = getNoteSnapshots(db, 'note-22')
    expect(snapshots[0].id).toBe('snap-2')
    expect(getLatestSnapshot(db, 'note-22')?.id).toBe('snap-2')
    expect(snapshotExistsWithHash(db, 'note-22', 'hash-1')).toBe(true)

    const pruned = pruneOldSnapshots(db, 'note-22', 1)
    expect(pruned).toBe(1)
  })

  it('returns journal entries and statistics', () => {
    createNote('journal-1', {
      path: 'journal/2026-01-13.md',
      title: 'Journal 1',
      date: '2026-01-13',
      wordCount: 5,
      characterCount: 100
    })
    createNote('journal-2', {
      path: 'journal/2026-01-14.md',
      title: 'Journal 2',
      date: '2026-01-14',
      wordCount: 6,
      characterCount: 200
    })
    createNote('journal-3', {
      path: 'journal/2026-01-15.md',
      title: 'Journal 3',
      date: '2026-01-15',
      wordCount: 8,
      characterCount: 600
    })

    expect(getJournalEntryByDate(db, '2026-01-14')?.id).toBe('journal-2')
    expect(journalEntryExistsByDate(db, '2026-01-15')).toBe(true)

    const heatmap = getHeatmapData(db, 2026)
    expect(heatmap).toHaveLength(3)

    const monthEntries = getJournalMonthEntries(db, 2026, 1)
    expect(monthEntries[0].date).toBe('2026-01-15')

    const yearStats = getJournalYearStats(db, 2026)
    expect(yearStats[0].entryCount).toBe(3)

    const streak = getJournalStreak(db)
    expect(streak.currentStreak).toBe(3)
    expect(streak.longestStreak).toBe(3)
    expect(streak.lastEntryDate).toBe('2026-01-15')
  })
})
