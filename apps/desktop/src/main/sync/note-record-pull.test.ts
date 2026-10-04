import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * A record pull of a note that this device already holds, through the real
 * note handler against real migrated data and index DBs. The mocks are the
 * module-level database handles, the vault root and the write-back marker.
 */
let activeDb: unknown = null
let activeIndexDb: unknown = null
let vaultRoot = ''

vi.mock('../database/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../database/client')>()),
  getDatabase: () => activeDb,
  getIndexDatabase: () => activeIndexDb
}))

vi.mock('../vault/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../vault/index')>()
  return { ...actual, getStatus: () => ({ ...actual.getStatus(), path: vaultRoot }) }
})

vi.mock('./crdt-writeback', () => ({ markWritebackIgnored: vi.fn() }))

import fs from 'fs'
import os from 'os'
import path from 'path'
import { eq } from 'drizzle-orm'
import type { VectorClock } from '@memry/contracts/sync-api'
import { NoteSyncPayloadSchema, type NoteSyncPayload } from '@memry/contracts/sync-payloads'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { getNoteCacheById } from '@main/database/queries/notes'
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
const NOTE_ID = 'note-pulled'
const NOTE_PATH = 'pulled.md'
const NOTE_FILE = '---\ntags:\n  - draft\n---\nLocal body\n'
const CLOCK: VectorClock = { [DEVICE]: 1, [PEER]: 3 }
const SYNCED_AT = '2024-03-01T10:00:00.000Z'
const LOCAL_EDIT = '2024-03-02T10:00:00.000Z'
const REMOTE_EDIT = '2024-03-03T10:00:00.000Z'
const NOW = '2024-04-01T12:00:00.000Z'

let dataDb: TestDatabaseResult
let indexDb: TestDatabaseResult

function seedNote(
  row: { syncedAt: string; modifiedAt: string } & Partial<typeof noteMetadata.$inferInsert>
): void {
  dataDb.db
    .insert(noteMetadata)
    .values({
      id: NOTE_ID,
      path: NOTE_PATH,
      title: 'pulled',
      fileType: 'markdown',
      clock: CLOCK,
      createdAt: '2024-02-01T10:00:00.000Z',
      ...row
    })
    .run()
}

function readNote(): typeof noteMetadata.$inferSelect | undefined {
  return dataDb.db.select().from(noteMetadata).where(eq(noteMetadata.id, NOTE_ID)).get()
}

function queuedClocks(): VectorClock[] {
  return dataDb.db
    .select()
    .from(syncQueue)
    .all()
    .map((row) => (JSON.parse(row.payload) as { clock: VectorClock }).clock)
}

/** The record this device would push for the note right now. */
function localPayload(): NoteSyncPayload {
  const built = noteHandler.buildPushPayload(asSyncDb(dataDb.db), NOTE_ID, DEVICE, 'update')
  return NoteSyncPayloadSchema.parse(JSON.parse(built ?? 'null'))
}

function pullAtEqualClock(remote: NoteSyncPayload): string {
  const ctx = { db: asSyncDb(dataDb.db), emit: vi.fn() }
  return noteHandler.applyUpsert(ctx, NOTE_ID, { ...remote, clock: CLOCK }, CLOCK)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  dataDb = createTestDataDb()
  indexDb = createTestIndexDb()
  activeDb = dataDb.db
  activeIndexDb = indexDb.db
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-note-record-pull-'))
  fs.writeFileSync(path.join(vaultRoot, NOTE_PATH), NOTE_FILE)
  initNoteSyncService({ queue: createMockDeps(dataDb).queue, getDeviceId: () => DEVICE })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  resetNoteSyncService()
  dataDb.close()
  indexDb.close()
  fs.rmSync(vaultRoot, { recursive: true, force: true })
})

describe('equal-clock pull of a note', () => {
  it('skips the payload this row would push and stamps the row synced', () => {
    seedNote({ syncedAt: SYNCED_AT, modifiedAt: LOCAL_EDIT })

    const result = pullAtEqualClock(localPayload())

    expect(result).toBe('skipped')
    expect(readNote()).toMatchObject({ clock: CLOCK, syncedAt: NOW, modifiedAt: LOCAL_EDIT })
    expect(queuedClocks()).toEqual([])
  })

  it('applies a different payload and takes its newer modifiedAt (#2294)', () => {
    seedNote({ syncedAt: LOCAL_EDIT, modifiedAt: SYNCED_AT })
    const remote = { ...localPayload(), modifiedAt: REMOTE_EDIT, properties: { status: 'done' } }

    const result = pullAtEqualClock(remote)

    expect(result).toBe('applied')
    expect(readNote()).toMatchObject({ modifiedAt: REMOTE_EDIT, syncedAt: NOW, clock: CLOCK })
    expect(queuedClocks()).toEqual([])
  })
})

// A body edit moves `modifiedAt` without a clock bump, so a record pull can
// carry an older edit time than the row. Applying it moved modified times back
// to creation times (AF-002, #2616).
describe('record pull of a note never moves modifiedAt backwards', () => {
  it.each([
    {
      name: 'an older remote time at an equal clock',
      clock: CLOCK,
      local: '2024-03-02T10:00:00.000Z',
      remote: '2024-03-01T10:00:00.000Z',
      kept: '2024-03-02T10:00:00.000Z'
    },
    {
      name: 'an older remote time from a dominating clock',
      clock: { [DEVICE]: 1, [PEER]: 4 },
      local: '2024-03-02T10:00:00.000Z',
      remote: '2024-03-01T10:00:00.000Z',
      kept: '2024-03-02T10:00:00.000Z'
    },
    {
      name: 'an older remote time from a concurrent clock',
      clock: { [PEER]: 4 },
      local: '2024-03-02T10:00:00.000Z',
      remote: '2024-03-01T10:00:00.000Z',
      kept: '2024-03-02T10:00:00.000Z'
    },
    {
      name: 'a remote time without millis that is earlier',
      clock: CLOCK,
      local: '2024-03-02T10:00:05.123Z',
      remote: '2024-03-02T10:00:05Z',
      kept: '2024-03-02T10:00:05.123Z'
    },
    {
      name: 'a remote time with millis that is later',
      clock: CLOCK,
      local: '2024-03-02T10:00:05Z',
      remote: '2024-03-02T10:00:05.123Z',
      kept: '2024-03-02T10:00:05.123Z'
    },
    {
      name: 'a remote offset time that is earlier',
      clock: CLOCK,
      local: '2024-03-02T10:00:00.000Z',
      remote: '2024-03-02T11:00:00+02:00',
      kept: '2024-03-02T10:00:00.000Z'
    },
    {
      name: 'a remote offset time that is later',
      clock: CLOCK,
      local: '2024-03-02T10:00:00.000Z',
      remote: '2024-03-02T13:00:00+02:00',
      kept: '2024-03-02T13:00:00+02:00'
    }
  ])('$name keeps $kept and applies the other fields', ({ clock, local, remote, kept }) => {
    seedNote({ syncedAt: SYNCED_AT, modifiedAt: local })
    indexDb.db
      .insert(noteCache)
      .values({
        id: NOTE_ID,
        path: NOTE_PATH,
        title: 'pulled',
        createdAt: '2024-02-01T10:00:00.000Z',
        modifiedAt: local
      })
      .run()
    const payload = { ...localPayload(), modifiedAt: remote, properties: { status: 'done' } }
    const ctx = { db: asSyncDb(dataDb.db), emit: vi.fn() }

    noteHandler.applyUpsert(ctx, NOTE_ID, { ...payload, clock }, clock)

    expect(readNote()?.modifiedAt).toBe(kept)
    expect(getNoteCacheById(indexDb.db, NOTE_ID)?.modifiedAt).toBe(kept)
    expect(readNote()?.syncedAt).toBe(NOW)
    expect(fs.readFileSync(path.join(vaultRoot, NOTE_PATH), 'utf-8')).toBe(
      '---\ntags:\n  - draft\nstatus: done\n---\nLocal body\n'
    )
  })

  it('keeps the later local time of a binary note and applies the other fields', () => {
    seedNote({
      path: 'scan.png',
      fileType: 'image',
      mimeType: 'image/png',
      syncedAt: SYNCED_AT,
      modifiedAt: LOCAL_EDIT
    })
    const payload = { ...localPayload(), modifiedAt: SYNCED_AT, attachmentId: 'blob-2' }

    const result = pullAtEqualClock(payload)

    expect(result).toBe('applied')
    expect(readNote()).toMatchObject({
      attachmentId: 'blob-2',
      modifiedAt: LOCAL_EDIT,
      syncedAt: NOW
    })
  })
})
