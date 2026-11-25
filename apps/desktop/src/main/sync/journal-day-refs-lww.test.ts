import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { eq } from 'drizzle-orm'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import { syncIntents } from '@memry/db-schema/schema/sync-intents'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import {
  asClientDb,
  asSyncDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import type { ApplyContext } from '@memry/sync-client/item-handlers/types'
import type { NoteSyncPayload } from '@memry/contracts/sync-payloads'
import type { VectorClock } from '@memry/contracts/sync-api'

// #5785: the server keeps one `note j<date>` record per day, last writer wins.
// Devices A and C each name a picture of the same day at once, the server keeps
// A's record, and a fresh device D bootstraps from the server's copy. Through
// the real note and journal handlers, the note sync queue and push payload.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-day-refs-lww-'))
const vaultPath = path.join(root, 'vault')
const userDataDir = path.join(root, 'user-data')
fs.mkdirSync(userDataDir, { recursive: true })

const { dbs, logger } = vi.hoisted(() => ({
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- the annotation widens the literal so later assignments type-check
  dbs: { data: null as unknown, index: null as unknown },
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => userDataDir) },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../lib/logger', () => ({ createLogger: () => logger }))
vi.mock('../lib/window-broadcast', () => ({ broadcastToAllWindows: vi.fn() }))
vi.mock('./crdt-network-update', async () => await import('./crdt-writeback'))
vi.mock('./crdt-writeback-port', async () => {
  const writeback = await import('./crdt-writeback')
  return { crdtWriteback: () => writeback }
})
vi.mock('./crdt-writeback', () => ({
  takeWritebackTurn: (_id: string, run: () => Promise<unknown>) => run(),
  holdFlushUntil: vi.fn(),
  writebackNow: vi.fn()
}))
vi.mock('../projections', () => ({
  flushProjectionEvents: vi.fn(async () => {}),
  publishProjectionEvent: vi.fn()
}))
vi.mock('../database', () => ({
  getDatabase: () => dbs.data,
  getIndexDatabase: () => dbs.index
}))
vi.mock('../database/client', () => ({
  getDatabase: () => dbs.data,
  getIndexDatabase: () => dbs.index,
  isDatabaseInitialized: () => true,
  isIndexDatabaseInitialized: () => true,
  getRawIndexDatabase: () => null
}))
vi.mock('../journal/runtime-effects', () => ({
  enqueueJournalCreate: vi.fn(),
  enqueueJournalUpdate: vi.fn(),
  initializeJournalCrdt: vi.fn(async () => {})
}))
vi.mock('./crdt-provider', () => ({
  getCrdtProvider: () => ({
    hasDocState: async () => false,
    getDoc: () => undefined,
    getOpenNoteIds: () => [],
    initPersistence: async () => {},
    purge: async () => {}
  })
}))
vi.mock('../vault/note-snapshots', async () => await import('../vault/notes'))
vi.mock('../vault/notes-versions', async () => await import('../vault/notes'))
vi.mock('../vault/notes-crud', async () => await import('../vault/notes'))
vi.mock('../vault/notes-io', async () => await import('../vault/notes'))
vi.mock('../vault/notes', () => ({
  getVaultRoot: () => vaultPath,
  toRelativePath: (p: string) => path.relative(vaultPath, p),
  toAbsolutePath: (p: string) => path.join(vaultPath, p)
}))
vi.mock('../vault/status', async () => await import('../vault/index'))
vi.mock('../vault/index', () => ({
  getStatus: () => ({ path: vaultPath, isOpen: true }),
  getConfig: () => ({ journalFolder: 'journal', defaultNoteFolder: 'notes' })
}))

import { getNoteMetadataById } from '@memry/storage-data'
import { attachmentEvents } from '@memry/sync-client/attachment-events'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { _resetBulkApplyForTests } from './bulk-apply'
import { journalHandler } from './item-handlers/journal-handler'
import { noteHandler } from './item-handlers/note-handler'
import { initNoteSyncService, resetNoteSyncService } from './note-sync'
import { enqueueLocalSyncUpdate } from './local-mutations'
import { drainPendingSyncIntents } from './sync-intents'

const DATE = '2026-06-09'
const DAY = `j${DATE}`
const DAY_PATH = `journal/${DATE}.md`
const BODY = '![a](../attachments/a.png)\n![c](../attachments/c.png)\n'

type WireRecord = NoteSyncPayload & { clock: VectorClock }

interface Device {
  id: string
  data: TestDatabaseResult
  index: TestDatabaseResult
  ctx: ApplyContext
}

describe('a journal day named by two devices at once', () => {
  let devices: Device[]

  const device = (id: string): Device => {
    const data = createTestDataDb()
    const index = createTestIndexDb()
    data.db
      .insert(syncDevices)
      .values({
        id,
        name: id,
        platform: 'macos',
        appVersion: '1',
        linkedAt: new Date(),
        isCurrentDevice: true,
        signingPublicKey: 'key'
      })
      .run()
    const made = { id, data, index, ctx: { db: asSyncDb(data.db), emit: vi.fn() } }
    devices.push(made)
    return made
  }

  /** Makes `d` the running device: its databases and, unless `offline`, its note sync. */
  const switchTo = (d: Device, { offline = false } = {}): void => {
    dbs.data = d.data.db
    dbs.index = d.index.db
    resetNoteSyncService()
    if (!offline) {
      initNoteSyncService({
        queue: new SyncQueueManager(asClientDb(d.data.db)),
        getDeviceId: () => d.id
      })
    }
  }

  /** A device holding the day with the pictures it has named. */
  const holdingDay = (id: string, refs: string[]): Device => {
    const d = device(id)
    d.data.db
      .insert(noteMetadata)
      .values({
        id: DAY,
        path: DAY_PATH,
        title: DATE,
        fileType: 'markdown',
        journalDate: DATE,
        attachmentReferences: refs,
        clock: { [id]: 1 },
        syncedAt: '2026-06-09T08:00:00.000Z',
        createdAt: '2026-06-09T08:00:00.000Z',
        modifiedAt: '2026-06-09T08:00:00.000Z'
      })
      .run()
    return d
  }

  const queuedNoteUpdates = (d: Device): string[] =>
    d.data.db
      .select()
      .from(syncQueue)
      .all()
      .filter((row) => row.type === 'note' && row.itemId === DAY)
      .map((row) => row.operation)

  /** What `d` sends for its queued `note j<date>` row, read at push time. */
  const push = (d: Device): WireRecord => {
    switchTo(d)
    const wire = noteHandler.buildPushPayload(d.ctx.db, DAY, d.id, 'update')
    d.data.db.delete(syncQueue).run()
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the note wire record
    return JSON.parse(wire ?? '{}') as WireRecord
  }

  const pull = (d: Device, record: WireRecord): void => {
    switchTo(d)
    noteHandler.applyUpsert(d.ctx, DAY, record, record.clock)
  }

  beforeEach(() => {
    devices = []
    _resetBulkApplyForTests()
    fs.rmSync(vaultPath, { recursive: true, force: true })
    fs.mkdirSync(path.join(vaultPath, 'journal'), { recursive: true })
    fs.writeFileSync(path.join(vaultPath, DAY_PATH), BODY)
  })

  afterEach(() => {
    _resetBulkApplyForTests()
    resetNoteSyncService()
    for (const d of devices) {
      d.data.close()
      d.index.close()
    }
  })

  it('converges the server copy to the union, so a fresh device asks for every picture', () => {
    const a = holdingDay('dev-a', ['att-a'])
    const c = holdingDay('dev-c', ['att-c'])
    // C pushes first, A's concurrent push lands last and wins.
    let server = push(c)
    server = push(a)
    expect(server.attachmentReferences).toEqual(['att-a'])

    // C pulls the winner: it holds `att-c`, which the server copy lacks.
    pull(c, server)
    expect(getNoteMetadataById(c.ctx.db, DAY)?.attachmentReferences).toEqual(['att-c', 'att-a'])
    expect(queuedNoteUpdates(c)).toEqual(['update'])
    server = push(c)

    // A pulls C's union and holds nothing it lacks: no push back.
    pull(a, server)
    expect(getNoteMetadataById(a.ctx.db, DAY)?.attachmentReferences).toEqual(['att-a', 'att-c'])
    expect(queuedNoteUpdates(a)).toEqual([])
    // C's own record back, and A's stale one again, change nothing on C.
    pull(c, server)
    expect(queuedNoteUpdates(c)).toEqual([])

    // D bootstraps from the server's copy: the day, then its `note` record.
    const d = device('dev-d')
    switchTo(d)
    fs.rmSync(vaultPath, { recursive: true, force: true })
    fs.mkdirSync(path.join(vaultPath, 'journal'), { recursive: true })
    const asked: string[] = []
    const listener = ({ attachmentId }: { attachmentId: string }) => asked.push(attachmentId)
    attachmentEvents.onDownloadNeeded(listener)
    try {
      journalHandler.applyUpsert(d.ctx, DAY, { date: DATE, content: BODY }, server.clock)
      noteHandler.applyUpsert(d.ctx, DAY, server, server.clock)
    } finally {
      attachmentEvents.offDownloadNeeded(listener)
    }
    expect(getNoteMetadataById(d.ctx.db, DAY)?.attachmentReferences).toEqual(['att-c', 'att-a'])
    expect(asked.toSorted()).toEqual(['att-a', 'att-c'])
    expect(queuedNoteUpdates(d)).toEqual([])
  })

  it('re-pushes when the winner names only part of what this device holds', () => {
    const a = holdingDay('dev-a', ['att-a'])
    const c = holdingDay('dev-c', ['att-a', 'att-c'])

    pull(c, push(a))

    expect(queuedNoteUpdates(c)).toEqual(['update'])
    expect(push(c).attachmentReferences).toEqual(['att-a', 'att-c'])
  })

  it('queues an upload to a day made while sync is down, and pushes it at runtime start', () => {
    const a = holdingDay('dev-a', ['att-a'])
    switchTo(a, { offline: true })
    a.data.db
      .update(noteMetadata)
      .set({ attachmentReferences: ['att-a', 'att-b'] })
      .where(eq(noteMetadata.id, DAY))
      .run()

    enqueueLocalSyncUpdate('note', DAY)
    enqueueLocalSyncUpdate('note', DAY)

    expect(
      a.data.db
        .select({ type: syncIntents.type, itemId: syncIntents.itemId, op: syncIntents.op })
        .from(syncIntents)
        .all()
    ).toEqual([{ type: 'note', itemId: DAY, op: 'update' }])

    switchTo(a)
    drainPendingSyncIntents(a.ctx.db, 'startup')

    expect(queuedNoteUpdates(a)).toEqual(['update'])
    expect(a.data.db.select().from(syncIntents).all()).toEqual([])
    expect(push(a).attachmentReferences).toEqual(['att-a', 'att-b'])
  })
})
