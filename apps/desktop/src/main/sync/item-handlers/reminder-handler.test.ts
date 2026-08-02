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

  describe('buildPushPayload', () => {
    it('normalizes status=triggered to pending (device-local, like triggeredAt)', () => {
      testDb.db
        .insert(reminders)
        .values({
          id: 'rem_1',
          targetType: 'note',
          targetId: 'note_1',
          remindAt: '2026-08-03T09:00:00.000Z',
          status: 'triggered',
          triggeredAt: '2026-08-03T09:00:01.000Z'
        })
        .run()

      const raw = reminderHandler.buildPushPayload(ctx.db, 'rem_1', 'device-a', 'update')
      expect(raw).not.toBeNull()
      const payload = JSON.parse(raw as string)
      expect(payload.status).toBe('pending')
      expect(payload).not.toHaveProperty('triggeredAt')
    })

    it('leaves a real status (dismissed) untouched', () => {
      testDb.db
        .insert(reminders)
        .values({
          id: 'rem_2',
          targetType: 'note',
          targetId: 'note_1',
          remindAt: '2026-08-03T09:00:00.000Z',
          status: 'dismissed',
          dismissedAt: '2026-08-03T09:05:00.000Z'
        })
        .run()

      const raw = reminderHandler.buildPushPayload(ctx.db, 'rem_2', 'device-a', 'update')
      const payload = JSON.parse(raw as string)
      expect(payload.status).toBe('dismissed')
    })

    it('returns null for an unknown reminder', () => {
      expect(reminderHandler.buildPushPayload(ctx.db, 'missing', 'device-a', 'update')).toBeNull()
    })

    // computeRemindAt resolves in the host OS timezone on purpose, so two
    // devices derive different instants for the same date pill. The value is
    // re-derivable from note content that already syncs via CRDT, so it must
    // not travel — see reminder-outbound.ts.
    it('omits the device-local derived remindAt for a note_date row', () => {
      testDb.db
        .insert(reminders)
        .values({
          id: 'rem_nd_note_1_dm_1',
          targetType: 'note_date',
          targetId: 'note_1',
          anchorId: 'dm_1',
          remindAt: '2026-08-03T09:00:00.000Z',
          status: 'dismissed',
          dismissedAt: '2026-08-03T08:00:00.000Z'
        })
        .run()

      const payload = JSON.parse(
        reminderHandler.buildPushPayload(
          ctx.db,
          'rem_nd_note_1_dm_1',
          'device-a',
          'update'
        ) as string
      )
      expect(payload).not.toHaveProperty('remindAt')
      // The user's intent still syncs.
      expect(payload.status).toBe('dismissed')
      expect(payload.dismissedAt).toBe('2026-08-03T08:00:00.000Z')
    })

    it('still sends remindAt for a non-derived (note) reminder', () => {
      testDb.db
        .insert(reminders)
        .values({
          id: 'rem_3',
          targetType: 'note',
          targetId: 'note_1',
          remindAt: '2026-08-03T09:00:00.000Z',
          status: 'pending'
        })
        .run()

      const payload = JSON.parse(
        reminderHandler.buildPushPayload(ctx.db, 'rem_3', 'device-a', 'update') as string
      )
      expect(payload.remindAt).toBe('2026-08-03T09:00:00.000Z')
    })
  })

  describe('note_date rows are owned by the local reconciler', () => {
    const noteDateId = 'rem_nd_note_1_dm_1'
    const noteDatePayload: ReminderSyncPayload = {
      targetType: 'note_date',
      targetId: 'note_1',
      anchorId: 'dm_1',
      status: 'pending',
      createdAt: '2026-08-02T00:00:00.000Z',
      modifiedAt: '2026-08-02T00:00:00.000Z'
    }

    function seedLocalNoteDateRow(remindAt: string, status = 'pending'): void {
      testDb.db
        .insert(reminders)
        .values({
          id: noteDateId,
          targetType: 'note_date',
          targetId: 'note_1',
          anchorId: 'dm_1',
          remindAt,
          status,
          clock: { device_b: 1 }
        })
        .run()
    }

    it('skips an inbound upsert when no local row exists yet', () => {
      const result = reminderHandler.applyUpsert(ctx, noteDateId, noteDatePayload, { device_a: 1 })

      expect(result).toBe('skipped')
      expect(testDb.db.select().from(reminders).all()).toHaveLength(0)
    })

    it('applies dismissal state onto an existing local row without touching remindAt', () => {
      seedLocalNoteDateRow('2026-08-03T06:00:00.000Z')

      const result = reminderHandler.applyUpsert(
        ctx,
        noteDateId,
        {
          ...noteDatePayload,
          status: 'dismissed',
          dismissedAt: '2026-08-03T05:00:00.000Z',
          snoozedUntil: null
        },
        { device_a: 1, device_b: 1 }
      )
      expect(result).toBe('applied')

      const row = testDb.db.select().from(reminders).where(eq(reminders.id, noteDateId)).get()
      expect(row?.status).toBe('dismissed')
      expect(row?.dismissedAt).toBe('2026-08-03T05:00:00.000Z')
      expect(row?.remindAt).toBe('2026-08-03T06:00:00.000Z')
    })

    // The mixed-timezone scenario end to end: UTC-5 dismissed the reminder,
    // UTC+3 derived a different instant for the same pill. The dismiss must
    // land and the local derived time must survive, even though this payload
    // still carries remindAt (an older client, or one queued before the
    // outbound rule existed).
    it('keeps both the dismiss and the local remindAt against a foreign remindAt', () => {
      seedLocalNoteDateRow('2026-08-03T06:00:00.000Z', 'dismissed')

      reminderHandler.applyUpsert(
        ctx,
        noteDateId,
        {
          ...noteDatePayload,
          remindAt: '2026-08-02T22:00:00.000Z',
          status: 'dismissed',
          dismissedAt: '2026-08-03T05:00:00.000Z'
        },
        { device_a: 1, device_b: 1 }
      )

      const row = testDb.db.select().from(reminders).where(eq(reminders.id, noteDateId)).get()
      expect(row?.status).toBe('dismissed')
      expect(row?.remindAt).toBe('2026-08-03T06:00:00.000Z')
    })

    it('seedUnclocked omits remindAt for a note_date row', () => {
      seedLocalNoteDateRow('2026-08-03T06:00:00.000Z')
      testDb.db.update(reminders).set({ clock: null }).where(eq(reminders.id, noteDateId)).run()

      const queue = new SyncQueueManager(asSyncDb(testDb.db))
      reminderHandler.seedUnclocked(ctx.db, 'device-a', queue)

      const [queued] = queue.dequeue(1)
      expect(JSON.parse(queued.payload)).not.toHaveProperty('remindAt')
    })
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

  it('seedUnclocked normalizes status=triggered to pending in the enqueued payload', () => {
    testDb.db
      .insert(reminders)
      .values({
        id: 'rem_trig',
        targetType: 'note',
        targetId: 'note_1',
        remindAt: '2026-08-03T09:00:00.000Z',
        status: 'triggered',
        triggeredAt: '2026-08-03T09:00:01.000Z'
      })
      .run()

    const queue = new SyncQueueManager(asSyncDb(testDb.db))
    reminderHandler.seedUnclocked(ctx.db, 'device-a', queue)

    const [queued] = queue.dequeue(1)
    const payload = JSON.parse(queued.payload)
    expect(payload.status).toBe('pending')
    expect(payload).not.toHaveProperty('triggeredAt')
  })
})
