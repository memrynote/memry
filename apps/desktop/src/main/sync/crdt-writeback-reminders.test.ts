import * as Y from 'yjs'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reminders } from '@memry/db-schema/schema/reminders'
import { serializeDateMentionToken } from '@memry/shared/date-mention'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { ReminderSyncService } from '@memry/sync-client/reminder-sync'
import { reminderHandler } from '@memry/sync-client/item-handlers/reminder-handler'
import {
  asClientDb,
  asSyncDb,
  createTestDataDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { makeCtx } from '@tests/utils/fixtures/sync-item-handlers'

/**
 * note_date reminders are derived: every device re-runs the reconciler over
 * its own copy of the note body. The write-back runs that reconciler with the
 * real reminders service against a real data DB, and the queue the desktop's
 * local-mutation hooks feed is a real one too.
 */

const DEVICE = 'device-fresh'
const NOTE_ID = 'note-1'
const REMINDER_ID = 'rem_nd_note-1_dm_1'

const mocks = vi.hoisted(() => ({
  db: null as TestDatabaseResult | null,
  reminderSync: null as { enqueueCreate(id: string): void; enqueueUpdate(id: string): void } | null,
  markdown: ''
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
vi.mock('../lib/window-broadcast', () => ({ broadcastToAllWindows: vi.fn() }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn(), trackMainLog: vi.fn() }))
vi.mock('./crdt-provider', () => ({
  getCrdtProvider: () => ({ getDoc: () => undefined, close: vi.fn(), purge: vi.fn() })
}))
vi.mock('./blocknote-converter', () => ({
  yDocToMarkdown: async () => mocks.markdown,
  findUnrepresentableNodes: () => []
}))
vi.mock('../database/client', () => ({
  getDatabase: () => mocks.db!.db,
  getIndexDatabase: () => ({ kind: 'index-db' })
}))
vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: () => ({
    id: NOTE_ID,
    path: 'Plans.md',
    title: 'Plans',
    contentHash: null,
    createdAt: '2026-09-26T00:00:00.000Z'
  })
}))
vi.mock('../vault/file-ops', () => ({
  atomicWrite: vi.fn(async () => {}),
  safeRead: vi.fn(async () => null),
  ensureDirectory: vi.fn(async () => {}),
  deleteFile: vi.fn(async () => {})
}))
vi.mock('../vault/notes', () => ({
  getVaultRoot: () => '/vault',
  toAbsolutePath: (relative: string) => `/vault/${relative}`,
  maybeCreateSignificantSnapshot: () => null
}))
vi.mock('../vault/journal', () => ({ getJournalPath: (date: string) => `/vault/${date}.md` }))
vi.mock('../vault/note-sync', () => ({ syncNoteToCache: vi.fn(), deleteNoteFromCache: vi.fn() }))
vi.mock('../vault/attachment-rename-reconcile', () => ({ reconcileRenamedAttachments: () => [] }))
vi.mock('../projections', () => ({ flushProjectionEvents: vi.fn(async () => {}) }))
vi.mock('./local-mutations', () => ({
  enqueueLocalSyncCreate: (_type: string, id: string) => mocks.reminderSync!.enqueueCreate(id),
  enqueueLocalSyncUpdate: (_type: string, id: string) => mocks.reminderSync!.enqueueUpdate(id),
  enqueueLocalSyncDelete: vi.fn()
}))

import {
  cancelPendingWritebacks,
  flushPendingWritebacks,
  scheduleWriteback
} from './crdt-writeback'

const remindingPill = serializeDateMentionToken({
  anchorId: 'dm_1',
  dateISO: '2026-10-16T09:00:00.000Z',
  hasTime: true,
  dateFormat: 'relative',
  remind: '1h',
  timeFormat: 'system'
})

describe('note_date reminders derived by the markdown write-back', () => {
  let queue: SyncQueueManager

  beforeEach(() => {
    mocks.db = createTestDataDb()
    queue = new SyncQueueManager(asClientDb(mocks.db.db))
    mocks.reminderSync = new ReminderSyncService({
      queue,
      db: asClientDb(mocks.db.db),
      getDeviceId: () => DEVICE
    })
    mocks.markdown = `Launch ${remindingPill}`
  })

  afterEach(() => {
    cancelPendingWritebacks()
    mocks.db?.close()
  })

  const reminderRow = () =>
    mocks.db!.db.select().from(reminders).where(eq(reminders.id, REMINDER_ID)).get()

  it('derives a remote body reminder without a clock or a push, so a peer dismissal applies', async () => {
    // #given a remote body for a note with a reminding date pill
    scheduleWriteback(NOTE_ID, new Y.Doc())
    await flushPendingWritebacks()

    // #then the row exists here, unstamped and not queued for the server
    expect(reminderRow()).toMatchObject({ status: 'pending', clock: null })
    expect(queue.getPendingCount()).toBe(0)

    // #and the next full sync's seed does not push it either
    expect(reminderHandler.seedUnclocked(asSyncDb(mocks.db!.db), DEVICE, queue)).toBe(0)
    expect(queue.getPendingCount()).toBe(0)

    // #when the server row, dismissed on the device that owns it, is pulled
    const result = reminderHandler.applyUpsert(
      makeCtx(mocks.db!),
      REMINDER_ID,
      {
        targetType: 'note_date',
        targetId: NOTE_ID,
        anchorId: 'dm_1',
        status: 'dismissed',
        dismissedAt: '2026-09-26T12:00:00.000Z',
        modifiedAt: '2026-09-26T12:00:00.000Z'
      },
      { peer: 2 }
    )

    // #then it applies cleanly: no conflict, the dismissal and the peer's clock win
    expect(result).toBe('applied')
    expect(reminderRow()).toMatchObject({
      status: 'dismissed',
      dismissedAt: '2026-09-26T12:00:00.000Z',
      clock: { peer: 2 }
    })
  })
})
