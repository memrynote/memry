import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { folderConfigs } from '@memry/db-schema/schema/folder-configs'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import { FolderConfigSyncPayloadSchema } from '@memry/contracts/sync-payloads'
import { createTestDataDb, type TestDataDb } from '../../test/helpers/test-data-db'

/**
 * Push side of folder-config sync (the per-folder icon + saved-view record).
 * Real `RecordSyncController`, real `SyncQueueManager`, real migrated
 * in-memory data DB — nothing about the queue behaviour is simulated.
 */

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { SyncQueueManager } from './queue'
import {
  FolderConfigSyncService,
  getFolderConfigSyncService,
  initFolderConfigSyncService,
  resetFolderConfigSyncService
} from './folder-config-sync'

let db: TestDataDb
let queue: SyncQueueManager

function seedFolder(overrides: Record<string, unknown> = {}): void {
  db.insert(folderConfigs)
    .values({
      path: 'Work',
      icon: 'briefcase',
      clock: {},
      ...overrides
    } as never)
    .run()
}

function queueRows(): Array<typeof syncQueue.$inferSelect> {
  return db.select().from(syncQueue).all()
}

function payloadOf(row: typeof syncQueue.$inferSelect | undefined): Record<string, unknown> {
  return JSON.parse(row!.payload) as Record<string, unknown>
}

function storedClock(folderPath = 'Work'): unknown {
  return db.select().from(folderConfigs).where(eq(folderConfigs.path, folderPath)).get()?.clock
}

function makeService(deviceId: string | null = 'device-a'): FolderConfigSyncService {
  return new FolderConfigSyncService({ queue, db, getDeviceId: () => deviceId })
}

beforeEach(() => {
  vi.clearAllMocks()
  db = createTestDataDb()
  queue = new SyncQueueManager(db)
  resetFolderConfigSyncService()
})

describe('FolderConfigSyncService push', () => {
  it('enqueues exactly one folder_config create carrying the icon the user picked', () => {
    seedFolder()

    makeService().enqueueCreate('Work')

    const rows = queueRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('folder_config')
    expect(rows[0].itemId).toBe('Work')
    expect(rows[0].operation).toBe('create')

    const payload = payloadOf(rows[0])
    expect(payload).toMatchObject({ path: 'Work', icon: 'briefcase', clock: { 'device-a': 1 } })
    expect(FolderConfigSyncPayloadSchema.safeParse(payload).success).toBe(true)
  })

  it('persists the bumped clock on the folder row', () => {
    seedFolder({ clock: { 'device-b': 5 } })

    makeService().enqueueUpdate('Work')

    expect(storedClock()).toEqual({ 'device-b': 5, 'device-a': 1 })
    expect(payloadOf(queueRows()[0]).clock).toEqual({ 'device-b': 5, 'device-a': 1 })
  })

  it('coalesces a later icon change into the pending push and keeps the newest icon', () => {
    seedFolder()
    const service = makeService()

    service.enqueueCreate('Work')
    db.update(folderConfigs).set({ icon: 'rocket' }).where(eq(folderConfigs.path, 'Work')).run()
    service.enqueueUpdate('Work')

    const rows = queueRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].operation).toBe('create')
    expect(payloadOf(rows[0])).toMatchObject({ icon: 'rocket', clock: { 'device-a': 2 } })
  })

  it('skips a folder that has no config row', () => {
    makeService().enqueueUpdate('Ghost')

    expect(queueRows()).toEqual([])
  })

  it('skips every mutation while there is no device id', () => {
    seedFolder()
    const service = makeService(null)

    service.enqueueCreate('Work')
    service.enqueueUpdate('Work')
    service.enqueueDelete('Work')

    expect(queueRows()).toEqual([])
    expect(storedClock()).toEqual({})
  })
})

describe('FolderConfigSyncService deletes', () => {
  it('propagates a delete using the caller snapshot with the clock advanced', () => {
    seedFolder()

    makeService().enqueueDelete(
      'Work',
      JSON.stringify({ path: 'Work', icon: 'briefcase', clock: { 'device-a': 6 } })
    )

    const rows = queueRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].operation).toBe('delete')
    expect(payloadOf(rows[0])).toEqual({
      path: 'Work',
      icon: 'briefcase',
      clock: { 'device-a': 7 }
    })
  })

  it('falls back to a minimal tombstone when the caller has no snapshot', () => {
    makeService().enqueueDelete('Inbox')

    const rows = queueRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].itemId).toBe('Inbox')
    expect(rows[0].operation).toBe('delete')
    expect(payloadOf(rows[0])).toEqual({ path: 'Inbox', icon: null, clock: { 'device-a': 1 } })
  })

  it('propagates a delete for a folder whose row is already gone', () => {
    // The delete path never loads the row, so a folder removed from disk first
    // still gets its tombstone out.
    makeService().enqueueDelete('Archived')

    expect(queueRows()).toHaveLength(1)
  })

  it('lets a delete win over a still-pending create instead of being dropped', () => {
    seedFolder()
    const service = makeService()

    service.enqueueCreate('Work')
    service.enqueueDelete('Work', JSON.stringify({ path: 'Work', icon: 'briefcase' }))

    const rows = queueRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].operation).toBe('delete')
  })
})

describe('folder config sync service lifecycle', () => {
  it('tracks the module-level singleton', () => {
    expect(getFolderConfigSyncService()).toBeNull()

    const service = initFolderConfigSyncService({ queue, db, getDeviceId: () => 'device-a' })
    expect(getFolderConfigSyncService()).toBe(service)

    resetFolderConfigSyncService()
    expect(getFolderConfigSyncService()).toBeNull()
  })
})
