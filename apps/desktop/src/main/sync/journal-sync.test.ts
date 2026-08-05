import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import { JournalSyncPayloadSchema } from '@memry/contracts/sync-payloads'
import { createTestDataDb, type TestDataDb } from '../../test/helpers/test-data-db'

/**
 * Push side of journal sync. Real `RecordSyncController`, real
 * `SyncQueueManager`, real migrated in-memory data DB, real files on disk —
 * only the vault path/parse edge is faked (the real module pulls in the whole
 * vault runtime).
 */

const h = vi.hoisted(() => ({
  db: null as unknown,
  journalDir: '',
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => h.log
}))

vi.mock('../database/client', () => ({
  getDatabase: () => h.db,
  getIndexDatabase: () => ({})
}))

vi.mock('../vault/journal', async () => {
  const matter = (await import('gray-matter')).default
  return {
    getJournalPath: (date: string) => path.join(h.journalDir, `${date}.md`),
    parseJournalEntry: (raw: string, date: string) => {
      const parsed = matter(raw)
      return { frontmatter: parsed.data, content: parsed.content.trim(), date }
    }
  }
})

import { SyncQueueManager } from './queue'
import {
  JournalSyncService,
  getJournalSyncService,
  initJournalSyncService,
  resetJournalSyncService
} from './journal-sync'

let db: TestDataDb
let queue: SyncQueueManager

const DATE = '2026-05-10'
const JOURNAL_ID = 'journal-2026-05-10'
const CREATED_AT = '2026-05-10T06:00:00.000Z'
const MODIFIED_AT = '2026-05-10T21:30:00.000Z'

function seedJournalNote(overrides: Record<string, unknown> = {}): void {
  db.insert(noteMetadata)
    .values({
      id: JOURNAL_ID,
      path: `journal/${DATE}.md`,
      title: DATE,
      fileType: 'markdown',
      journalDate: DATE,
      clock: {},
      createdAt: CREATED_AT,
      modifiedAt: MODIFIED_AT,
      ...overrides
    } as never)
    .run()
}

function writeJournalFile(date: string, contents: string): void {
  fs.writeFileSync(path.join(h.journalDir, `${date}.md`), contents, 'utf-8')
}

function queueRows(): Array<typeof syncQueue.$inferSelect> {
  return db.select().from(syncQueue).all()
}

function payloadOf(row: typeof syncQueue.$inferSelect | undefined): Record<string, unknown> {
  return JSON.parse(row!.payload) as Record<string, unknown>
}

function storedClock(): unknown {
  return db.select().from(noteMetadata).where(eq(noteMetadata.id, JOURNAL_ID)).get()?.clock
}

function makeService(deviceId: string | null = 'device-a'): JournalSyncService {
  return new JournalSyncService({ queue, getDeviceId: () => deviceId })
}

beforeAll(() => {
  h.journalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-journal-sync-'))
})

afterAll(() => {
  fs.rmSync(h.journalDir, { recursive: true, force: true })
})

beforeEach(() => {
  vi.clearAllMocks()
  db = createTestDataDb()
  h.db = db
  queue = new SyncQueueManager(db)
  resetJournalSyncService()
  writeJournalFile(
    DATE,
    '---\ntags:\n  - daily\nproperties:\n  Mood: good\n---\n\nWoke up early.\n'
  )
})

describe('JournalSyncService push', () => {
  it('enqueues exactly one journal create with the date, body, tags and properties', () => {
    seedJournalNote()

    makeService().enqueueCreate(JOURNAL_ID, DATE)

    const rows = queueRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('journal')
    expect(rows[0].itemId).toBe(JOURNAL_ID)
    expect(rows[0].operation).toBe('create')

    const payload = payloadOf(rows[0])
    expect(payload).toMatchObject({
      date: DATE,
      content: 'Woke up early.',
      tags: ['daily'],
      properties: { Mood: 'good' },
      clock: { 'device-a': 1 },
      createdAt: CREATED_AT,
      modifiedAt: MODIFIED_AT
    })
    expect(JournalSyncPayloadSchema.safeParse(payload).success).toBe(true)
  })

  it('persists the bumped clock on the journal note row', () => {
    seedJournalNote({ clock: { 'device-b': 2 } })

    makeService().enqueueCreate(JOURNAL_ID, DATE)

    expect(storedClock()).toEqual({ 'device-b': 2, 'device-a': 1 })
  })

  it('keeps the date and tags on an update even though the body is omitted', () => {
    seedJournalNote()

    makeService().enqueueUpdate(JOURNAL_ID, DATE)

    const payload = payloadOf(queueRows()[0])
    expect(queueRows()[0].operation).toBe('update')
    expect(payload.date).toBe(DATE)
    expect(payload.content).toBeNull()
    expect(payload.tags).toEqual(['daily'])
    expect(payload.properties).toEqual({ Mood: 'good' })
  })

  it('coalesces a follow-up update into the pending create with the newest frontmatter', () => {
    seedJournalNote()
    const service = makeService()

    service.enqueueCreate(JOURNAL_ID, DATE)
    writeJournalFile(DATE, '---\ntags:\n  - daily\n  - gratitude\n---\n\nWoke up early.\n')
    service.enqueueUpdate(JOURNAL_ID, DATE)

    const rows = queueRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].operation).toBe('create')
    expect(payloadOf(rows[0]).tags).toEqual(['daily', 'gratitude'])
  })

  it('still pushes the date when the journal file cannot be read', () => {
    seedJournalNote()
    fs.rmSync(path.join(h.journalDir, `${DATE}.md`))

    makeService().enqueueCreate(JOURNAL_ID, DATE)

    const payload = payloadOf(queueRows()[0])
    expect(payload).toMatchObject({ date: DATE, content: null, tags: [], properties: null })
    expect(JournalSyncPayloadSchema.safeParse(payload).success).toBe(true)
    expect(h.log.warn).toHaveBeenCalledWith(
      'Could not read journal file for sync snapshot',
      expect.objectContaining({ noteId: JOURNAL_ID, date: DATE })
    )
  })

  it('never pushes a local-only journal and leaves its clock untouched', () => {
    seedJournalNote({ localOnly: true })

    makeService().enqueueCreate(JOURNAL_ID, DATE)

    expect(queueRows()).toEqual([])
    expect(storedClock()).toEqual({})
  })

  it('skips a journal that is not in the metadata cache', () => {
    makeService().enqueueUpdate('journal-missing', '2026-01-01')

    expect(queueRows()).toEqual([])
  })

  it('skips and warns when no device id is available yet', () => {
    seedJournalNote()

    makeService(null).enqueueUpdate(JOURNAL_ID, DATE)

    expect(queueRows()).toEqual([])
    expect(storedClock()).toEqual({})
    expect(h.log.warn).toHaveBeenCalledWith(
      'No device ID, skipping journal update enqueue',
      expect.objectContaining({ itemId: JOURNAL_ID })
    )
  })
})

describe('JournalSyncService deletes', () => {
  it('propagates a delete as a bumped clock with NO journal date', () => {
    seedJournalNote({ clock: { 'device-a': 3 } })

    makeService().enqueueDelete(JOURNAL_ID, DATE)

    const rows = queueRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('journal')
    expect(rows[0].operation).toBe('delete')
    // The tombstone must not carry the journalled day. Nothing on the receiving
    // side reads it — ItemApplier never decodes a delete body — so shipping it
    // only widened what every delete encrypts, uploads and parks in the local
    // plaintext sync queue. The clock MUST survive: push-coordinator lifts it
    // out of this string to stamp the server-side item version.
    expect(payloadOf(rows[0])).toEqual({
      clock: { 'device-a': 4 },
      createdAt: CREATED_AT,
      modifiedAt: MODIFIED_AT
    })
  })

  it('still propagates the delete when the metadata row is already gone', () => {
    // Unlike notes, a journal delete is enqueued even without a cache row, so a
    // missing row must not swallow the delete.
    makeService().enqueueDelete('journal-2026-01-01', '2026-01-01')

    const rows = queueRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].operation).toBe('delete')
    expect(payloadOf(rows[0])).toEqual({ clock: { 'device-a': 1 } })
  })

  it('emits a tombstone the current schema accepts, date key entirely absent', () => {
    seedJournalNote()

    makeService().enqueueDelete(JOURNAL_ID, DATE)

    const payload = payloadOf(queueRows()[0])
    expect(Object.prototype.hasOwnProperty.call(payload, 'date')).toBe(false)
    expect(JournalSyncPayloadSchema.safeParse(payload).success).toBe(true)
  })

  it('lets a delete win over a still-pending create instead of being dropped', () => {
    seedJournalNote()
    const service = makeService()

    service.enqueueCreate(JOURNAL_ID, DATE)
    service.enqueueDelete(JOURNAL_ID, DATE)

    const rows = queueRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].operation).toBe('delete')
  })

  it('does not enqueue a delete without a device id', () => {
    seedJournalNote()

    makeService(null).enqueueDelete(JOURNAL_ID, DATE)

    expect(queueRows()).toEqual([])
  })
})

describe('journal sync service lifecycle', () => {
  it('tracks the module-level singleton', () => {
    expect(getJournalSyncService()).toBeNull()

    const service = initJournalSyncService({ queue, getDeviceId: () => 'device-a' })
    expect(getJournalSyncService()).toBe(service)

    resetJournalSyncService()
    expect(getJournalSyncService()).toBeNull()
  })
})
