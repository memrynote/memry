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
  ftsNoteExists,
  resetFtsTable
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
    insertFtsNote(db, 'note-2', 'Beta Note', 'hello Memry', ['beta'])
    insertFtsNote(db, 'note-3', 'Gamma Note', 'something else', ['gamma'])

    const basic = db.all<{ id: string }>(sql`
      SELECT id FROM fts_notes WHERE fts_notes MATCH 'hello'
    `)
    expect(basic.map((r) => r.id).toSorted()).toEqual(['note-1', 'note-2'])

    const boolean = db.all<{ id: string }>(sql`
      SELECT id FROM fts_notes WHERE fts_notes MATCH 'hello AND world'
    `)
    expect(boolean.map((r) => r.id)).toEqual(['note-1'])

    const negation = db.all<{ id: string }>(sql`
      SELECT id FROM fts_notes WHERE fts_notes MATCH 'hello NOT Memry'
    `)
    expect(negation.map((r) => r.id)).toEqual(['note-1'])

    const prefix = db.all<{ id: string }>(sql`
      SELECT id FROM fts_notes WHERE fts_notes MATCH 'alph*'
    `)
    expect(prefix.map((r) => r.id)).toEqual(['note-1'])
  })

  it('replaces the previous entry when the same note is indexed again', () => {
    // fts5 has no PRIMARY KEY or UNIQUE index here (`id` is UNINDEXED), so an
    // INSERT OR REPLACE has nothing to conflict on. Without an explicit delete
    // every save of a note appends another row: unbounded index growth plus
    // stale terms that keep matching.
    createFtsTable(db)
    insertFtsNote(db, 'note-1', 'Title', 'alpha beta', ['alpha'])
    insertFtsNote(db, 'note-1', 'Title', 'gamma delta', ['gamma'])

    expect(getFtsCount(db)).toBe(1)
    expect(
      db.all<{ id: string }>(sql`SELECT id FROM fts_notes WHERE fts_notes MATCH 'gamma'`)
    ).toHaveLength(1)
    expect(
      db.all<{ id: string }>(sql`SELECT id FROM fts_notes WHERE fts_notes MATCH 'alpha'`)
    ).toHaveLength(0)
  })

  it('clears the FTS table and reports counts', () => {
    createFtsTable(db)
    insertFtsNote(db, 'note-1', 'Title', 'content', ['tag'])
    insertFtsNote(db, 'note-2', 'Title', 'content', ['tag'])

    expect(getFtsCount(db)).toBe(2)
    clearFtsTable(db)
    expect(getFtsCount(db)).toBe(0)
  })

  // `DELETE ... WHERE id = ?` on the fts5 table scans every row (`id` is
  // UNINDEXED), so indexing a fresh vault note by note was quadratic: 177 s for
  // 17k notes against 15 s with the lookup index (#5390).
  it.each([
    ['a table created with it', (d: TestDb) => createFtsTable(d)],
    [
      'a table an older build created without it',
      (d: TestDb) => {
        d.run(
          sql`CREATE VIRTUAL TABLE fts_notes USING fts5(id UNINDEXED, title, content, tags, tokenize='porter unicode61')`
        )
        createFtsTable(d)
      }
    ],
    [
      'a reset table',
      (d: TestDb) => {
        createFtsTable(d)
        resetFtsTable(d)
      }
    ]
  ])('finds a note by id through an index on %s', (_, setup) => {
    setup(db)
    insertFtsNote(db, 'note-1', 'Title', 'alpha', [])
    insertFtsNote(db, 'note-2', 'Title', 'beta', [])
    insertFtsNote(db, 'note-1', 'Title', 'gamma', [])
    deleteFtsNote(db, 'note-2')

    const plan = db.all<{ detail: string }>(
      sql`EXPLAIN QUERY PLAN SELECT id FROM fts_notes_content WHERE c0 = ${'note-1'}`
    )
    expect(plan.map((row) => row.detail).join(' ')).toMatch(/USING (COVERING )?INDEX/)
    expect(db.all<{ id: string }>(sql`SELECT id FROM fts_notes`)).toEqual([{ id: 'note-1' }])
    expect(ftsNoteExists(db, 'note-1')).toBe(true)
    expect(ftsNoteExists(db, 'note-2')).toBe(false)
  })
})
