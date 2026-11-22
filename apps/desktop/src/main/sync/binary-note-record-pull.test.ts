import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type * as ClientModule from '../database/client'
import type * as StatusModule from '../vault/status'

/**
 * #5419: shipped builds pushed a binary note as a markdown record (no
 * attachment). Through the real note handler, push builder and sync queue
 * against real migrated data and index DBs and real files. The mocks are the
 * module-level database handles, the vault root, the write-back marker and
 * the logger (the count log is part of the contract).
 */
let activeDb: unknown = null
let activeIndexDb: unknown = null
let vaultRoot = ''

const logged = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }))

vi.mock('../database/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClientModule>()),
  getDatabase: () => activeDb,
  getIndexDatabase: () => activeIndexDb
}))

vi.mock('../vault/status', async (importOriginal) => {
  const actual = await importOriginal<typeof StatusModule>()
  return { ...actual, getStatus: () => ({ ...actual.getStatus(), path: vaultRoot }) }
})

vi.mock('./crdt-writeback', () => ({ markWritebackIgnored: vi.fn() }))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ ...logged, error: vi.fn(), debug: vi.fn() })
}))

import fs from 'fs'
import os from 'os'
import path from 'path'
import { eq } from 'drizzle-orm'
import type { VectorClock } from '@memry/contracts/sync-api'
import { NoteSyncPayloadSchema, type NoteSyncPayload } from '@memry/contracts/sync-payloads'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import {
  asSyncDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { createMockDeps } from '@tests/utils/engine-mocks'
import { initNoteSyncService, resetNoteSyncService } from './note-sync'
import { noteHandler } from './item-handlers/note-handler'

const DEVICE = 'device-1'
const PEER = 'device-2'
const NOTE_ID = 'note-scan'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49])
const BASE_CLOCK: VectorClock = { [DEVICE]: 1, [PEER]: 3 }
const NOW = '2024-04-01T12:00:00.000Z'

let dataDb: TestDatabaseResult
let indexDb: TestDatabaseResult

function seedRow(row: Partial<typeof noteMetadata.$inferInsert>): void {
  dataDb.db
    .insert(noteMetadata)
    .values({
      id: NOTE_ID,
      path: 'scan.png',
      title: 'scan',
      fileType: 'image',
      mimeType: 'image/png',
      fileSize: PNG.length,
      attachmentId: 'blob-png',
      clock: BASE_CLOCK,
      syncedAt: '2024-03-01T10:00:00.000Z',
      createdAt: '2024-02-01T10:00:00.000Z',
      modifiedAt: '2024-03-01T10:00:00.000Z',
      ...row
    })
    .run()
}

function readRow(): typeof noteMetadata.$inferSelect | undefined {
  return dataDb.db.select().from(noteMetadata).where(eq(noteMetadata.id, NOTE_ID)).get()
}

function queued(): NoteSyncPayload[] {
  return dataDb.db
    .select()
    .from(syncQueue)
    .all()
    .map((row) => NoteSyncPayloadSchema.parse(JSON.parse(row.payload)))
}

/** What a shipped build pushed for a binary note its write-back retyped. */
function markdownRecord(clock: VectorClock): NoteSyncPayload {
  return {
    title: 'scan',
    content: 'text the write-back put in the file\n',
    tags: [],
    properties: {},
    pinnedTags: [],
    emoji: null,
    fileType: 'markdown',
    folderPath: null,
    clock,
    createdAt: '2024-02-01T10:00:00.000Z',
    modifiedAt: '2024-03-05T10:00:00.000Z'
  }
}

function pull(record: NoteSyncPayload): string {
  const ctx = { db: asSyncDb(dataDb.db), emit: vi.fn() }
  return noteHandler.applyUpsert(ctx, NOTE_ID, record, record.clock ?? {})
}

function warned(message: string): unknown[][] {
  return logged.warn.mock.calls.filter(([m]) => m === message)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  logged.warn.mockClear()
  logged.info.mockClear()
  dataDb = createTestDataDb()
  indexDb = createTestIndexDb()
  activeDb = dataDb.db
  activeIndexDb = indexDb.db
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-binary-note-record-'))
  initNoteSyncService({ queue: createMockDeps(dataDb).queue, getDeviceId: () => DEVICE })
})

afterEach(() => {
  vi.useRealTimers()
  resetNoteSyncService()
  dataDb.close()
  indexDb.close()
  fs.rmSync(vaultRoot, { recursive: true, force: true })
})

describe('a markdown record for a note this device holds as a good binary file', () => {
  beforeEach(() => {
    seedRow({})
    fs.writeFileSync(path.join(vaultRoot, 'scan.png'), PNG)
  })

  it('keeps the binary row and file and re-pushes the binary record past the markdown one', () => {
    const remoteClock = { [DEVICE]: 1, [PEER]: 4 }

    pull(markdownRecord(remoteClock))

    expect(readRow()).toMatchObject({
      path: 'scan.png',
      fileType: 'image',
      mimeType: 'image/png',
      attachmentId: 'blob-png'
    })
    expect(fs.readFileSync(path.join(vaultRoot, 'scan.png'))).toEqual(PNG)
    expect(fs.existsSync(path.join(vaultRoot, 'scan.md'))).toBe(false)
    expect(queued()).toEqual([
      expect.objectContaining({
        fileType: 'image',
        mimeType: 'image/png',
        attachmentId: 'blob-png',
        clock: { [DEVICE]: 2, [PEER]: 4 }
      })
    ])
    expect(warned('Re-pushed a binary note whose server record was markdown')).toEqual([
      ['Re-pushed a binary note whose server record was markdown', { itemId: NOTE_ID }]
    ])
  })

  it('answers one markdown record once, however often it is pulled', () => {
    pull(markdownRecord({ [DEVICE]: 1, [PEER]: 4 }))
    pull(markdownRecord({ [DEVICE]: 1, [PEER]: 4 }))

    expect(queued()).toHaveLength(1)
  })

  it('answers a later markdown record again: a device that took the markdown record pushed it again', () => {
    pull(markdownRecord({ [DEVICE]: 1, [PEER]: 4 }))
    dataDb.db.delete(syncQueue).run()
    pull({
      ...markdownRecord({ [DEVICE]: 2, [PEER]: 4 }),
      content: undefined,
      fileType: 'image',
      mimeType: 'image/png',
      attachmentId: 'blob-png'
    })
    pull(markdownRecord({ [DEVICE]: 2, [PEER]: 6 }))

    expect(queued()).toEqual([
      expect.objectContaining({
        fileType: 'image',
        attachmentId: 'blob-png',
        clock: { [DEVICE]: 3, [PEER]: 6 }
      })
    ])
    expect(readRow()).toMatchObject({ fileType: 'image', attachmentId: 'blob-png' })
    expect(fs.readFileSync(path.join(vaultRoot, 'scan.png'))).toEqual(PNG)
  })

  it('does not re-push for a binary record', () => {
    pull({
      ...markdownRecord({ [DEVICE]: 1, [PEER]: 4 }),
      content: undefined,
      fileType: 'image',
      mimeType: 'image/png',
      attachmentId: 'blob-png'
    })

    expect(queued()).toEqual([])
  })
})

describe('a markdown record for a note this device holds as markdown', () => {
  it('applies as before and re-pushes nothing (the user renamed the file to .md here)', () => {
    seedRow({ path: 'scan.md', fileType: 'markdown', mimeType: null })
    fs.writeFileSync(path.join(vaultRoot, 'scan.md'), 'my notes\n')

    pull(markdownRecord({ [DEVICE]: 1, [PEER]: 4 }))

    expect(readRow()).toMatchObject({ path: 'scan.md', fileType: 'markdown' })
    expect(queued()).toEqual([])
  })
})

describe('a device that first sees the note through the markdown record', () => {
  it('creates a markdown note beside an unrelated binary file without touching it', () => {
    fs.writeFileSync(path.join(vaultRoot, 'scan.png'), PNG)

    pull(markdownRecord(BASE_CLOCK))

    expect(readRow()).toMatchObject({ path: 'scan.md', fileType: 'markdown' })
    expect(fs.readFileSync(path.join(vaultRoot, 'scan.png'))).toEqual(PNG)
  })

  it('keeps the markdown note when the re-pushed binary record arrives and counts it', () => {
    pull(markdownRecord(BASE_CLOCK))
    const before = fs.readFileSync(path.join(vaultRoot, 'scan.md'), 'utf-8')

    pull({
      ...markdownRecord({ [DEVICE]: 2, [PEER]: 4 }),
      content: undefined,
      tags: undefined,
      properties: undefined,
      pinnedTags: undefined,
      fileType: 'image',
      mimeType: 'image/png',
      attachmentId: 'blob-png'
    })

    expect(readRow()).toMatchObject({ path: 'scan.md', fileType: 'markdown' })
    expect(fs.readFileSync(path.join(vaultRoot, 'scan.md'), 'utf-8')).toBe(before)
    expect(queued()).toEqual([])
    expect(warned('Kept a markdown note that its server record now says is a binary file')).toEqual(
      [
        [
          'Kept a markdown note that its server record now says is a binary file',
          { itemId: NOTE_ID }
        ]
      ]
    )
  })
})

describe('a markdown-typed row at a binary path (#5412 rows)', () => {
  it('stays binary when a binary record renames it: the file keeps its bytes and its .png', () => {
    seedRow({ fileType: 'markdown', mimeType: null })
    fs.writeFileSync(path.join(vaultRoot, 'scan.png'), PNG)

    pull({
      ...markdownRecord({ [DEVICE]: 1, [PEER]: 4 }),
      title: 'renamed',
      content: undefined,
      fileType: 'image',
      mimeType: 'image/png',
      attachmentId: 'blob-png'
    })

    expect(readRow()).toMatchObject({
      path: 'renamed.png',
      fileType: 'image',
      mimeType: 'image/png',
      attachmentId: 'blob-png'
    })
    expect(fs.readFileSync(path.join(vaultRoot, 'renamed.png'))).toEqual(PNG)
    expect(fs.existsSync(path.join(vaultRoot, 'renamed.md'))).toBe(false)
    expect(fs.existsSync(path.join(vaultRoot, 'scan.png'))).toBe(false)
  })

  it('pushes a binary record, with the attachment, so new devices get the file', () => {
    seedRow({ fileType: 'markdown', mimeType: null })
    fs.writeFileSync(path.join(vaultRoot, 'scan.png'), 'text the write-back put in the file\n')

    const built = noteHandler.buildPushPayload(asSyncDb(dataDb.db), NOTE_ID, DEVICE, 'update')

    expect(NoteSyncPayloadSchema.parse(JSON.parse(built ?? 'null'))).toMatchObject({
      fileType: 'image',
      mimeType: 'image/png',
      attachmentId: 'blob-png'
    })
  })
})
