// #2297: durable per-note CRDT body debts, on a real migrated data DB.
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { asSyncDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { vi } from 'vitest'
import {
  convertUnmergedDebtMirror,
  crdtBodyDebtBackoffMs,
  crdtBodyDebtBackoffUntil,
  crdtBodyDebtStore,
  currentCrdtBodyDebtGeneration,
  hasCrdtBodyDebts,
  listCrdtBodyDebts,
  oweCrdtBodyDebts,
  settleCrdtBodyDebts
} from './crdt-body-debts'
import { SYNC_STATE_KEYS } from './sync-context'

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('../../lib/logger', () => ({ createLogger: () => log }))

const MIN = 60_000

describe('crdt body debts (#2297)', () => {
  let t: TestDatabaseResult
  const db = () => asSyncDb(t.db)
  const state = (key: string) =>
    t.sqlite.prepare('SELECT value, updated_at AS at FROM sync_state WHERE key = ?').get(key) as
      { value: string; at: number } | undefined
  const debt = (noteId: string) => listCrdtBodyDebts(db()).find((d) => d.noteId === noteId)
  const owe = (
    ids: string[],
    reason: Parameters<typeof oweCrdtBodyDebts>[2],
    options: Parameters<typeof oweCrdtBodyDebts>[3] = {}
  ) => oweCrdtBodyDebts(db(), ids, reason, options)

  beforeEach(() => {
    t = createTestDataDb()
    log.error.mockClear()
  })
  afterEach(() => t.close())

  it('owes a note once, keeping the first reason and the lower cursor, and NULL wins', () => {
    owe(['n1'], 'feed_owed', { lowestCursor: 40, now: 1_000 })
    owe(['n1'], 'feed_refused', { lowestCursor: 25, now: 2_000 })
    expect(debt('n1')).toMatchObject({
      reason: 'feed_owed',
      lowestCursor: 25,
      createdAt: 1_000,
      updatedAt: 2_000
    })
    owe(['n1'], 'feed_owed', { lowestCursor: 60 })
    expect(debt('n1')?.lowestCursor).toBe(25)
    owe(['n1'], 'record')
    expect(debt('n1')?.lowestCursor).toBeNull()
    owe(['n1'], 'feed_owed', { lowestCursor: 10 })
    expect(debt('n1')?.lowestCursor).toBeNull()
    expect(listCrdtBodyDebts(db())).toHaveLength(1)
  })

  it('counts only failed pulls, and keeps the count across other debts', () => {
    owe(['n1'], 'pull_failed', { failed: true, now: 1_000 })
    owe(['n1'], 'pull_failed', { failed: true, now: 2_000 })
    owe(['n1'], 'pull_failed', { now: 2_500 })
    owe(['n1'], 'broadcast', { now: 3_000 })
    expect(debt('n1')).toMatchObject({ failures: 2, lastFailedAt: 2_000 })
  })

  // #2297 review A-2, B-M1: backoff runs from the last failure only.
  it('backs a failing debt off from its last failure, 2^(n-1) minutes capped at 32', () => {
    expect([0, 1, 2, 3, 6, 7, 20].map(crdtBodyDebtBackoffMs)).toEqual([
      0,
      MIN,
      2 * MIN,
      4 * MIN,
      32 * MIN,
      32 * MIN,
      32 * MIN
    ])
    owe(['ok'], 'record', { now: 0 })
    owe(['n1', 'n2'], 'pull_failed', { failed: true, now: 0 })
    owe(['n2'], 'pull_failed', { failed: true, now: 0 })
    expect(crdtBodyDebtBackoffUntil(db())).toEqual(
      new Map([
        ['n1', MIN],
        ['n2', 2 * MIN]
      ])
    )
  })

  // #2297 review A-2, B-M1
  it('never extends a backoff with a debt that is not a failure', () => {
    owe(['n1'], 'pull_failed', { failed: true, now: 1_000 })
    owe(['n1'], 'legacy', { now: 50_000 })
    owe(['n1'], 'record', { now: 55_000 })
    expect(crdtBodyDebtBackoffUntil(db()).get('n1')).toBe(1_000 + MIN)
  })

  // #2297 round 2 a-M2: a last failure dated in the future cannot defer past 32 minutes.
  it('clamps a future last failure to now', () => {
    const now = 1_000_000_000
    owe(['n1'], 'pull_failed', { failed: true, now: now + 30 * 24 * 60 * MIN })
    expect(crdtBodyDebtBackoffUntil(db(), now).get('n1')).toBe(now + MIN)
  })

  // #2297 round 2 a-L4: a row whose cause dropped the watermark needs a walk.
  it('says which notes need a walk rather than a probe settle', () => {
    owe(['record'], 'record')
    owe(['compaction'], 'compaction')
    owe(['failing'], 'pull_failed', { failed: true })
    owe(['dropped'], 'record')
    owe(['dropped'], 'pull_failed', { needsWalk: true })
    const store = crdtBodyDebtStore(db())
    expect(
      [...store.needsWalk(['record', 'compaction', 'failing', 'dropped', 'none'])].sort()
    ).toEqual(['compaction', 'dropped', 'failing'])
  })

  // #2421 round 2 ruling 2 (B-5a): the feed's rowless drop is remembered in
  // its own table, apart from the debts. A real debt and the mark coexist,
  // settling a debt leaves the mark, and only an explicit clear removes it.
  it('keeps the withheld mark in its own table, beside a real debt', () => {
    const store = crdtBodyDebtStore(db())
    owe(['n1'], 'feed_owed', { lowestCursor: 5 })
    store.withhold('n1')
    store.withhold('n2')

    expect(store.list().map((d) => [d.noteId, d.reason, d.lowestCursor])).toEqual([
      ['n1', 'feed_owed', 5]
    ])
    expect([store.isWithheld('n1'), store.isWithheld('n2')]).toEqual([true, true])

    store.settle(['n1', 'n2'])
    expect(store.list()).toEqual([])
    expect(store.isWithheld('n1')).toBe(true)

    store.clearWithheld(['n1', 'n2'])
    expect([store.isWithheld('n1'), store.isWithheld('n2')]).toEqual([false, false])
  })

  // #2421 round 2 ruling 2: a missing withheld table degrades to a session
  // set, and the store stops reporting itself durable.
  it('falls back to a session set without the withheld table', () => {
    t.sqlite.exec('DROP TABLE crdt_body_withheld')
    const store = crdtBodyDebtStore(db())
    store.withhold('n1')

    expect(store.isWithheld('n1')).toBe(true)
    expect(store.durable()).toBe(false)
  })

  // #2421 ruling 6: only a usable table is durable.
  // #2421 round 2 ruling 2: probed once per handle, then latched; a table
  // found unusable later turns it off.
  it('reports whether the store is durable', () => {
    const store = crdtBodyDebtStore(db())
    expect(store.durable()).toBe(true)
    t.sqlite.exec('DROP TABLE crdt_body_debts')
    expect(store.durable()).toBe(true)
    store.list()
    expect(store.durable()).toBe(false)
  })

  // #2297 round 2 b-L4: a session-only flag takes a generation from the same counter.
  it('hands out generations to session-only flags from the shared counter', () => {
    const store = crdtBodyDebtStore(db())
    owe(['n1'], 'record')
    const walk = store.generation()
    const flagged = store.bumpGeneration()
    expect(flagged).toBeGreaterThan(walk)
    owe(['n2'], 'record')
    expect(debt('n2')!.generation).toBeGreaterThan(flagged)
  })

  // #2297 round 2 a-L3, b-L1: a table an unreleased round-1 build created heals.
  it('adds the columns a round-1 table lacks, and then works', () => {
    t.sqlite.exec('DROP TABLE crdt_body_debts')
    t.sqlite.exec(
      'CREATE TABLE crdt_body_debts (note_id text PRIMARY KEY NOT NULL, reason text NOT NULL, lowest_cursor integer, failures integer DEFAULT 0 NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL)'
    )
    t.sqlite.exec(
      "INSERT INTO crdt_body_debts (note_id, reason, created_at, updated_at) VALUES ('old', 'record', 1, 1)"
    )
    const store = crdtBodyDebtStore(db())
    store.owe(['n1'], 'pull_failed', { failed: true })
    expect(store.list().map((d) => [d.noteId, d.failures])).toEqual([
      ['old', 0],
      ['n1', 1]
    ])
    expect(store.settle(['old', 'n1'], store.generation()).size).toBe(0)
    expect(log.error).not.toHaveBeenCalled()
  })

  // #2297 review A-4, B-L1: a generation, not the wall clock, guards a settle.
  it('settles only debts raised at or before the generation a walk captured', () => {
    owe(['early'], 'record', { now: 5_000 })
    const walk = currentCrdtBodyDebtGeneration(db())
    // The clock stepped back: wall time would call this debt older than the walk.
    owe(['late'], 'record', { now: 1_000 })
    expect([...settleCrdtBodyDebts(db(), ['early', 'late', 'never'], walk)]).toEqual(['late'])
    expect(listCrdtBodyDebts(db()).map((d) => d.noteId)).toEqual(['late'])
    // A rowless drop settles unguarded.
    expect(settleCrdtBodyDebts(db(), ['late']).size).toBe(0)
    expect(hasCrdtBodyDebts(db())).toBe(false)
  })

  // #2297 review A-4 (supervisor): the generation never goes back when the table empties.
  it('keeps a debt raised after the table emptied mid-walk', () => {
    owe(['x'], 'record')
    const walk = currentCrdtBodyDebtGeneration(db())
    settleCrdtBodyDebts(db(), ['x'], walk)
    expect(hasCrdtBodyDebts(db())).toBe(false)
    owe(['x'], 'broadcast')
    expect([...settleCrdtBodyDebts(db(), ['x'], walk)]).toEqual(['x'])
  })

  // #2297 review A-4 (supervisor): one counter per database for every writer.
  it('gives interleaved owes from two stores on one database strictly rising generations', () => {
    const first = crdtBodyDebtStore(db())
    const second = crdtBodyDebtStore(db())
    const seen: number[] = []
    for (const [store, id] of [
      [first, 'a'],
      [second, 'b'],
      [first, 'c'],
      [second, 'a']
    ] as const) {
      store.owe([id], 'record')
      seen.push(listCrdtBodyDebts(db()).find((d) => d.noteId === id)!.generation)
    }
    expect(seen).toEqual([...seen].sort((x, y) => x - y))
    expect(new Set(seen).size).toBe(seen.length)
  })

  // #2421 part c: the write-only crdtUnmergedDebt mirror is gone; the row an
  // earlier build wrote is left as it is.
  it('writes no crdtUnmergedDebt mirror on owe or settle', () => {
    owe(['n1', 'n2'], 'record', { now: 5_500 })
    expect(state(SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT)).toBeUndefined()
    expect(state(SYNC_STATE_KEYS.CRDT_BODY_DEBT_MIRROR_AT)).toBeUndefined()

    settleCrdtBodyDebts(db(), ['n1', 'n2'], currentCrdtBodyDebtGeneration(db()))
    expect(hasCrdtBodyDebts(db())).toBe(false)
    expect(state(SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT)).toBeUndefined()
    expect(state(SYNC_STATE_KEYS.CRDT_BODY_DEBT_MIRROR_AT)).toBeUndefined()
  })

  it('rolls back with an enclosing transaction', () => {
    t.sqlite.exec('BEGIN IMMEDIATE')
    owe(['n1'], 'record')
    expect(hasCrdtBodyDebts(db())).toBe(true)
    t.sqlite.exec('ROLLBACK')
    expect(hasCrdtBodyDebts(db())).toBe(false)
    expect(state(SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT)).toBeUndefined()
  })

  // #2297 review A-1: a database without the table degrades to session-only.
  it('survives a missing table, logging once', () => {
    t.sqlite.exec('DROP TABLE crdt_body_debts')
    const store = crdtBodyDebtStore(db())
    expect(() => store.owe(['n1'], 'record')).not.toThrow()
    expect(store.settle(['n1'], 0).size).toBe(0)
    expect(store.list()).toEqual([])
    expect(store.generation()).toBe(0)
    expect(store.backoffUntil().size).toBe(0)
    expect(convertUnmergedDebtMirror(db(), () => ['n1'])).toBe(0)
    t.sqlite.exec('BEGIN IMMEDIATE')
    store.owe(['n2'], 'record')
    t.sqlite.exec('COMMIT')
    expect(log.error).toHaveBeenCalledTimes(1)
  })

  describe('converting a crdtUnmergedDebt this build did not write', () => {
    const writeLegacyDebt = (value: string, atMs: number) =>
      db()
        .insert(syncState)
        .values({ key: SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT, value, updatedAt: new Date(atMs) })
        .onConflictDoUpdate({
          target: syncState.key,
          set: { value, updatedAt: new Date(atMs) }
        })
        .run()
    // What an earlier build of this app wrote along with its own mirror.
    const writeOwnMarker = (atMs: number) =>
      db()
        .insert(syncState)
        .values({
          key: SYNC_STATE_KEYS.CRDT_BODY_DEBT_MIRROR_AT,
          value: String(atMs),
          updatedAt: new Date(atMs)
        })
        .onConflictDoUpdate({
          target: syncState.key,
          set: { value: String(atMs), updatedAt: new Date(atMs) }
        })
        .run()

    // #2421 part c: a converted 1 is recorded by its own row time in the
    // marker; the mirror row itself is never rewritten.
    it('owes every note once for a legacy 1 with no mirror marker', () => {
      writeLegacyDebt('1', 1_000)
      expect(convertUnmergedDebtMirror(db(), () => ['a', 'b', 'a'])).toBe(2)
      expect(listCrdtBodyDebts(db()).map((d) => [d.noteId, d.reason, d.lowestCursor])).toEqual([
        ['a', 'legacy', null],
        ['b', 'legacy', null]
      ])
      expect(state(SYNC_STATE_KEYS.CRDT_BODY_DEBT_MIRROR_AT)?.value).toBe('1000')
      expect(state(SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT)).toEqual({ value: '1', at: 1 })
      // Accounted for: a restart converts nothing.
      expect(convertUnmergedDebtMirror(db(), () => ['c'])).toBe(0)
    })

    it('does not convert the mirror an earlier build of its own wrote', () => {
      writeLegacyDebt('1', 3_000)
      writeOwnMarker(3_000)
      expect(convertUnmergedDebtMirror(db(), () => ['x', 'y'])).toBe(0)
      expect(hasCrdtBodyDebts(db())).toBe(false)
    })

    it('converts a 1 written after its own mirror write (an older build after a downgrade)', () => {
      writeLegacyDebt('1', 3_000)
      writeOwnMarker(3_000)
      writeLegacyDebt('1', 20_000)
      expect(convertUnmergedDebtMirror(db(), () => ['x', 'y'])).toBe(2)
      expect(state(SYNC_STATE_KEYS.CRDT_BODY_DEBT_MIRROR_AT)?.value).toBe('20000')
    })

    it('leaves a 0 alone and writes no mirror', () => {
      writeLegacyDebt('0', 1_000)
      expect(convertUnmergedDebtMirror(db(), () => ['x'])).toBe(0)
      owe(['a'], 'record', { now: 3_000 })
      expect(convertUnmergedDebtMirror(db(), () => ['x'])).toBe(0)
      expect(state(SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT)?.value).toBe('0')
    })

    it('records a legacy 1 with no note to owe, so it converts once', () => {
      writeLegacyDebt('1', 1_000)
      expect(convertUnmergedDebtMirror(db(), () => [])).toBe(0)
      expect(convertUnmergedDebtMirror(db(), () => ['x'])).toBe(0)
      expect(state(SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT)?.value).toBe('1')
    })
  })
})

describe('0060_crdt_body_debts migration', () => {
  let tempDir: string
  const migrationsDir = path.join(__dirname, '../../database/drizzle-data')

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-crdt-body-debts-'))
  })
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function makePre0060Folder(): string {
    const copy = path.join(tempDir, 'drizzle-data-pre-0060')
    fs.cpSync(migrationsDir, copy, { recursive: true })
    const journalPath = path.join(copy, 'meta', '_journal.json')
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[]
    }
    const cutoff = journal.entries.findIndex((e) => e.tag === '0060_crdt_body_debts')
    expect(cutoff).toBeGreaterThanOrEqual(0)
    for (const entry of journal.entries.splice(cutoff)) {
      fs.rmSync(path.join(copy, `${entry.tag}.sql`))
    }
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2))
    return copy
  }

  it('adds an empty table on a database at 0059 and leaves existing rows untouched', () => {
    const sqlite = new Database(path.join(tempDir, 'data.db'))
    const db = drizzle(sqlite)
    migrate(db, { migrationsFolder: makePre0060Folder() })
    sqlite
      .prepare(
        "INSERT INTO sync_state (key, value, updated_at) VALUES ('crdtUnmergedDebt', '1', 1)"
      )
      .run()

    migrate(db, { migrationsFolder: migrationsDir })

    expect(sqlite.prepare('SELECT key, value FROM sync_state').all()).toEqual([
      { key: 'crdtUnmergedDebt', value: '1' }
    ])
    expect(sqlite.prepare('SELECT count(*) AS n FROM crdt_body_debts').get()).toEqual({ n: 0 })
    sqlite.close()
  })

  it('is a no-op when applied twice, and inert for an older build', () => {
    const sqlite = new Database(path.join(tempDir, 'data.db'))
    const db = drizzle(sqlite)
    migrate(db, { migrationsFolder: migrationsDir })
    sqlite
      .prepare(
        "INSERT INTO crdt_body_debts (note_id, reason, generation, created_at, updated_at) VALUES ('n1', 'record', 1, 1, 1)"
      )
      .run()
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, '0060_crdt_body_debts.sql'), 'utf8'))
    migrate(db, { migrationsFolder: migrationsDir })
    expect(() => migrate(db, { migrationsFolder: makePre0060Folder() })).not.toThrow()
    expect(sqlite.prepare('SELECT note_id FROM crdt_body_debts').all()).toEqual([{ note_id: 'n1' }])
    sqlite.close()
  })
})
