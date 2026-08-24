import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * The seam under test is "a delete raised with no sync service, replayed at the
 * next runtime start" — so everything here is real: a migrated SQLite data DB,
 * the real `SyncQueueManager`, and the real `TaskSyncService`. The only mock is
 * the module-level `getDatabase()` handle `local-mutations` reaches for, which
 * has no test seam of its own.
 */
let activeDb: unknown = null

vi.mock('../database', () => ({
  getDatabase: () => activeDb
}))

import { createTestDataDb, asClientDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { syncPendingDeletes } from '@memry/db-schema/schema/sync-pending-deletes'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { tasks } from '@memry/db-schema/schema/tasks'
import { projects } from '@memry/db-schema/schema/projects'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { DataDb } from '../database/client'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { initTaskSyncService, resetTaskSyncService } from '@memry/sync-client/task-sync'
import { initNoteSyncService, resetNoteSyncService } from './note-sync'
import { enqueueLocalSyncDelete, flushPendingLocalDeletes } from './local-mutations'
import { markSyncEligible, markSyncIneligible } from '@memry/sync-client/sync-eligibility'

const DEVICE_ID = 'device-A'

describe('deletes raised while the sync runtime is down', () => {
  let testDb: TestDatabaseResult
  let db: DataDb
  let queue: SyncQueueManager

  beforeEach(() => {
    testDb = createTestDataDb()
    db = asClientDb(testDb.db)
    activeDb = db
    queue = new SyncQueueManager(db)

    db.insert(syncDevices)
      .values({
        id: DEVICE_ID,
        name: 'Test device',
        platform: 'darwin',
        appVersion: '2026.8.19',
        linkedAt: new Date(),
        isCurrentDevice: true,
        signingPublicKey: 'pk'
      })
      .run()

    // Signed in, paid, runtime merely not up — the state where a dropped delete
    // is a real lost mutation.
    markSyncEligible()
  })

  afterEach(() => {
    resetTaskSyncService()
    resetNoteSyncService()
    markSyncIneligible()
    activeDb = null
    testDb.close()
  })

  function seedNote(id: string, clock: VectorClock | null, localOnly = false): void {
    db.insert(noteMetadata)
      .values({
        id,
        path: `${id}.md`,
        title: id,
        createdAt: '2026-08-01T00:00:00Z',
        modifiedAt: '2026-08-02T00:00:00Z',
        clock,
        localOnly
      })
      .run()
  }

  it('replays a note delete raised with no sync service into the queue', () => {
    // #given — a note the server already knows, and no note sync service
    seedNote('note-1', { [DEVICE_ID]: 3 })

    // #when — the delete is raised, then the note is removed exactly as
    // deleteNoteCommand removes it (enqueue first, row second)
    enqueueLocalSyncDelete('note', 'note-1')
    db.delete(noteMetadata).run()

    // #then — the tombstone survives the row
    const pending = db.select().from(syncPendingDeletes).all()
    expect(pending).toHaveLength(1)
    expect(pending[0]?.type).toBe('note')
    expect(pending[0]?.itemId).toBe('note-1')

    // #when — the runtime comes back and the real note sync service exists
    initNoteSyncService({ queue, getDeviceId: () => DEVICE_ID })
    const flushed = flushPendingLocalDeletes(db)

    // #then — the delete reaches the queue, with the clock advanced past the
    // one the server last saw, and the tombstone is consumed
    expect(flushed).toBe(1)
    const queued = queue.peek(10)
    expect(queued).toHaveLength(1)
    expect(queued[0]?.type).toBe('note')
    expect(queued[0]?.itemId).toBe('note-1')
    expect(queued[0]?.operation).toBe('delete')
    expect(JSON.parse(queued[0]?.payload ?? '{}')).toMatchObject({ clock: { [DEVICE_ID]: 4 } })
    expect(db.select().from(syncPendingDeletes).all()).toHaveLength(0)
  })

  it('replays a task delete through the task sync service at the next start', () => {
    // #given — the snapshot the caller captures before deleting the row
    const snapshot = JSON.stringify({ id: 'task-1', title: 'Ship it', clock: { [DEVICE_ID]: 2 } })

    // #when
    enqueueLocalSyncDelete('task', 'task-1', snapshot)

    // #then
    expect(db.select().from(syncPendingDeletes).all()).toHaveLength(1)

    // #when — the runtime starts and the real service exists again
    initTaskSyncService({ queue, db, getDeviceId: () => DEVICE_ID })
    const flushed = flushPendingLocalDeletes(db)

    // #then — the delete is queued with the service's own clock rule applied
    // once, not the raw snapshot
    expect(flushed).toBe(1)
    const queued = queue.peek(10)
    expect(queued).toHaveLength(1)
    expect(queued[0]?.itemId).toBe('task-1')
    expect(queued[0]?.operation).toBe('delete')
    expect(JSON.parse(queued[0]?.payload ?? '{}')).toMatchObject({
      id: 'task-1',
      clock: { [DEVICE_ID]: 3 }
    })
    expect(db.select().from(syncPendingDeletes).all()).toHaveLength(0)
  })

  it('records nothing when the install has no sync runtime by policy', () => {
    // #given — free plan / signed out: the services are null for the whole
    // session and there is no peer holding the note
    seedNote('note-2', { [DEVICE_ID]: 1 })
    markSyncIneligible()

    // #when
    enqueueLocalSyncDelete('note', 'note-2')

    // #then — no tombstone, and nothing to drain forever
    expect(db.select().from(syncPendingDeletes).all()).toHaveLength(0)
  })

  it('records nothing for a note the server has never seen or one kept local-only', () => {
    // #given
    seedNote('note-unclocked', null)
    seedNote('note-local-only', { [DEVICE_ID]: 1 }, true)

    // #when
    enqueueLocalSyncDelete('note', 'note-unclocked')
    enqueueLocalSyncDelete('note', 'note-local-only')

    // #then — nothing to tell a peer about in either case
    expect(db.select().from(syncPendingDeletes).all()).toHaveLength(0)
  })

  it('collapses two deletes of the same item into one tombstone', () => {
    // #given
    seedNote('note-3', { [DEVICE_ID]: 1 })

    // #when — a watcher re-firing a delete must not grow the table per event
    enqueueLocalSyncDelete('note', 'note-3')
    enqueueLocalSyncDelete('note', 'note-3')

    // #then
    expect(db.select().from(syncPendingDeletes).all()).toHaveLength(1)
  })

  it('keeps the tombstone when the runtime is still down at flush time', () => {
    // #given — a task delete recorded with no service
    db.insert(projects)
      .values({ id: 'proj-1', name: 'P', color: '#000', position: 0, isInbox: false })
      .run()
    db.insert(tasks)
      .values({ id: 'task-2', projectId: 'proj-1', title: 'T', priority: 0, position: 0 })
      .run()
    enqueueLocalSyncDelete('task', 'task-2', JSON.stringify({ id: 'task-2', clock: {} }))

    // #when — a flush that runs with the service still absent
    const flushed = flushPendingLocalDeletes(db)

    // #then — the replay re-records it rather than consuming it, so the delete
    // is still owed at the next start
    expect(flushed).toBe(1)
    expect(queue.getPendingCount()).toBe(0)
    expect(db.select().from(syncPendingDeletes).all()).toHaveLength(1)
  })

  it('keeps a note tombstone when its service is still missing at flush time', () => {
    // #given
    seedNote('note-4', { [DEVICE_ID]: 1 })
    enqueueLocalSyncDelete('note', 'note-4')
    db.delete(noteMetadata).run()

    // #when — no note sync service to hand it to
    const flushed = flushPendingLocalDeletes(db)

    // #then — left where it is, not consumed into nothing
    expect(flushed).toBe(0)
    expect(queue.getPendingCount()).toBe(0)
    expect(db.select().from(syncPendingDeletes).all()).toHaveLength(1)
  })
})
