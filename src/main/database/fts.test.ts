import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TestDatabaseResult, TestDb } from '@tests/utils/test-db'
import { createTestIndexDb, sql } from '@tests/utils/test-db'
import {
  createFtsTable,
  insertFtsNote,
  updateFtsContent,
  deleteFtsNote,
  clearFtsTable,
  getFtsCount,
  ftsNoteExists
} from './fts'

describe('fts integration', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  beforeEach(() => {
    dbResult = createTestIndexDb()
    db = dbResult.db
  })

  afterEach(() => {
    dbResult.close()
  })

  it('creates the FTS virtual table', () => {
    createFtsTable(db)
    const table = db.get<{ name: string }>(sql`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fts_notes'
    `)
    expect(table?.name).toBe('fts_notes')
  })

  it('inserts, updates, and deletes FTS entries', () => {
    createFtsTable(db)
    insertFtsNote(db, 'note-1', 'Title', 'alpha beta', ['alpha', 'beta'])

    expect(ftsNoteExists(db, 'note-1')).toBe(true)
    expect(getFtsCount(db)).toBe(1)

    updateFtsContent(db, 'note-1', 'gamma delta', ['gamma'])
    const updated = db.get<{ content: string; tags: string }>(sql`
      SELECT content, tags FROM fts_notes WHERE id = 'note-1'
    `)
    expect(updated?.content).toBe('gamma delta')
    expect(updated?.tags).toBe('gamma')

    deleteFtsNote(db, 'note-1')
    expect(ftsNoteExists(db, 'note-1')).toBe(false)
  })

  it('supports basic, boolean, and prefix search', () => {
    createFtsTable(db)
    insertFtsNote(db, 'note-1', 'Alpha Note', 'hello world', ['alpha'])
    insertFtsNote(db, 'note-2', 'Beta Note', 'hello memry', ['beta'])
    insertFtsNote(db, 'note-3', 'Gamma Note', 'something else', ['gamma'])

    const basic = db.all<{ id: string }>(sql`
      SELECT id FROM fts_notes WHERE fts_notes MATCH 'hello'
    `)
    expect(basic.map((r) => r.id).sort()).toEqual(['note-1', 'note-2'])

    const boolean = db.all<{ id: string }>(sql`
      SELECT id FROM fts_notes WHERE fts_notes MATCH 'hello AND world'
    `)
    expect(boolean.map((r) => r.id)).toEqual(['note-1'])

    const negation = db.all<{ id: string }>(sql`
      SELECT id FROM fts_notes WHERE fts_notes MATCH 'hello NOT memry'
    `)
    expect(negation.map((r) => r.id)).toEqual(['note-1'])

    const prefix = db.all<{ id: string }>(sql`
      SELECT id FROM fts_notes WHERE fts_notes MATCH 'alph*'
    `)
    expect(prefix.map((r) => r.id)).toEqual(['note-1'])
  })

  it('clears the FTS table and reports counts', () => {
    createFtsTable(db)
    insertFtsNote(db, 'note-1', 'Title', 'content', ['tag'])
    insertFtsNote(db, 'note-2', 'Title', 'content', ['tag'])

    expect(getFtsCount(db)).toBe(2)
    clearFtsTable(db)
    expect(getFtsCount(db)).toBe(0)
  })
})
