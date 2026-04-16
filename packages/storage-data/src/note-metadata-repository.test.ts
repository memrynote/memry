import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { NewNoteMetadata } from '@memry/db-schema/data-schema'
import {
  upsertNoteMetadata,
  updateNoteMetadata,
  deleteNoteMetadata,
  getNoteMetadataById,
  getNoteMetadataByPath,
  getJournalNoteMetadataByDate,
  listNoteMetadata,
  countLocalOnlyNoteMetadata,
  getPropertyDefinition,
  upsertPropertyDefinition,
  listPropertyDefinitions,
  deletePropertyDefinition,
  type NoteMetadataDb
} from './note-metadata-repository'

function makeNote(overrides: Partial<NewNoteMetadata> = {}): NewNoteMetadata {
  return {
    id: 'note-1',
    path: 'notes/note-1.md',
    title: 'Note 1',
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

describe('note-metadata-repository', () => {
  let testDb: TestDatabaseResult
  let db: NoteMetadataDb

  beforeEach(() => {
    testDb = createTestDataDb()
    db = testDb.db as unknown as NoteMetadataDb
  })

  afterEach(() => {
    testDb.close()
  })

  describe('upsertNoteMetadata', () => {
    it('inserts a new note on first call', () => {
      // #when
      const created = upsertNoteMetadata(db, makeNote())

      // #then
      expect(created.id).toBe('note-1')
      expect(created.title).toBe('Note 1')
      expect(created.path).toBe('notes/note-1.md')
    })

    it('updates existing row on id conflict', () => {
      // #given
      upsertNoteMetadata(db, makeNote({ title: 'Original' }))

      // #when
      const updated = upsertNoteMetadata(
        db,
        makeNote({ title: 'Updated', modifiedAt: '2026-02-01T00:00:00.000Z' })
      )

      // #then
      expect(updated.title).toBe('Updated')
      expect(updated.modifiedAt).toBe('2026-02-01T00:00:00.000Z')
      // Only one row stored
      const all = listNoteMetadata(db)
      expect(all).toHaveLength(1)
    })

    it('persists optional fields (emoji, fileType, localOnly, journalDate)', () => {
      // #when
      const created = upsertNoteMetadata(
        db,
        makeNote({
          emoji: 'note',
          fileType: 'markdown',
          localOnly: true,
          journalDate: '2026-04-16'
        })
      )

      // #then
      expect(created.emoji).toBe('note')
      expect(created.localOnly).toBe(true)
      expect(created.journalDate).toBe('2026-04-16')
    })
  })

  describe('updateNoteMetadata', () => {
    it('updates fields on existing note', () => {
      // #given
      upsertNoteMetadata(db, makeNote())

      // #when
      const updated = updateNoteMetadata(db, 'note-1', { title: 'Renamed' })

      // #then
      expect(updated?.title).toBe('Renamed')
    })

    it('returns undefined when id does not exist', () => {
      // #when
      const updated = updateNoteMetadata(db, 'missing', { title: 'No' })

      // #then
      expect(updated).toBeUndefined()
    })
  })

  describe('getNoteMetadataById', () => {
    it('returns the note when found', () => {
      // #given
      upsertNoteMetadata(db, makeNote())

      // #when
      const found = getNoteMetadataById(db, 'note-1')

      // #then
      expect(found?.id).toBe('note-1')
    })

    it('returns undefined when not found', () => {
      expect(getNoteMetadataById(db, 'missing')).toBeUndefined()
    })
  })

  describe('getNoteMetadataByPath', () => {
    it('resolves canonical path', () => {
      // #given
      upsertNoteMetadata(db, makeNote())

      // #when
      const found = getNoteMetadataByPath(db, 'notes/note-1.md')

      // #then
      expect(found?.id).toBe('note-1')
    })
  })

  describe('getJournalNoteMetadataByDate', () => {
    it('finds journal entry by date', () => {
      // #given
      upsertNoteMetadata(
        db,
        makeNote({
          id: 'journal-1',
          path: 'journal/2026-04-16.md',
          title: '2026-04-16',
          journalDate: '2026-04-16'
        })
      )

      // #when
      const found = getJournalNoteMetadataByDate(db, '2026-04-16')

      // #then
      expect(found?.id).toBe('journal-1')
    })

    it('returns undefined when no journal for date', () => {
      expect(getJournalNoteMetadataByDate(db, '1999-01-01')).toBeUndefined()
    })
  })

  describe('listNoteMetadata', () => {
    beforeEach(() => {
      upsertNoteMetadata(
        db,
        makeNote({
          id: 'n-a',
          path: 'notes/a.md',
          title: 'Alpha',
          modifiedAt: '2026-01-01T00:00:00.000Z'
        })
      )
      upsertNoteMetadata(
        db,
        makeNote({
          id: 'n-b',
          path: 'notes/sub/b.md',
          title: 'Bravo',
          modifiedAt: '2026-03-01T00:00:00.000Z'
        })
      )
      upsertNoteMetadata(
        db,
        makeNote({
          id: 'j-1',
          path: 'journal/2026-04-16.md',
          title: '2026-04-16',
          journalDate: '2026-04-16',
          modifiedAt: '2026-04-16T00:00:00.000Z'
        })
      )
    })

    it('returns only notes by default (excludes journal)', () => {
      // #when
      const rows = listNoteMetadata(db)

      // #then
      expect(rows.map((r) => r.id).sort()).toEqual(['n-a', 'n-b'])
    })

    it('filters to journal when journalOnly=true', () => {
      // #when
      const rows = listNoteMetadata(db, { journalOnly: true })

      // #then
      expect(rows.map((r) => r.id)).toEqual(['j-1'])
    })

    it('filters by folder prefix', () => {
      // #when
      const rows = listNoteMetadata(db, { folder: 'sub' })

      // #then
      expect(rows.map((r) => r.id)).toEqual(['n-b'])
    })

    it('sorts by title asc', () => {
      // #when
      const rows = listNoteMetadata(db, { sortBy: 'title', sortOrder: 'asc' })

      // #then
      expect(rows.map((r) => r.title)).toEqual(['Alpha', 'Bravo'])
    })

    it('sorts by modified desc by default', () => {
      // #when
      const rows = listNoteMetadata(db)

      // #then
      expect(rows.map((r) => r.id)).toEqual(['n-b', 'n-a'])
    })

    it('respects limit + offset', () => {
      // #when
      const first = listNoteMetadata(db, { limit: 1, offset: 0 })
      const second = listNoteMetadata(db, { limit: 1, offset: 1 })

      // #then
      expect(first).toHaveLength(1)
      expect(second).toHaveLength(1)
      expect(first[0].id).not.toBe(second[0].id)
    })
  })

  describe('deleteNoteMetadata', () => {
    it('removes row by id', () => {
      // #given
      upsertNoteMetadata(db, makeNote())

      // #when
      deleteNoteMetadata(db, 'note-1')

      // #then
      expect(getNoteMetadataById(db, 'note-1')).toBeUndefined()
    })

    it('is a no-op for missing id', () => {
      expect(() => deleteNoteMetadata(db, 'missing')).not.toThrow()
    })
  })

  describe('countLocalOnlyNoteMetadata', () => {
    it('counts only rows flagged localOnly=true', () => {
      // #given
      upsertNoteMetadata(db, makeNote({ id: 'a', path: 'notes/a.md', localOnly: true }))
      upsertNoteMetadata(db, makeNote({ id: 'b', path: 'notes/b.md', localOnly: true }))
      upsertNoteMetadata(db, makeNote({ id: 'c', path: 'notes/c.md', localOnly: false }))

      // #when / #then
      expect(countLocalOnlyNoteMetadata(db)).toBe(2)
    })

    it('returns 0 on empty table', () => {
      expect(countLocalOnlyNoteMetadata(db)).toBe(0)
    })
  })

  describe('property definitions', () => {
    it('upserts then retrieves by name', () => {
      // #when
      const created = upsertPropertyDefinition(db, {
        name: 'priority',
        type: 'select',
        options: JSON.stringify(['low', 'high']),
        defaultValue: 'low',
        color: '#f00'
      })

      // #then
      expect(created.name).toBe('priority')
      const found = getPropertyDefinition(db, 'priority')
      expect(found?.defaultValue).toBe('low')
    })

    it('updates existing definition on conflict', () => {
      // #given
      upsertPropertyDefinition(db, { name: 'priority', type: 'select', defaultValue: 'low' })

      // #when
      const updated = upsertPropertyDefinition(db, {
        name: 'priority',
        type: 'select',
        defaultValue: 'high'
      })

      // #then
      expect(updated.defaultValue).toBe('high')
    })

    it('lists all definitions ordered by name', () => {
      // #given
      upsertPropertyDefinition(db, { name: 'zeta', type: 'text' })
      upsertPropertyDefinition(db, { name: 'alpha', type: 'text' })

      // #when
      const all = listPropertyDefinitions(db)

      // #then
      expect(all.map((d) => d.name)).toEqual(['alpha', 'zeta'])
    })

    it('returns undefined when definition missing', () => {
      expect(getPropertyDefinition(db, 'missing')).toBeUndefined()
    })

    it('deletes definition by name', () => {
      // #given
      upsertPropertyDefinition(db, { name: 'priority', type: 'select' })

      // #when
      deletePropertyDefinition(db, 'priority')

      // #then
      expect(getPropertyDefinition(db, 'priority')).toBeUndefined()
    })
  })
})
