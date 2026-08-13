import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import { NoteSyncPayloadSchema } from '@memry/contracts/sync-payloads'
import { createTestDataDb, type TestDataDb } from '../../test/helpers/test-data-db'

/**
 * Push side of note sync: a local note mutation -> an outbound queue row.
 *
 * Everything below runs the REAL `RecordSyncController`, the REAL
 * `SyncQueueManager` and a REAL migrated in-memory data DB, so a queue row is
 * only asserted after it has actually been written (and coalesced) by the
 * production code path. Only the vault/index-DB edges are faked.
 */

const h = vi.hoisted(() => ({
  db: null as unknown,
  vaultDir: '',
  properties: [] as Array<{ name: string; value: unknown }>,
  pinnedTags: [] as string[],
  renameCallback: null as ((id: string) => void) | null,
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

vi.mock('@main/database/queries/notes', () => ({
  getNoteProperties: () => h.properties
}))

vi.mock('./item-handlers/note-pin-helpers', () => ({
  getPinnedTagsForNote: () => h.pinnedTags
}))

vi.mock('../vault/notes', () => ({
  toAbsolutePath: (relativePath: string) => path.join(h.vaultDir, relativePath)
}))

vi.mock('../vault/index', () => ({
  getConfig: () => ({ defaultNoteFolder: 'notes' })
}))

vi.mock('../vault/rename-tracker', () => ({
  registerRenameSyncCallback: (cb: (id: string) => void) => {
    h.renameCallback = cb
  },
  unregisterRenameSyncCallback: () => {
    h.renameCallback = null
  }
}))

import { SyncQueueManager } from './queue'
import {
  NoteSyncService,
  extractFolderFromPath,
  getNoteSyncService,
  initNoteSyncService,
  resetNoteSyncService
} from './note-sync'

let db: TestDataDb
let queue: SyncQueueManager

const CREATED_AT = '2026-05-01T10:00:00.000Z'
const MODIFIED_AT = '2026-05-02T11:00:00.000Z'

function seedNote(overrides: Record<string, unknown> = {}): void {
  db.insert(noteMetadata)
    .values({
      id: 'note-1',
      path: 'notes/Projects/Plan.md',
      title: 'Quarterly Plan',
      fileType: 'markdown',
      clock: {},
      createdAt: CREATED_AT,
      modifiedAt: MODIFIED_AT,
      ...overrides
    } as never)
    .run()
}

function writeNoteFile(relativePath: string, contents: string): void {
  const absolute = path.join(h.vaultDir, relativePath)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, contents, 'utf-8')
}

function queueRows(): Array<typeof syncQueue.$inferSelect> {
  return db.select().from(syncQueue).all()
}

function payloadOf(row: typeof syncQueue.$inferSelect | undefined): Record<string, unknown> {
  return JSON.parse(row!.payload) as Record<string, unknown>
}

function storedClock(id = 'note-1'): unknown {
  return db.select().from(noteMetadata).where(eq(noteMetadata.id, id)).get()?.clock
}

function makeService(deviceId: string | null = 'device-a'): NoteSyncService {
  return new NoteSyncService({ queue, getDeviceId: () => deviceId })
}

beforeAll(() => {
  h.vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-note-sync-'))
})

afterAll(() => {
  fs.rmSync(h.vaultDir, { recursive: true, force: true })
})

beforeEach(() => {
  vi.clearAllMocks()
  db = createTestDataDb()
  h.db = db
  queue = new SyncQueueManager(db)
  h.properties = [{ name: 'Status', value: 'Draft' }]
  h.pinnedTags = ['roadmap']
  h.renameCallback = null
  resetNoteSyncService()
  writeNoteFile('notes/Projects/Plan.md', '---\ntags:\n  - roadmap\n  - q3\n---\n\nBody text\n')
})

describe('NoteSyncService push', () => {
  it('enqueues exactly one note create carrying the title, body and tags the user sees', () => {
    seedNote()

    makeService().enqueueCreate('note-1')

    const rows = queueRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('note')
    expect(rows[0].itemId).toBe('note-1')
    expect(rows[0].operation).toBe('create')

    const payload = payloadOf(rows[0])
    // `parseNote` preserves the body bytes verbatim, so match on substance.
    expect(payload.content).toContain('Body text')
    expect(payload).toMatchObject({
      title: 'Quarterly Plan',
      tags: ['roadmap', 'q3'],
      properties: { Status: 'Draft' },
      pinnedTags: ['roadmap'],
      folderPath: 'notes/Projects',
      fileType: 'markdown',
      clock: { 'device-a': 1 },
      createdAt: CREATED_AT,
      modifiedAt: MODIFIED_AT
    })
    expect(NoteSyncPayloadSchema.safeParse(payload).success).toBe(true)
  })

  it('persists the bumped clock on the note row so the push is not replayed from a stale clock', () => {
    seedNote({ clock: { 'device-b': 4 } })

    makeService().enqueueCreate('note-1')

    expect(storedClock()).toEqual({ 'device-b': 4, 'device-a': 1 })
    expect(payloadOf(queueRows()[0]).clock).toEqual({ 'device-b': 4, 'device-a': 1 })
  })

  it('keeps the title on a metadata-only update even though the body is omitted', () => {
    seedNote()

    // `update` deliberately ships `content: null` (the body travels via CRDT),
    // so the title is the only user-visible text in the payload. Losing it here
    // is exactly how a note lands on the other device as "Untitled".
    makeService().enqueueUpdate('note-1')

    const payload = payloadOf(queueRows()[0])
    expect(queueRows()[0].operation).toBe('update')
    expect(payload.title).toBe('Quarterly Plan')
    expect(payload.content).toBeNull()
    expect(payload.tags).toEqual(['roadmap', 'q3'])
  })

  it('rewrites the pending push with the NEW title when a rename lands before the flush', () => {
    seedNote()
    const service = makeService()

    service.enqueueCreate('note-1')
    db.update(noteMetadata)
      .set({ title: 'Renamed Plan' })
      .where(eq(noteMetadata.id, 'note-1'))
      .run()
    service.enqueueUpdate('note-1')

    // The queue coalesces onto the pending row; the surviving payload must carry
    // the renamed title, never the stale one.
    const rows = queueRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].operation).toBe('create')
    expect(payloadOf(rows[0]).title).toBe('Renamed Plan')
  })

  it('pushes binary notes as attachment metadata without reading the file', () => {
    seedNote({
      path: 'notes/Files/Report.pdf',
      title: 'Report',
      fileType: 'pdf',
      mimeType: 'application/pdf',
      attachmentId: 'attachment-1'
    })

    makeService().enqueueUpdate('note-1')

    const payload = payloadOf(queueRows()[0])
    expect(payload).toMatchObject({
      title: 'Report',
      fileType: 'pdf',
      mimeType: 'application/pdf',
      attachmentId: 'attachment-1',
      folderPath: 'notes/Files'
    })
    expect(payload).not.toHaveProperty('content')
    expect(NoteSyncPayloadSchema.safeParse(payload).success).toBe(true)
  })

  it('still pushes the title when the note file cannot be read', () => {
    seedNote({ path: 'notes/Projects/Missing.md' })

    makeService().enqueueCreate('note-1')

    const payload = payloadOf(queueRows()[0])
    expect(payload.title).toBe('Quarterly Plan')
    expect(payload.content).toBeNull()
    expect(payload.tags).toEqual([])
    expect(h.log.warn).toHaveBeenCalledWith(
      'Could not read note file for sync snapshot',
      expect.objectContaining({ noteId: 'note-1' })
    )
  })

  it('never pushes a local-only note and leaves its clock untouched', () => {
    seedNote({ localOnly: true })

    const service = makeService()
    service.enqueueCreate('note-1')
    service.enqueueUpdate('note-1')

    expect(queueRows()).toEqual([])
    expect(storedClock()).toEqual({})
  })

  it('skips notes that are not in the metadata cache', () => {
    makeService().enqueueUpdate('ghost-note')

    expect(queueRows()).toEqual([])
  })

  it('skips and warns when no device id is available yet', () => {
    seedNote()

    makeService(null).enqueueUpdate('note-1')

    expect(queueRows()).toEqual([])
    expect(storedClock()).toEqual({})
    expect(h.log.warn).toHaveBeenCalledWith(
      'No device ID, skipping note update enqueue',
      expect.objectContaining({ itemId: 'note-1' })
    )
  })
})

describe('NoteSyncService deletes', () => {
  it('propagates a delete as its own queue row with a bumped clock and NO title', () => {
    seedNote({ clock: { 'device-a': 2 } })

    makeService().enqueueDelete('note-1')

    const rows = queueRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('note')
    expect(rows[0].operation).toBe('delete')
    expect(payloadOf(rows[0])).toMatchObject({
      clock: { 'device-a': 3 },
      createdAt: CREATED_AT,
      modifiedAt: MODIFIED_AT
    })
    // The tombstone must not carry the note's title. Nothing on the receiving
    // side reads it, so shipping it only widened what a delete uploads.
    expect(payloadOf(rows[0])).not.toHaveProperty('title')
  })

  it('never tombstones a local-only note', () => {
    // localOnly is the user's "this never leaves my machine" switch. The shared
    // controller applies it to creates/updates only, so the delete path needs
    // its own guard or the promise breaks at exactly the wrong moment.
    seedNote({ localOnly: true })

    makeService().enqueueDelete('note-1')

    expect(queueRows()).toEqual([])
  })

  it('lets a delete win over a still-pending create instead of being dropped', () => {
    seedNote()
    const service = makeService()

    service.enqueueCreate('note-1')
    service.enqueueDelete('note-1')

    const rows = queueRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].operation).toBe('delete')
  })

  it('drops a delete for a note the cache never knew about', () => {
    makeService().enqueueDelete('ghost-note')

    expect(queueRows()).toEqual([])
    expect(h.log.warn).toHaveBeenCalledWith('Note not found in cache for delete enqueue')
  })

  it('removes queued pushes for an item on request', () => {
    seedNote()
    const service = makeService()
    service.enqueueCreate('note-1')

    expect(service.removeQueueItems('note-1')).toBe(1)
    expect(queueRows()).toEqual([])
  })
})

describe('NoteSyncService recovery pushes', () => {
  it('re-queues a lost push without advancing the clock again', () => {
    seedNote({ clock: { 'device-a': 7 } })

    makeService().enqueueRecoveredUpdate('note-1')

    // The stored clock is the one that never reached the server; bumping it
    // again would only widen the gap.
    expect(storedClock()).toEqual({ 'device-a': 7 })
    const rows = queueRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].operation).toBe('update')
    expect(payloadOf(rows[0])).toMatchObject({
      title: 'Quarterly Plan',
      clock: { 'device-a': 7 }
    })
  })

  it('does not re-queue a recovered push for a local-only note', () => {
    seedNote({ localOnly: true })

    makeService().enqueueRecoveredUpdate('note-1')

    expect(queueRows()).toEqual([])
  })
})

describe('note sync service lifecycle', () => {
  it('registers a rename callback that pushes the new title, and unregisters on reset', () => {
    seedNote()
    expect(getNoteSyncService()).toBeNull()

    const service = initNoteSyncService({ queue, getDeviceId: () => 'device-a' })
    expect(getNoteSyncService()).toBe(service)
    expect(h.renameCallback).toBeTypeOf('function')

    db.update(noteMetadata)
      .set({ title: 'Renamed By Watcher' })
      .where(eq(noteMetadata.id, 'note-1'))
      .run()
    h.renameCallback!('note-1')

    const rows = queueRows()
    expect(rows).toHaveLength(1)
    expect(payloadOf(rows[0]).title).toBe('Renamed By Watcher')

    resetNoteSyncService()
    expect(h.renameCallback).toBeNull()
    expect(getNoteSyncService()).toBeNull()
  })
})

describe('extractFolderFromPath', () => {
  it('returns the vault-relative folder', () => {
    expect(extractFolderFromPath('Projects/Plan.md')).toBe('Projects')
    expect(extractFolderFromPath('Projects/Q3/Plan.md')).toBe('Projects/Q3')
  })

  it('keeps the configured note root as an ordinary folder segment (#1204)', () => {
    // `defaultNoteFolder` is a destination for new notes, not a tree root, so
    // it must not be stripped off the wire: two devices that disagree about it
    // still have to agree about where the note lives.
    expect(extractFolderFromPath('notes/Projects/Plan.md')).toBe('notes/Projects')
    expect(extractFolderFromPath('notes/Plan.md')).toBe('notes')
  })

  it('returns null for notes that sit directly in the vault root', () => {
    expect(extractFolderFromPath('Plan.md')).toBeNull()
  })
})
