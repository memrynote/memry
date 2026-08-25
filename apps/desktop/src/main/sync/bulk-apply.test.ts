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
import { getRawIndexDatabase, isIndexDatabaseInitialized } from '../database/client'

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
const readJournalEntries = (): Array<{ absolutePath: string; sha256?: string }> => {
  const parsed: unknown = JSON.parse(readJournal()!)
  return Array.isArray(parsed) ? parsed : ((parsed as { entries: [] }).entries ?? [])
}

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
      expect(readJournalEntries()).toHaveLength(2)
      // Each entry records the hash of its intended bytes for replay.
      for (const entry of readJournalEntries()) {
        expect(entry.sha256).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/))
      }

      _resetBulkApplyForTests()
      replayBulkApplyJournal()

      expect(fs.readFileSync(fileA, 'utf-8')).toBe('content-a')
      expect(fs.readFileSync(fileB, 'utf-8')).toBe('content-b')
      expect(readJournal()).toBeNull()
    })

    it('#then a file whose post-crash bytes differ from the journal is left alone on replay', () => {
      const { db } = makeDb()
      const fileA = path.join(userDataDir, 'note-c.md')

      const page = beginPageApply(db)
      writeSyncedNoteFile(fileA, 'synced-content')
      page.commit()

      // A writeback or editor got there first with newer bytes, AFTER the
      // journal was written. The mtime is what makes "post-crash writer"
      // provable across the restart; without it a same-instant write could not
      // be told apart from stale pre-crash bytes.
      fs.writeFileSync(fileA, 'newer-local-content', 'utf-8')
      const journal = JSON.parse(readJournal()!) as { writtenAt: number }
      const afterJournal = (journal.writtenAt + 60_000) / 1000
      fs.utimesSync(fileA, afterJournal, afterJournal)

      _resetBulkApplyForTests()
      replayBulkApplyJournal()

      expect(fs.readFileSync(fileA, 'utf-8')).toBe('newer-local-content')
    })

    it('#then an update whose flush never landed has its stale pre-crash bytes overwritten', () => {
      const { db } = makeDb()
      const fileA = path.join(userDataDir, 'note-update.md')
      // Bytes from before the crash: written before the page commit, so their
      // mtime predates the journal's.
      fs.writeFileSync(fileA, 'old-bytes', 'utf-8')

      const page = beginPageApply(db)
      writeSyncedNoteFile(fileA, 'row-content')
      page.commit()
      // Crash before flushFiles(): the row committed, the file still holds the
      // old bytes. Existence alone must not skip the heal.
      expect(fs.readFileSync(fileA, 'utf-8')).toBe('old-bytes')

      _resetBulkApplyForTests()
      replayBulkApplyJournal()

      expect(fs.readFileSync(fileA, 'utf-8')).toBe('row-content')
      expect(readJournal()).toBeNull()
    })

    it('#then a file that already carries the journaled bytes is skipped untouched', () => {
      const { db } = makeDb()
      const fileA = path.join(userDataDir, 'landed.md')

      const page = beginPageApply(db)
      writeSyncedNoteFile(fileA, 'landed-content')
      page.commit()
      // The flush landed out-of-band before the crash.
      fs.writeFileSync(fileA, 'landed-content', 'utf-8')

      const renameSpy = vi.spyOn(fs, 'renameSync')
      _resetBulkApplyForTests()
      replayBulkApplyJournal()
      renameSpy.mockRestore()

      expect(renameSpy).not.toHaveBeenCalled()
      expect(fs.readFileSync(fileA, 'utf-8')).toBe('landed-content')
    })

    it('#then a legacy bare-array journal still heals, overwriting mismatched bytes', () => {
      const target = path.join(userDataDir, 'legacy.md')
      fs.writeFileSync(target, 'stale', 'utf-8')
      fs.writeFileSync(
        journalFile,
        JSON.stringify([{ absolutePath: target, content: 'legacy-new' }]),
        'utf-8'
      )

      replayBulkApplyJournal()

      expect(fs.readFileSync(target, 'utf-8')).toBe('legacy-new')
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
      expect(readJournalEntries()).toHaveLength(1)

      // Page 2 must not clobber page 1's unlanded entry.
      const page2 = beginPageApply(db)
      const otherFile = path.join(userDataDir, 'other.md')
      writeSyncedNoteFile(otherFile, 'o')
      page2.commit()
      await page2.flushFiles()

      const journaled = readJournalEntries()
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

  describe('#given a page commit with pending writes #when the journal is written', () => {
    it('#then the journal file itself is fsynced before the data COMMIT it protects', () => {
      const { db, raw } = makeDb()
      // Track what each opened fd IS, so the assertion pins the journal BYTES'
      // fsync — not the parent-directory fsync that follows the rename (fd
      // numbers are recycled as soon as one closes).
      const realOpenSync = fs.openSync.bind(fs)
      const realFsyncSync = fs.fsyncSync.bind(fs)
      const fdPaths = new Map<number, string>()
      const fsyncTargets: Array<{ path: string; order: number }> = []
      const openSpy = vi.spyOn(fs, 'openSync').mockImplementation(((
        p: string,
        flags?: string,
        mode?: number
      ) => {
        const fd = realOpenSync(p as string, flags as never, mode)
        fdPaths.set(fd, String(p))
        return fd
      }) as typeof fs.openSync)
      const fsyncSpy = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd: number) => {
        fsyncTargets.push({ path: fdPaths.get(fd) ?? `unknown-fd-${fd}`, order: 0 })
        return realFsyncSync(fd)
      })
      const origExec = raw.exec.bind(raw)
      const execSpy = vi.fn((sql: string) => origExec(sql))
      raw.exec = execSpy as unknown as typeof raw.exec

      try {
        const page = beginPageApply(db)
        writeSyncedNoteFile(path.join(userDataDir, 'durable.md'), 'durable-content')
        page.commit()

        const commitCall = execSpy.mock.calls.findIndex(([sql]) => sql === 'COMMIT')
        expect(commitCall).toBeGreaterThanOrEqual(0)
        // Classify each fsync by what its fd had been opened for, captured at
        // call time while the fd→path map still described it.
        const journalDataFsyncs = fsyncTargets
          .map((target, i) => ({ ...target, order: fsyncSpy.mock.invocationCallOrder[i] }))
          .filter(({ path }) => path.endsWith('.tmp'))
        expect(journalDataFsyncs).toHaveLength(1)
        // The bytes must be on stable storage before the commit makes the
        // journal load-bearing — power loss between the two would leave
        // committed rows that no journal entry can heal.
        expect(execSpy.mock.invocationCallOrder[commitCall]).toBeGreaterThan(
          journalDataFsyncs[0]!.order
        )
      } finally {
        openSpy.mockRestore()
        fsyncSpy.mockRestore()
      }
    })
  })

  describe('#given the index DB participates in the page transaction', () => {
    let indexRaw: Database.Database

    beforeEach(() => {
      indexRaw = new Database(':memory:')
      indexRaw.exec('CREATE TABLE ix (id TEXT PRIMARY KEY)')
      vi.mocked(isIndexDatabaseInitialized).mockReturnValue(true)
      vi.mocked(getRawIndexDatabase).mockReturnValue(indexRaw)
    })

    afterEach(() => {
      vi.mocked(isIndexDatabaseInitialized).mockReturnValue(false)
      vi.mocked(getRawIndexDatabase).mockReturnValue(null as unknown as Database.Database)
      indexRaw.close()
    })

    /** Route a connection's exec through an order recorder. */
    const tap = (raw: Database.Database, label: string): void => {
      const orig = raw.exec.bind(raw)
      raw.exec = ((sql: string) => {
        order.push(`${label}:${sql}`)
        return orig(sql)
      }) as typeof raw.exec
    }
    let order: string[] = []

    beforeEach(() => {
      order = []
    })

    it('#then both rows land and the data DB commits before the index DB', () => {
      const { db, raw } = makeDb()
      tap(raw, 'data')
      tap(indexRaw, 'index')

      const page = beginPageApply(db)
      page.db.transaction(() => {
        ;(page.db as unknown as { $client: Database.Database }).$client
          .prepare("INSERT INTO t (id, v) VALUES ('a', '1')")
          .run()
      })
      page.commit()

      expect(raw.prepare("SELECT COUNT(*) AS n FROM t WHERE id = 'a'").get()).toEqual({ n: 1 })
      expect(order).toContain('data:COMMIT')
      expect(order).toContain('index:COMMIT')
      // Data first: a crash between the commits leaves missing index rows for
      // existing data (re-applied on re-pull), never index ghosts colliding
      // with re-pulled creates.
      expect(order.indexOf('data:COMMIT')).toBeLessThan(order.indexOf('index:COMMIT'))
    })

    it('#then a failed index COMMIT rolls back and leaves the index connection usable', () => {
      const { db } = makeDb()
      const page = beginPageApply(db)

      const origExec = indexRaw.exec.bind(indexRaw)
      const sqlLog: string[] = []
      indexRaw.exec = ((sql: string) => {
        sqlLog.push(sql)
        if (sql === 'COMMIT') throw new Error('index commit boom')
        return origExec(sql)
      }) as typeof indexRaw.exec

      expect(() => page.commit()).not.toThrow()
      indexRaw.exec = origExec

      // Without this rollback the index connection would sit in an open
      // transaction forever: later statements run uncommitted-visible and
      // every future BEGIN IMMEDIATE fails.
      expect(sqlLog).toContain('ROLLBACK')
      expect(indexRaw.inTransaction).toBe(false)
      expect(() => indexRaw.exec('BEGIN IMMEDIATE')).not.toThrow()
      indexRaw.exec('ROLLBACK')
    })

    it('#then a failed data COMMIT rolls back and leaves the data connection usable too', () => {
      const { db, raw } = makeDb()
      const page = beginPageApply(db)
      writeSyncedNoteFile(path.join(userDataDir, 'doomed.md'), 'never-committed')

      const origExec = raw.exec.bind(raw)
      const sqlLog: string[] = []
      raw.exec = ((sql: string) => {
        sqlLog.push(sql)
        if (sql === 'COMMIT') throw new Error('data commit boom')
        return origExec(sql)
      }) as typeof raw.exec

      expect(() => page.commit()).toThrow('data commit boom')
      raw.exec = origExec

      expect(sqlLog).toContain('ROLLBACK')
      expect(raw.inTransaction).toBe(false)
      expect(() => raw.exec('BEGIN IMMEDIATE')).not.toThrow()
      raw.exec('ROLLBACK')
      // The journaled writes covered rows that no longer exist; they must go.
      expect(readJournal()).toBeNull()
    })
  })
})
