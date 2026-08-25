import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-apply-'))
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => userDataDir) }
}))
vi.mock('../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})
vi.mock('./crdt-writeback', () => ({ markWritebackIgnored: vi.fn() }))
vi.mock('../database/client', () => ({
  isIndexDatabaseInitialized: vi.fn(() => false),
  getRawIndexDatabase: vi.fn(() => null)
}))

import {
  beginPageApply,
  replayBulkApplyJournal,
  writeSyncedNoteFile,
  _resetBulkApplyForTests
} from './bulk-apply'

function makeDb(): { db: DrizzleDb; raw: Database.Database } {
  const raw = new Database(':memory:')
  const db = drizzle(raw) as unknown as DrizzleDb
  // Pin the raw client where extractRawClient looks, independent of the
  // installed drizzle version's $client support.
  ;(db as unknown as { $client: unknown }).$client = raw
  raw.exec('CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)')
  return { db, raw }
}

const journalFile = path.join(userDataDir, 'sync-bulk-apply-journal.json')
const readJournal = (): string | null =>
  fs.existsSync(journalFile) ? fs.readFileSync(journalFile, 'utf-8') : null

describe('bulk apply page session', () => {
  beforeEach(() => {
    _resetBulkApplyForTests()
    if (fs.existsSync(journalFile)) fs.unlinkSync(journalFile)
  })

  afterEach(() => {
    _resetBulkApplyForTests()
  })

  describe('#given a page of applies #when every item lands and commit runs', () => {
    it('#then both rows are visible after the commit', () => {
      const { db, raw } = makeDb()
      const page = beginPageApply(db)
      // Two handler-style savepoint transactions inside the open page tx.
      for (const id of ['a', 'b']) {
        page.db.transaction(() => {
          ;(page.db as unknown as { $client: Database.Database }).$client
            .prepare('INSERT INTO t (id, v) VALUES (?, ?)')
            .run(id, `v-${id}`)
        })
      }
      page.commit()

      expect(raw.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 2 })
      expect(readJournal()).toBeNull()
    })

    it('#then per-item savepoint rollback keeps earlier items of the same item', () => {
      const { db, raw } = makeDb()
      const page = beginPageApply(db)
      expect(() =>
        page.db.transaction(() => {
          ;(page.db as unknown as { $client: Database.Database }).$client
            .prepare("INSERT INTO t (id, v) VALUES ('keep', 'x')")
            .run()
          throw new Error('item failed')
        })
      ).toThrow('item failed')
      page.db.transaction(() => {
        ;(page.db as unknown as { $client: Database.Database }).$client
          .prepare("INSERT INTO t (id, v) VALUES ('kept2', 'y')")
          .run()
      })
      page.commit()

      expect(raw.prepare("SELECT COUNT(*) AS n FROM t WHERE id = 'keep'").get()).toEqual({ n: 0 })
      expect(raw.prepare("SELECT COUNT(*) AS n FROM t WHERE id = 'kept2'").get()).toEqual({
        n: 1
      })
    })
  })

  describe('#given an escaping throw mid-page #when the caller rolls the page back', () => {
    it('#then nothing from the page is committed', () => {
      const { db, raw } = makeDb()
      const page = beginPageApply(db)
      page.db.transaction(() => {
        ;(page.db as unknown as { $client: Database.Database }).$client
          .prepare("INSERT INTO t (id, v) VALUES ('a', '1')")
          .run()
      })
      page.rollback()

      expect(raw.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 0 })
      // The rolled-back page's deferred writes must not sit in the journal.
      expect(readJournal()).toBeNull()
    })
  })

  describe('#given a crash between the DB commit and the async file flush', () => {
    it('#then replay heals exactly the missing files', async () => {
      const { db } = makeDb()
      const fileA = path.join(userDataDir, 'note-a.md')
      const fileB = path.join(userDataDir, 'note-b.md')

      const page = beginPageApply(db)
      writeSyncedNoteFile(fileA, 'content-a')
      writeSyncedNoteFile(fileB, 'content-b')
      page.commit()

      // Crash before flushFiles(): journal exists, files do not.
      expect(fs.existsSync(fileA)).toBe(false)
      expect(JSON.parse(readJournal()!)).toHaveLength(2)

      _resetBulkApplyForTests()
      replayBulkApplyJournal()

      expect(fs.readFileSync(fileA, 'utf-8')).toBe('content-a')
      expect(fs.readFileSync(fileB, 'utf-8')).toBe('content-b')
      expect(readJournal()).toBeNull()
    })

    it('#then a file that already exists is left alone on replay', () => {
      const { db } = makeDb()
      const fileA = path.join(userDataDir, 'note-c.md')

      const page = beginPageApply(db)
      writeSyncedNoteFile(fileA, 'synced-content')
      page.commit()

      // A writeback or editor got there first with newer bytes.
      fs.writeFileSync(fileA, 'newer-local-content', 'utf-8')

      _resetBulkApplyForTests()
      replayBulkApplyJournal()

      expect(fs.readFileSync(fileA, 'utf-8')).toBe('newer-local-content')
    })
  })

  describe('#given a partial flush (one write fails) #when the next page commits', () => {
    it('#then the failed entry survives in the journal and heals later', async () => {
      const { db } = makeDb()
      const goodFile = path.join(userDataDir, 'good.md')
      // A parent that is a FILE makes mkdir/rename fail for this one entry.
      const blocker = path.join(userDataDir, 'blocker')
      fs.writeFileSync(blocker, 'not a dir', 'utf-8')
      const badFile = path.join(blocker, 'bad.md')

      const page1 = beginPageApply(db)
      writeSyncedNoteFile(goodFile, 'g')
      writeSyncedNoteFile(badFile, 'b')
      page1.commit()
      await page1.flushFiles()

      expect(fs.existsSync(goodFile)).toBe(true)
      expect(fs.existsSync(badFile)).toBe(false)
      // Journal retained with only the failed entry.
      expect(JSON.parse(readJournal()!)).toHaveLength(1)

      // Page 2 must not clobber page 1's unlanded entry.
      const page2 = beginPageApply(db)
      const otherFile = path.join(userDataDir, 'other.md')
      writeSyncedNoteFile(otherFile, 'o')
      page2.commit()
      await page2.flushFiles()

      const journaled = JSON.parse(readJournal()!) as Array<{ absolutePath: string }>
      expect(journaled.map((e) => e.absolutePath)).toContain(badFile)

      // Repair the failure cause, then replay heals the rest.
      fs.rmSync(blocker, { recursive: true, force: true })
      replayBulkApplyJournal()
      expect(fs.readFileSync(badFile, 'utf-8')).toBe('b')
      expect(fs.existsSync(otherFile)).toBe(true)
      expect(readJournal()).toBeNull()
    })
  })

  describe('#given two journal entries for the same path', () => {
    it('#then replay lands the newest content', () => {
      fs.writeFileSync(
        journalFile,
        JSON.stringify([
          { absolutePath: path.join(userDataDir, 'dup.md'), content: 'old' },
          { absolutePath: path.join(userDataDir, 'dup.md'), content: 'new' }
        ]),
        'utf-8'
      )
      replayBulkApplyJournal()
      expect(fs.readFileSync(path.join(userDataDir, 'dup.md'), 'utf-8')).toBe('new')
      expect(readJournal()).toBeNull()
    })
  })

  describe('#given an unreadable journal file', () => {
    it('#then replay drops it instead of crashing the pull', () => {
      fs.writeFileSync(journalFile, '{not json', 'utf-8')
      expect(() => replayBulkApplyJournal()).not.toThrow()
      expect(readJournal()).toBeNull()
    })
  })

  describe('#given no active session', () => {
    it('#then note file writes stay synchronous tmp-write + rename', () => {
      const target = path.join(userDataDir, 'steady.md')
      writeSyncedNoteFile(target, 'steady-state')
      expect(fs.existsSync(target + '.tmp')).toBe(false)
      expect(fs.readFileSync(target, 'utf-8')).toBe('steady-state')
    })
  })
})
