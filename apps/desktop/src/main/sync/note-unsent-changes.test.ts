import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * AF-019 (#2646): a note whose record holds changes the server never
 * acknowledged must not be stamped synced by an equal-clock pull or by a
 * replay rejection. Real migrated data and index DBs, the real queue, note sync
 * service, note handler, dirty recovery and push loop. The mocks are the
 * module-level database handles, the vault root, the crypto and the server.
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
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import {
  asClientDb,
  asSyncDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { createMockDeps } from '@tests/utils/engine-mocks'
import { initNoteSyncService, resetNoteSyncService } from './note-sync'
import { noteHandler } from './item-handlers/note-handler'
import { recoverDirtyItems } from './dirty-recovery'
import { SyncEngine } from './engine'
import * as encrypt from './encrypt'
import * as httpClient from './http-client'

const DEVICE = 'device-1'
const PEER = 'device-2'
const NOTE_ID = 'note-unsent'
const NOTE_PATH = 'unsent.md'
const NOTE_FILE = '---\ntags:\n  - draft\n---\nLocal body\n'
const CLOCK: VectorClock = { [DEVICE]: 1, [PEER]: 3 }
const SYNCED_AT = '2024-03-01T10:00:00.000Z'
const LOCAL_EDIT = '2024-03-02T10:00:00.000Z'
const REMOTE_EDIT = '2024-03-03T10:00:00.000Z'

let dataDb: TestDatabaseResult
let indexDb: TestDatabaseResult
let deps: ReturnType<typeof createMockDeps>

function seedNote(timestamps: { syncedAt: string; modifiedAt: string }): void {
  dataDb.db
    .insert(noteMetadata)
    .values({
      id: NOTE_ID,
      path: NOTE_PATH,
      title: 'unsent',
      fileType: 'markdown',
      clock: CLOCK,
      createdAt: '2024-02-01T10:00:00.000Z',
      ...timestamps
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
  dataDb = createTestDataDb()
  indexDb = createTestIndexDb()
  activeDb = dataDb.db
  activeIndexDb = indexDb.db
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-note-unsent-'))
  fs.writeFileSync(path.join(vaultRoot, NOTE_PATH), NOTE_FILE)
  deps = createMockDeps(dataDb)
  initNoteSyncService({ queue: deps.queue, getDeviceId: () => DEVICE })
})

afterEach(() => {
  vi.restoreAllMocks()
  resetNoteSyncService()
  dataDb.close()
  indexDb.close()
  fs.rmSync(vaultRoot, { recursive: true, force: true })
})

describe('equal-clock pull of a note', () => {
  it('keeps unsent local changes, leaves the note unsynced and re-pushes it under a newer clock', () => {
    seedNote({ syncedAt: SYNCED_AT, modifiedAt: LOCAL_EDIT })
    const remote = { ...localPayload(), modifiedAt: SYNCED_AT, properties: { status: 'done' } }

    const result = pullAtEqualClock(remote)

    expect(result).toBe('skipped')
    expect(readNote()).toMatchObject({
      modifiedAt: LOCAL_EDIT,
      syncedAt: SYNCED_AT,
      clock: { [DEVICE]: 2, [PEER]: 3 }
    })
    expect(fs.readFileSync(path.join(vaultRoot, NOTE_PATH), 'utf-8')).toBe(NOTE_FILE)
    expect(queuedClocks()).toEqual([{ [DEVICE]: 2, [PEER]: 3 }])
  })

  // An identical payload is exactly what this row would push, so the server
  // already holds every unsent record change and the row is synced.
  it('stamps an unsent note synced when the server copy is the payload it would push', () => {
    seedNote({ syncedAt: SYNCED_AT, modifiedAt: LOCAL_EDIT })

    const result = pullAtEqualClock(localPayload())

    expect(result).toBe('skipped')
    const note = readNote()
    expect(note?.clock).toEqual(CLOCK)
    expect(note?.syncedAt).not.toBe(SYNCED_AT)
    expect(queuedClocks()).toEqual([])
  })

  it('applies a different server copy over a note with nothing unsent (#2294)', () => {
    seedNote({ syncedAt: LOCAL_EDIT, modifiedAt: SYNCED_AT })
    const remote = { ...localPayload(), modifiedAt: REMOTE_EDIT, properties: { status: 'done' } }

    const result = pullAtEqualClock(remote)

    expect(result).toBe('applied')
    expect(readNote()).toMatchObject({ modifiedAt: REMOTE_EDIT, clock: CLOCK })
    expect(queuedClocks()).toEqual([])
  })
})

describe('replay rejection of a recovered note push', () => {
  /**
   * A server that holds the note at CLOCK and refuses, as `detectReplay` does,
   * any push whose clock is ahead of it in no component.
   */
  function fakeServer(): VectorClock[] {
    const stored = new Map<string, VectorClock>([[NOTE_ID, CLOCK]])
    const pushed: VectorClock[] = []
    vi.spyOn(encrypt, 'encryptItemForPush').mockImplementation((input) => ({
      pushItem: {
        id: input.id,
        type: input.type,
        operation: input.operation,
        encryptedKey: 'ek',
        keyNonce: 'kn',
        encryptedData: 'ed',
        dataNonce: 'dn',
        signature: 'sig',
        signerDeviceId: DEVICE,
        clock: input.clock
      },
      sizeBytes: 100
    }))
    vi.spyOn(httpClient, 'postToServer').mockImplementation(async (_path, body) => {
      const accepted: string[] = []
      const rejected: Array<{ id: string; reason: string }> = []
      for (const item of (body as { items: Array<{ id: string; clock: VectorClock }> }).items) {
        pushed.push(item.clock)
        const existing = stored.get(item.id) ?? {}
        const ahead = Object.entries(item.clock).some(([key, n]) => n > (existing[key] ?? 0))
        if (ahead) {
          stored.set(item.id, item.clock)
          accepted.push(item.id)
        } else {
          rejected.push({ id: item.id, reason: 'SYNC_REPLAY_DETECTED' })
        }
      }
      return { accepted, rejected, serverTime: Math.floor(Date.now() / 1000) }
    })
    return pushed
  }

  it('re-pushes an unsent note under a newer clock instead of stamping the replay synced', async () => {
    seedNote({ syncedAt: SYNCED_AT, modifiedAt: LOCAL_EDIT })
    const pushed = fakeServer()

    recoverDirtyItems(asClientDb(dataDb.db))
    await new SyncEngine(deps).push()

    expect(pushed).toEqual([CLOCK, { [DEVICE]: 2, [PEER]: 3 }])
    const note = readNote()
    expect(note?.clock).toEqual({ [DEVICE]: 2, [PEER]: 3 })
    expect(note?.syncedAt).not.toBe(SYNCED_AT)
    expect(queuedClocks()).toEqual([])
  })

  it('stamps a replayed note with nothing unsent synced without pushing again', async () => {
    seedNote({ syncedAt: SYNCED_AT, modifiedAt: SYNCED_AT })
    const pushed = fakeServer()
    deps.queue.enqueue({
      type: 'note',
      itemId: NOTE_ID,
      operation: 'update',
      payload: JSON.stringify({ clock: CLOCK })
    })

    await new SyncEngine(deps).push()

    expect(pushed).toEqual([CLOCK])
    const note = readNote()
    expect(note?.clock).toEqual(CLOCK)
    expect(note?.syncedAt).not.toBe(SYNCED_AT)
    expect(queuedClocks()).toEqual([])
  })
})
