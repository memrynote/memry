import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'

/**
 * Real migrated data DB, real `SyncQueueManager`, real `TaskSyncService`. The
 * only mock is the module-level `getDatabase()` handle the local sync adapters
 * reach for on their offline branch.
 */
let activeDb: unknown = null

vi.mock('../database', () => ({
  getDatabase: () => activeDb
}))

vi.mock('../telemetry/track', () => ({ trackMainEvent: vi.fn() }))

const logWarn = vi.hoisted(() => vi.fn())
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: logWarn, error: vi.fn(), debug: vi.fn() })
}))

import { createTestDataDb, asClientDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { tasks } from '@memry/db-schema/schema/tasks'
import { projects } from '@memry/db-schema/schema/projects'
import { syncIntents } from '@memry/db-schema/schema/sync-intents'
import type { DataDb } from '../database/client'
import { SyncQueueManager } from '@memry/sync-client/queue'
import {
  initTaskSyncService,
  resetTaskSyncService,
  type TaskSyncService
} from '@memry/sync-client/task-sync'
import { syncPendingDeletes } from '@memry/db-schema/schema/sync-pending-deletes'
import { markSyncEligible, markSyncIneligible } from '@memry/sync-client/sync-eligibility'
import { trackMainEvent } from '../telemetry/track'
import { ItemApplier } from './apply-item'
import { recoverDirtyItems } from './dirty-recovery'
import { PendingSyncIntentError } from './pending-sync-intent-error'
import {
  commitLocalChange,
  drainPendingSyncIntents,
  drainSyncIntents,
  listPendingIntentKeys,
  settleItemSyncIntents
} from './sync-intents'

const DEVICE_ID = 'device-A'

describe('sync intents (#2301)', () => {
  let testDb: TestDatabaseResult
  let db: DataDb
  let queue: SyncQueueManager
  let taskSync: TaskSyncService

  beforeEach(() => {
    testDb = createTestDataDb()
    db = asClientDb(testDb.db)
    activeDb = db
    queue = new SyncQueueManager(db)
    taskSync = initTaskSyncService({ queue, db, getDeviceId: () => DEVICE_ID })
    db.insert(projects).values({ id: 'proj-1', name: 'Project', color: '#000' }).run()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.mocked(trackMainEvent).mockClear()
    markSyncIneligible()
    resetTaskSyncService()
    activeDb = null
    testDb.close()
  })

  function insertTask(id: string, title = 'Task'): void {
    db.insert(tasks).values({ id, projectId: 'proj-1', title, priority: 0, position: 0 }).run()
  }

  function taskRow(id: string) {
    return db.select().from(tasks).where(eq(tasks.id, id)).get()
  }

  function intents() {
    return db.select().from(syncIntents).all()
  }

  // #2301: a throw between the row write and the enqueue rolls back the row.
  it('rolls back the row and its intent when the write throws', () => {
    expect(() =>
      commitLocalChange(db, () => {
        insertTask('task-1')
        throw new Error('write failed')
      })
    ).toThrow('write failed')

    expect(taskRow('task-1')).toBeUndefined()
    expect(intents()).toEqual([])
    expect(queue.getSize()).toBe(0)
  })

  // #2301
  it('commits the row, bumps the clock, queues the push and clears the intent', () => {
    const value = commitLocalChange(db, () => {
      insertTask('task-1')
      return {
        value: 'done',
        intents: [{ type: 'task' as const, itemId: 'task-1', op: 'create' as const, args: [] }]
      }
    })

    expect(value).toBe('done')
    expect(taskRow('task-1')?.clock).toEqual({ [DEVICE_ID]: 1 })
    const queued = queue.peek(10)
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ type: 'task', itemId: 'task-1', operation: 'create' })
    expect(intents()).toEqual([])
  })

  // #2301: no clocked-but-unqueued row. A throw after the clock write but
  // before the queue row rolls the clock back with it, and the edit itself
  // stays committed with its intent for the next drain.
  it('keeps the edit and its intent, and no clock bump, when queueing throws', () => {
    insertTask('task-1', 'Old')
    db.update(tasks)
      .set({ clock: { [DEVICE_ID]: 1 } })
      .where(eq(tasks.id, 'task-1'))
      .run()
    vi.spyOn(queue, 'enqueue').mockImplementationOnce(() => {
      throw new Error('queue broke')
    })

    commitLocalChange(db, () => {
      db.update(tasks).set({ title: 'New' }).where(eq(tasks.id, 'task-1')).run()
      return {
        value: undefined,
        intents: [
          { type: 'task' as const, itemId: 'task-1', op: 'update' as const, args: [['title']] }
        ]
      }
    })

    expect(taskRow('task-1')).toMatchObject({ title: 'New', clock: { [DEVICE_ID]: 1 } })
    expect(queue.getSize()).toBe(0)
    expect(intents()).toMatchObject([
      { type: 'task', itemId: 'task-1', op: 'update', attempts: 0, lastError: 'queue broke' }
    ])

    expect(drainSyncIntents(db, 'startup')).toMatchObject({ applied: 1, failed: 0 })

    expect(taskRow('task-1')?.clock).toEqual({ [DEVICE_ID]: 2 })
    const queued = queue.peek(10)
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ itemId: 'task-1', operation: 'update' })
    expect(intents()).toEqual([])
  })

  // #2301: a crash after the edit committed and before its intent was
  // drained. The next drain replays the intents in commit order.
  it('replays leftover intents in order, coalescing in the queue', () => {
    insertTask('task-1')
    const snapshot = JSON.stringify({ id: 'task-2', title: 'Gone', clock: { [DEVICE_ID]: 3 } })
    db.insert(syncIntents)
      .values([
        { type: 'task', itemId: 'task-1', op: 'create', args: '[]', createdAt: new Date() },
        {
          type: 'task',
          itemId: 'task-1',
          op: 'update',
          args: '[["title"]]',
          createdAt: new Date()
        },
        {
          type: 'task',
          itemId: 'task-2',
          op: 'delete',
          args: JSON.stringify([snapshot]),
          createdAt: new Date()
        }
      ])
      .run()

    expect(drainSyncIntents(db, 'startup')).toMatchObject({ applied: 3, failed: 0 })

    const queued = queue.peek(10)
    expect(queued.map((row) => [row.itemId, row.operation])).toEqual([
      ['task-1', 'create'],
      ['task-2', 'delete']
    ])
    expect(JSON.parse(queued[1]?.payload ?? '{}')).toMatchObject({
      id: 'task-2',
      clock: { [DEVICE_ID]: 4 }
    })
    expect(intents()).toEqual([])
  })

  // #2301: per-item order. A failed intent holds back the later intents of
  // the same item for this pass, and never those of another item.
  it('skips the rest of an item after one of its intents fails', () => {
    insertTask('task-1')
    insertTask('task-2')
    db.insert(syncIntents)
      .values([
        {
          type: 'task',
          itemId: 'task-1',
          op: 'update',
          args: '[["title"]]',
          createdAt: new Date()
        },
        {
          type: 'task',
          itemId: 'task-1',
          op: 'update',
          args: '[["dueDate"]]',
          createdAt: new Date()
        },
        { type: 'task', itemId: 'task-2', op: 'update', args: '[["title"]]', createdAt: new Date() }
      ])
      .run()
    vi.spyOn(taskSync, 'enqueueUpdate').mockImplementationOnce(() => {
      throw new Error('poison')
    })

    expect(drainSyncIntents(db, 'startup')).toMatchObject({ applied: 1, failed: 1 })

    expect(intents()).toMatchObject([
      { itemId: 'task-1', attempts: 1 },
      { itemId: 'task-1', attempts: 0 }
    ])
    expect(queue.peek(10).map((row) => row.itemId)).toEqual(['task-2'])
  })

  // #2301: with the runtime down the intent takes the adapter's offline
  // branch, the same as a direct call does today, and is consumed.
  it('falls back to the offline clock when no sync service is running', () => {
    resetTaskSyncService()

    commitLocalChange(db, () => {
      insertTask('task-1')
      return {
        value: undefined,
        intents: [{ type: 'task' as const, itemId: 'task-1', op: 'create' as const, args: [] }]
      }
    })

    expect(taskRow('task-1')?.clock).toEqual({ _offline: 1 })
    expect(queue.getSize()).toBe(0)
    expect(intents()).toEqual([])
  })

  function remoteTaskUpsert(id: string, title: string, clock: Record<string, number>) {
    return {
      itemId: id,
      type: 'task' as const,
      operation: 'update' as const,
      content: new TextEncoder().encode(
        JSON.stringify({
          id,
          projectId: 'proj-1',
          title,
          description: null,
          priority: 0,
          position: 0,
          statusId: null,
          parentId: null,
          dueDate: null,
          dueTime: null,
          startDate: null,
          repeatConfig: null,
          repeatFrom: null,
          sourceNoteId: null,
          completedAt: null,
          archivedAt: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          modifiedAt: '2026-01-02T00:00:00.000Z'
        })
      ),
      clock
    }
  }

  function deleteTaskWithIntent(id: string): void {
    const snapshot = JSON.stringify({ ...taskRow(id) })
    commitLocalChange(db, () => {
      db.delete(tasks).where(eq(tasks.id, id)).run()
      return {
        value: undefined,
        intents: [{ type: 'task' as const, itemId: id, op: 'delete' as const, args: [snapshot] }]
      }
    })
  }

  // #2301 review A-1/B-3: the resurrection guard commits with the row delete.
  // A failed queueing step must not roll it back, or the next pull re-creates
  // the task the user deleted.
  it('keeps the delete tombstone when queueing the delete throws, and refuses a remote upsert', () => {
    markSyncEligible()
    insertTask('task-1')
    db.update(tasks)
      .set({ clock: { [DEVICE_ID]: 2 } })
      .where(eq(tasks.id, 'task-1'))
      .run()
    vi.spyOn(queue, 'enqueue').mockImplementation(() => {
      throw new Error('queue broke')
    })

    deleteTaskWithIntent('task-1')

    expect(db.select().from(syncPendingDeletes).all()).toMatchObject([
      { type: 'task', itemId: 'task-1' }
    ])
    expect(intents()).toMatchObject([{ itemId: 'task-1', op: 'delete', attempts: 0 }])

    const applier = new ItemApplier(db as never, vi.fn())
    expect(applier.apply(remoteTaskUpsert('task-1', 'Edited elsewhere', { 'device-B': 5 }))).toBe(
      'skipped'
    )
    expect(taskRow('task-1')).toBeUndefined()
  })

  // #2301 review A-1(c)/A-4: a delete intent whose row exists locally again
  // (a downgrade/re-upgrade round trip) is stale. Pushing it would delete a
  // live item on every device, so the intent and its tombstone are dropped.
  it('drops a stale delete intent whose row exists locally again, and counts it', () => {
    markSyncEligible()
    insertTask('task-1')
    const snapshot = JSON.stringify({ id: 'task-1', clock: { [DEVICE_ID]: 1 } })
    db.insert(syncIntents)
      .values({
        type: 'task',
        itemId: 'task-1',
        op: 'delete',
        args: JSON.stringify([snapshot]),
        createdAt: new Date()
      })
      .run()
    db.insert(syncPendingDeletes)
      .values({ type: 'task', itemId: 'task-1', payload: snapshot, createdAt: new Date() })
      .run()

    expect(drainPendingSyncIntents(db, 'startup')).toMatchObject({
      applied: 0,
      failed: 0,
      staleDeletes: 1
    })

    expect(taskRow('task-1')).toBeDefined()
    expect(queue.getSize()).toBe(0)
    expect(intents()).toEqual([])
    expect(db.select().from(syncPendingDeletes).all()).toEqual([])
    expect(trackMainEvent).toHaveBeenCalledWith('sync_run_completed', {
      surface: 'sync',
      action: 'sync_intents_replayed',
      result: 'success',
      metrics: { itemCount: 1, resultCount: 0, retryCount: 0, value: 1 }
    })
  })

  // #2301 review r2 A-M1/B-1a: only the start-up replay spends the attempt
  // budget. Pull-start, per-item and per-edit drains retry without counting,
  // or pull cadence would burn the budget in minutes.
  it('counts an attempt only in the start-up replay', () => {
    insertTask('task-1')
    db.insert(syncIntents)
      .values({
        type: 'task',
        itemId: 'task-1',
        op: 'update',
        args: '[["title"]]',
        createdAt: new Date()
      })
      .run()
    vi.spyOn(queue, 'enqueue').mockImplementation(() => {
      throw new Error('queue broke')
    })

    drainSyncIntents(db, 'pull')
    drainSyncIntents(db, 'commit', [{ type: 'task', itemId: 'task-1' }])
    expect(settleItemSyncIntents(db, 'task', 'task-1')).toBe(false)
    expect(intents()).toMatchObject([{ attempts: 0, lastError: 'queue broke' }])

    drainSyncIntents(db, 'startup')
    expect(intents()).toMatchObject([{ attempts: 1 }])
  })

  // #2301 review r2 A-L1: a row this build cannot read belongs to a newer
  // build. It stays pending and untouched so a re-upgrade replays it, and this
  // build ignores it: it owns, guards and blocks nothing. Logged once.
  it('leaves rows this build cannot read pending, untouched and ignored', () => {
    insertTask('task-1')
    db.insert(syncIntents)
      .values([
        { type: 'future_type', itemId: 'x-1', op: 'update', createdAt: new Date() },
        { type: 'task', itemId: 'task-1', op: 'rename', args: '[]', createdAt: new Date() },
        { type: 'task', itemId: 'task-1', op: 'update', args: '{not json', createdAt: new Date() },
        { type: 'task', itemId: 'task-1', op: 'update', args: '{"a":1}', createdAt: new Date() },
        { type: 'task', itemId: 'task-1', op: 'update', args: '[["title"]]', createdAt: new Date() }
      ])
      .run()

    expect(drainSyncIntents(db, 'startup')).toMatchObject({ applied: 1, failed: 0 })
    drainSyncIntents(db, 'startup')

    expect(
      intents().map(({ type, op, attempts, lastError }) => ({ type, op, attempts, lastError }))
    ).toEqual([
      { type: 'future_type', op: 'update', attempts: 0, lastError: null },
      { type: 'task', op: 'rename', attempts: 0, lastError: null },
      { type: 'task', op: 'update', attempts: 0, lastError: null },
      { type: 'task', op: 'update', attempts: 0, lastError: null }
    ])
    expect(queue.peek(10).map((row) => row.itemId)).toEqual(['task-1'])
    expect(listPendingIntentKeys(db).size).toBe(0)
    expect(settleItemSyncIntents(db, 'task', 'task-1')).toBe(true)
    const ignored = logWarn.mock.calls.filter(([message]) =>
      String(message).startsWith('Ignoring a sync intent this build cannot read')
    )
    expect(ignored).toHaveLength(4)
  })

  // #2301 review r2 A-M1/B-1, A-M2/B-3: past the cap nothing is given up.
  // The row stays pending, so the applier still defers remote rows and the
  // dirty sweep still leaves the item alone; the retry uses the intent's own
  // fields, so once the fault clears only those field clocks move.
  it('keeps an over-cap intent pending and guarding, and syncs it once the fault clears', () => {
    insertTask('task-1', 'Edited')
    db.update(tasks)
      .set({
        clock: { [DEVICE_ID]: 3 },
        syncedAt: '2026-01-01T00:00:00Z',
        modifiedAt: '2026-01-02T00:00:00Z'
      })
      .where(eq(tasks.id, 'task-1'))
      .run()
    db.insert(syncIntents)
      .values({
        type: 'task',
        itemId: 'task-1',
        op: 'update',
        args: '[["title"]]',
        attempts: 4,
        createdAt: new Date()
      })
      .run()
    const fault = vi.spyOn(taskSync, 'enqueueUpdate').mockImplementation(() => {
      throw new Error('adapter broke')
    })

    expect(drainPendingSyncIntents(db, 'startup')).toMatchObject({
      applied: 0,
      failed: 1,
      overCap: 1
    })
    expect(trackMainEvent).toHaveBeenCalledWith('sync_run_completed', {
      surface: 'sync',
      action: 'sync_intents_over_cap',
      result: 'failed',
      metrics: { itemCount: 1 }
    })
    expect(intents()).toMatchObject([{ attempts: 5, lastError: 'adapter broke' }])

    const applier = new ItemApplier(db as never, vi.fn())
    expect(() =>
      applier.apply(remoteTaskUpsert('task-1', 'Remote', { [DEVICE_ID]: 3, 'device-B': 5 }))
    ).toThrow(PendingSyncIntentError)

    recoverDirtyItems(db)
    expect(queue.getSize()).toBe(0)
    expect(taskRow('task-1')).toMatchObject({ title: 'Edited', clock: { [DEVICE_ID]: 3 } })

    fault.mockRestore()
    expect(drainPendingSyncIntents(db, 'startup')).toMatchObject({ applied: 1, failed: 0 })

    expect(intents()).toEqual([])
    const fieldClocks = taskRow('task-1')?.fieldClocks as Record<string, Record<string, number>>
    expect(fieldClocks.title).toEqual({ [DEVICE_ID]: 4 })
    expect(fieldClocks.priority).toEqual({ [DEVICE_ID]: 3 })
    expect(queue.peek(10)).toMatchObject([{ itemId: 'task-1', operation: 'update' }])
  })

  // #2301 review A-2/B-2: a remote upsert first drains the item's pending
  // intent, so it meets the bumped local clock instead of the pre-edit one.
  it('drains a pending intent before a remote upsert for the same item', () => {
    insertTask('task-1', 'Local')
    db.update(tasks)
      .set({ clock: { [DEVICE_ID]: 3 } })
      .where(eq(tasks.id, 'task-1'))
      .run()
    db.insert(syncIntents)
      .values({
        type: 'task',
        itemId: 'task-1',
        op: 'update',
        args: '[["title"]]',
        createdAt: new Date()
      })
      .run()

    const applier = new ItemApplier(db as never, vi.fn())
    // Against the pre-edit clock {A:3} this remote ties on the title field
    // (3 vs 3) and a tie goes to the remote: the local edit would be lost.
    applier.apply(remoteTaskUpsert('task-1', 'Remote', { [DEVICE_ID]: 2, 'device-B': 1 }))

    expect(intents()).toEqual([])
    expect(taskRow('task-1')?.clock).toMatchObject({ [DEVICE_ID]: 4, 'device-B': 1 })
    expect(taskRow('task-1')?.title).toBe('Local')
  })

  // #2301 review A-2/B-2: when that drain still fails, the remote upsert
  // must not overwrite the un-clocked local edit. It throws, which the pull
  // routes to its end-of-run deferred retry.
  it('refuses a remote upsert while the item still has a pending intent', () => {
    insertTask('task-1', 'Local')
    db.insert(syncIntents)
      .values({
        type: 'task',
        itemId: 'task-1',
        op: 'update',
        args: '[["title"]]',
        createdAt: new Date()
      })
      .run()
    vi.spyOn(queue, 'enqueue').mockImplementation(() => {
      throw new Error('queue broke')
    })

    const applier = new ItemApplier(db as never, vi.fn())
    expect(() => applier.apply(remoteTaskUpsert('task-1', 'Remote', { 'device-B': 9 }))).toThrow(
      PendingSyncIntentError
    )

    expect(taskRow('task-1')?.title).toBe('Local')
    expect(intents()).toMatchObject([{ itemId: 'task-1', attempts: 0, lastError: 'queue broke' }])
  })
})
