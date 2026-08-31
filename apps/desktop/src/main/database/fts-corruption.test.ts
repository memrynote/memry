/**
 * On-disk corruption of an fts5 index, and the way back from it (#1585).
 *
 * The corruption is genuine, not simulated: fts5 keeps its index in shadow
 * tables (`fts_notes_data` and friends), and overwriting the blobs there is
 * what a torn write or a bad sector looks like from SQLite's side. fts5 refuses
 * shadow-table writes unless defensive mode is off, hence `unsafeMode`.
 *
 * Two shapes are exercised, because they are detected by different probes and
 * between them they cover both statements the reported install failed on:
 *
 * - garbled segment blobs: every read of the index throws, including a MATCH —
 *   this is what the cheap open-time probe catches.
 * - a garbled structure record: MATCH still answers, but fts5's own integrity
 *   check and `DELETE FROM fts_notes` both throw. Nothing an open-time read
 *   probe can see; it only surfaces when the reconcile pass touches the table.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { sql } from 'drizzle-orm'

vi.mock('../projections', () => ({
  rebuildProjections: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => []
  }
}))

import { runIndexMigrations } from './migrate'
import { checkIndexHealth } from './client'
import { createFtsTable, insertFtsNoteUnchecked, getFtsCount, resetFtsTable } from './fts'
import { createFtsTasksTable } from './fts-tasks'
import { createFtsInboxTable } from './fts-inbox'
import { detectCorruption } from './fts-rebuild'
import { isSqliteCorruptError } from './sqlite-errors'
import type { DataDb, IndexDb } from './client'

type AnyDb = IndexDb & DataDb

function seedFtsNotes(db: AnyDb, count: number): void {
  for (let i = 0; i < count; i++) {
    insertFtsNoteUnchecked(db, `note-${i}`, `Title ${i}`, `alpha beta gamma ${i}`, [`tag${i}`])
  }
}

/** Garble the segment blobs: every read of the index now fails. */
function garbleSegments(sqlite: Database.Database): void {
  sqlite.unsafeMode(true)
  sqlite.prepare('UPDATE fts_notes_data SET block = randomblob(64) WHERE id > 10').run()
  sqlite.unsafeMode(false)
}

/**
 * Garble the structure record: reads still answer, writes and checks fail.
 *
 * Zero bytes rather than random ones, because fts5 only rejects this record
 * when its varints fail to consume the blob exactly. Random bytes decode
 * cleanly about 1 run in 15 — the table then deletes without complaint and the
 * test claiming a corrupt table cannot be emptied goes red for no reason.
 * Zeroes always decode short, so the corruption is real on every run.
 */
function garbleStructure(sqlite: Database.Database): void {
  sqlite.unsafeMode(true)
  sqlite.prepare('UPDATE fts_notes_data SET block = zeroblob(20) WHERE id = 1').run()
  sqlite.unsafeMode(false)
}

function matchNotes(db: AnyDb): { id: string }[] {
  return db.all<{ id: string }>(sql`SELECT id FROM fts_notes WHERE fts_notes MATCH 'alpha'`)
}

describe('fts5 index corruption', () => {
  let tempDir: string
  let indexDbPath: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-fts-corrupt-'))
    indexDbPath = path.join(tempDir, 'index.db')
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('checkIndexHealth', () => {
    it('reports fts_corrupt when the search index inside a sound file is unreadable', () => {
      // #given an index DB that passes every structural check the old health
      // check made — the file opens, and note_cache/note_tags/note_links exist
      runIndexMigrations(indexDbPath)
      const sqlite = new Database(indexDbPath)
      const db = drizzle(sqlite) as unknown as AnyDb
      createFtsTable(db)
      seedFtsNotes(db, 300)

      expect(checkIndexHealth(indexDbPath)).toBe('healthy')

      // #when its fts5 segments are damaged on disk
      garbleSegments(sqlite)
      sqlite.close()

      // #then the vault-open gate sees it, instead of reading 'healthy' and
      // leaving note search returning zero results forever
      expect(checkIndexHealth(indexDbPath)).toBe('fts_corrupt')
    })

    it('still reports healthy for an index DB written before fts_notes existed', () => {
      // A missing virtual table is not corruption: initializeFts creates it on
      // open, which is how an older install upgrades.
      runIndexMigrations(indexDbPath)

      expect(checkIndexHealth(indexDbPath)).toBe('healthy')
    })
  })

  describe('detectCorruption', () => {
    let indexSqlite: Database.Database
    let dataSqlite: Database.Database
    let indexDb: AnyDb
    let dataDb: AnyDb

    beforeEach(() => {
      indexSqlite = new Database(':memory:')
      dataSqlite = new Database(':memory:')
      indexDb = drizzle(indexSqlite) as unknown as AnyDb
      dataDb = drizzle(dataSqlite) as unknown as AnyDb
      createFtsTable(indexDb)
      createFtsTasksTable(dataDb)
      createFtsInboxTable(dataDb)
      seedFtsNotes(indexDb, 300)
    })

    afterEach(() => {
      indexSqlite.close()
      dataSqlite.close()
    })

    it('names nothing while the indexes are intact', () => {
      expect(detectCorruption(indexDb, dataDb)).toEqual([])
    })

    it('names fts_notes for damage no read probe can see', () => {
      // #given the shape the reported install is in: reads still answer …
      garbleStructure(indexSqlite)
      expect(matchNotes(indexDb)).toHaveLength(300)

      // #then … but fts5's own verification pass finds it
      expect(detectCorruption(indexDb, dataDb)).toEqual(['fts_notes'])
    })

    it('names fts_notes for damaged segments too, and leaves the healthy tables alone', () => {
      garbleSegments(indexSqlite)

      expect(detectCorruption(indexDb, dataDb)).toEqual(['fts_notes'])
    })
  })

  describe('recovery', () => {
    let sqlite: Database.Database
    let db: AnyDb

    beforeEach(() => {
      sqlite = new Database(':memory:')
      db = drizzle(sqlite) as unknown as AnyDb
      createFtsTable(db)
      seedFtsNotes(db, 300)
    })

    afterEach(() => {
      sqlite.close()
    })

    it('cannot empty a corrupt table, but can drop and re-create it', () => {
      garbleStructure(sqlite)

      // #given the statement every rebuild used to start with — the reason the
      // user's "Rebuild search index" button failed at its first step
      let deleteError: unknown
      try {
        db.run(sql`DELETE FROM fts_notes`)
      } catch (error) {
        deleteError = error
      }
      expect(deleteError).toBeDefined()
      expect(isSqliteCorruptError(deleteError)).toBe(true)

      // #when the repair drops the virtual table instead of emptying it
      resetFtsTable(db)

      // #then the index is gone, sound, and writable again
      expect(getFtsCount(db)).toBe(0)
      expect(detectCorruption(db, db)).toEqual([])
    })

    it('restores working search after the index was unreadable', () => {
      garbleSegments(sqlite)

      // #given search is broken: this is the throw the user never saw
      expect(() => matchNotes(db)).toThrow()

      // #when the index is rebuilt from its canonical source
      resetFtsTable(db)
      insertFtsNoteUnchecked(db, 'note-1', 'Title', 'alpha beta', ['alpha'])

      // #then queries answer again
      expect(matchNotes(db)).toEqual([{ id: 'note-1' }])
    })
  })

  describe('isSqliteCorruptError', () => {
    it('accepts corruption through a driver wrapper, and nothing else', () => {
      const sqlite = new Database(':memory:')
      const db = drizzle(sqlite) as unknown as AnyDb
      createFtsTable(db)
      seedFtsNotes(db, 300)
      garbleSegments(sqlite)

      // Drizzle wraps the driver error, so the SQLITE_CORRUPT_VTAB code is only
      // reachable through the cause chain — a check that reads `.code` off the
      // top-level error alone would miss every one of these.
      let wrapped: unknown
      try {
        db.run(sql`DELETE FROM fts_notes`)
      } catch (error) {
        wrapped = error
      }
      expect(isSqliteCorruptError(wrapped)).toBe(true)

      sqlite.close()

      // A busy database is a transient condition; treating it as corruption
      // would buy the user a needless full reindex.
      expect(
        isSqliteCorruptError(Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' }))
      ).toBe(false)
      expect(isSqliteCorruptError(new Error('something went wrong'))).toBe(false)
    })
  })
})
