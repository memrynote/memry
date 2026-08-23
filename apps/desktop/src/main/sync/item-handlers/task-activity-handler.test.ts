import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, asSyncDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { taskActivity } from '@memry/db-schema/schema/task-activity'
import type { TaskActivitySyncPayload } from '@memry/contracts/sync-payloads'
import { TaskActivityChannels } from '@memry/contracts/ipc-channels'
import { taskActivityHandler } from '@memry/sync-client/item-handlers/task-activity-handler'
import { makeCtx } from '@tests/utils/fixtures/sync-item-handlers'
import type { ApplyContext } from '@memry/sync-client/item-handlers/types'
import type { SyncQueueManager } from '@memry/sync-client/queue'

const DAY_MS = 24 * 60 * 60 * 1000

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString()
}

function makePayload(overrides: Partial<TaskActivitySyncPayload> = {}): TaskActivitySyncPayload {
  return {
    taskId: 'task-1',
    action: 'updated',
    field: 'statusId',
    oldValue: JSON.stringify('status-todo'),
    newValue: JSON.stringify('status-done'),
    actor: 'user',
    deviceId: 'device-A',
    createdAt: isoDaysAgo(1),
    ...overrides
  }
}

describe('taskActivityHandler', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext

  beforeEach(() => {
    testDb = createTestDataDb()
    ctx = makeCtx(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  it('inserts a remote row and emits CREATED', () => {
    const result = taskActivityHandler.applyUpsert(ctx, 'act-1', makePayload(), { 'device-A': 1 })

    expect(result).toBe('applied')

    const row = testDb.db.select().from(taskActivity).where(eq(taskActivity.id, 'act-1')).get()
    expect(row).toBeDefined()
    expect(row!.taskId).toBe('task-1')
    expect(row!.action).toBe('updated')
    expect(row!.field).toBe('statusId')
    expect(row!.deviceId).toBe('device-A')
    expect(row!.clock).toEqual({ 'device-A': 1 })
    expect(ctx.emit).toHaveBeenCalledWith(TaskActivityChannels.events.CREATED, {
      id: 'act-1',
      taskId: 'task-1'
    })
  })

  it('falls back to the payload clock when the envelope clock is empty', () => {
    taskActivityHandler.applyUpsert(ctx, 'act-1', makePayload({ clock: { 'device-B': 4 } }), {})

    const row = testDb.db.select().from(taskActivity).where(eq(taskActivity.id, 'act-1')).get()
    expect(row!.clock).toEqual({ 'device-B': 4 })
  })

  it('skips a duplicate id — this is what collapses mirror-image superseded rows', () => {
    taskActivityHandler.applyUpsert(ctx, 'act-dup', makePayload(), { 'device-A': 1 })

    const second = taskActivityHandler.applyUpsert(
      ctx,
      'act-dup',
      makePayload({ newValue: JSON.stringify('status-other') }),
      { 'device-B': 1 }
    )

    expect(second).toBe('skipped')

    const row = testDb.db.select().from(taskActivity).where(eq(taskActivity.id, 'act-dup')).get()
    expect(row!.newValue).toBe(JSON.stringify('status-done'))
  })

  it('never updates an existing row, even for a strictly newer clock', () => {
    taskActivityHandler.applyUpsert(ctx, 'act-1', makePayload(), { 'device-A': 1 })

    const result = taskActivityHandler.applyUpsert(
      ctx,
      'act-1',
      makePayload({ action: 'deleted', field: null }),
      { 'device-A': 99 }
    )

    expect(result).toBe('skipped')
    const row = testDb.db.select().from(taskActivity).where(eq(taskActivity.id, 'act-1')).get()
    expect(row!.action).toBe('updated')
  })

  it('skips a row past the retention cutoff so a pruned row is never resurrected', () => {
    const result = taskActivityHandler.applyUpsert(
      ctx,
      'act-old',
      makePayload({ createdAt: isoDaysAgo(120) }),
      { 'device-A': 1 }
    )

    expect(result).toBe('skipped')
    expect(
      testDb.db.select().from(taskActivity).where(eq(taskActivity.id, 'act-old')).get()
    ).toBeUndefined()
  })

  it('skips a row with no taskId or action', () => {
    expect(
      taskActivityHandler.applyUpsert(ctx, 'act-bad', makePayload({ taskId: undefined }), {})
    ).toBe('skipped')
    expect(
      taskActivityHandler.applyUpsert(ctx, 'act-bad', makePayload({ action: undefined }), {})
    ).toBe('skipped')
    expect(testDb.db.select().from(taskActivity).all()).toHaveLength(0)
  })

  it('deletes an existing row and emits DELETED', () => {
    taskActivityHandler.applyUpsert(ctx, 'act-1', makePayload(), { 'device-A': 1 })

    expect(taskActivityHandler.applyDelete(ctx, 'act-1')).toBe('applied')
    expect(
      testDb.db.select().from(taskActivity).where(eq(taskActivity.id, 'act-1')).get()
    ).toBeUndefined()
    expect(ctx.emit).toHaveBeenCalledWith(TaskActivityChannels.events.DELETED, {
      id: 'act-1',
      taskId: 'task-1'
    })
  })

  it('skips a delete for a row that is already gone', () => {
    expect(taskActivityHandler.applyDelete(ctx, 'act-missing')).toBe('skipped')
  })

  it('seedUnclocked stamps a clock and enqueues rows that have none', () => {
    testDb.db
      .insert(taskActivity)
      .values({
        id: 'act-seed',
        taskId: 'task-1',
        action: 'created',
        actor: 'user',
        deviceId: 'device-A',
        createdAt: isoDaysAgo(2)
      })
      .run()

    const enqueue = vi.fn()
    const queue = { enqueue } as unknown as SyncQueueManager

    const seeded = taskActivityHandler.seedUnclocked(asSyncDb(testDb.db), 'device-A', queue)

    expect(seeded).toBe(1)
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task_activity', itemId: 'act-seed', operation: 'create' })
    )
    const row = testDb.db.select().from(taskActivity).where(eq(taskActivity.id, 'act-seed')).get()
    expect(row!.clock).toEqual({ 'device-A': 1 })
  })

  it('seedUnclocked leaves expired rows alone instead of pushing them back out', () => {
    testDb.db
      .insert(taskActivity)
      .values({
        id: 'act-expired',
        taskId: 'task-1',
        action: 'created',
        actor: 'user',
        deviceId: 'device-A',
        createdAt: isoDaysAgo(400)
      })
      .run()

    const enqueue = vi.fn()
    const queue = { enqueue } as unknown as SyncQueueManager

    expect(taskActivityHandler.seedUnclocked(asSyncDb(testDb.db), 'device-A', queue)).toBe(0)
    expect(enqueue).not.toHaveBeenCalled()
    const row = testDb.db
      .select()
      .from(taskActivity)
      .where(eq(taskActivity.id, 'act-expired'))
      .get()
    expect(row!.clock).toBeNull()
  })

  it('buildPushPayload returns the whole row and null when it is gone', () => {
    taskActivityHandler.applyUpsert(ctx, 'act-1', makePayload(), { 'device-A': 1 })

    const payload = taskActivityHandler.buildPushPayload(
      asSyncDb(testDb.db),
      'act-1',
      'device-A',
      'create'
    )
    expect(payload).not.toBeNull()
    expect(JSON.parse(payload as string)).toMatchObject({ id: 'act-1', taskId: 'task-1' })

    expect(
      taskActivityHandler.buildPushPayload(asSyncDb(testDb.db), 'act-missing', 'device-A', 'create')
    ).toBeNull()
  })
})
