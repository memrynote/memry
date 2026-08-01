import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, asSyncDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { reminders } from '@memry/db-schema/schema/reminders'
import type { ReminderSyncPayload } from '@memry/contracts/sync-payloads'
import { SyncQueueManager } from '../queue'
import { reminderHandler } from './reminder-handler'
import type { ApplyContext } from './types'
import { makeCtx } from '@tests/utils/fixtures/sync-item-handlers'

describe('reminderHandler', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext

  beforeEach(() => {
    testDb = createTestDataDb()
    ctx = makeCtx(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  const payload: ReminderSyncPayload = {
    targetType: 'note',
    targetId: 'note_1',
    remindAt: '2026-08-03T09:00:00.000Z',
    status: 'pending',
    createdAt: '2026-08-02T00:00:00.000Z',
    modifiedAt: '2026-08-02T00:00:00.000Z'
  }

  it('inserts a new reminder', () => {
    const result = reminderHandler.applyUpsert(ctx, 'rem_1', payload, { a: 1 })
    expect(result).toBe('applied')

    const row = testDb.db.select().from(reminders).where(eq(reminders.id, 'rem_1')).get()
    expect(row?.targetId).toBe('note_1')
    expect(row?.clock).toEqual({ a: 1 })
  })

  it('skips inserting when the payload has no targetId', () => {
    const result = reminderHandler.applyUpsert(
      ctx,
      'rem_1',
      { ...payload, targetId: undefined },
      { a: 1 }
    )
    expect(result).toBe('skipped')
    expect(testDb.db.select().from(reminders).all()).toHaveLength(0)
  })

  it('skips inserting when the payload has no targetType', () => {
    const result = reminderHandler.applyUpsert(
      ctx,
      'rem_1',
      { ...payload, targetType: undefined },
      { a: 1 }
    )
    expect(result).toBe('skipped')
    expect(testDb.db.select().from(reminders).all()).toHaveLength(0)
  })

  it('propagates a dismiss from another device', () => {
    reminderHandler.applyUpsert(ctx, 'rem_1', payload, { a: 1 })
    const result = reminderHandler.applyUpsert(
      ctx,
      'rem_1',
      { ...payload, status: 'dismissed', dismissedAt: '2026-08-03T10:00:00.000Z' },
      { a: 2 }
    )
    expect(result).toBe('applied')

    const row = testDb.db.select().from(reminders).where(eq(reminders.id, 'rem_1')).get()
    expect(row?.status).toBe('dismissed')
    expect(row?.dismissedAt).toBe('2026-08-03T10:00:00.000Z')
  })

  it('preserves local triggeredAt across an inbound upsert', () => {
    reminderHandler.applyUpsert(ctx, 'rem_1', payload, { a: 1 })
    testDb.db
      .update(reminders)
      .set({ triggeredAt: '2026-08-03T09:00:01.000Z' })
      .where(eq(reminders.id, 'rem_1'))
      .run()

    reminderHandler.applyUpsert(ctx, 'rem_1', { ...payload, title: 'renamed' }, { a: 2 })

    const row = testDb.db.select().from(reminders).where(eq(reminders.id, 'rem_1')).get()
    expect(row?.triggeredAt).toBe('2026-08-03T09:00:01.000Z')
    expect(row?.title).toBe('renamed')
  })

  it('skips an older-clock update', () => {
    reminderHandler.applyUpsert(ctx, 'rem_1', payload, { a: 2 })
    const result = reminderHandler.applyUpsert(
      ctx,
      'rem_1',
      { ...payload, title: 'stale' },
      { a: 1 }
    )
    expect(result).toBe('skipped')

    const row = testDb.db.select().from(reminders).where(eq(reminders.id, 'rem_1')).get()
    expect(row?.title).toBeNull()
  })

  it('reports concurrent edits as conflict', () => {
    reminderHandler.applyUpsert(ctx, 'rem_1', payload, { a: 1 })
    const result = reminderHandler.applyUpsert(
      ctx,
      'rem_1',
      { ...payload, title: 'other' },
      { b: 1 }
    )
    expect(result).toBe('conflict')
  })

  it('deletes a reminder', () => {
    reminderHandler.applyUpsert(ctx, 'rem_1', payload, { a: 1 })
    expect(reminderHandler.applyDelete(ctx, 'rem_1', { a: 2 })).toBe('applied')
    expect(testDb.db.select().from(reminders).all()).toHaveLength(0)
  })

  it('skips deleting an unknown reminder', () => {
    expect(reminderHandler.applyDelete(ctx, 'rem_missing', { a: 1 })).toBe('skipped')
  })

  it('seedUnclocked clocks pre-existing rows and enqueues them', () => {
    testDb.db
      .insert(reminders)
      .values({
        id: 'rem_1',
        targetType: 'note',
        targetId: 'note_1',
        remindAt: '2026-08-03T09:00:00.000Z',
        status: 'pending'
      })
      .run()

    const queue = new SyncQueueManager(asSyncDb(testDb.db))
    const count = reminderHandler.seedUnclocked(ctx.db, 'device-a', queue)
    expect(count).toBe(1)

    const [queued] = queue.dequeue(1)
    expect(queued).toMatchObject({
      type: 'reminder',
      itemId: 'rem_1',
      operation: 'create'
    })
    expect(JSON.parse(queued.payload)).toMatchObject({
      targetId: 'note_1',
      clock: { 'device-a': 1 }
    })
    expect(JSON.parse(queued.payload)).not.toHaveProperty('triggeredAt')

    const row = testDb.db.select().from(reminders).where(eq(reminders.id, 'rem_1')).get()
    expect(row?.clock).toEqual({ 'device-a': 1 })
  })
})
