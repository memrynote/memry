import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, asClientDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { reminders } from '@memry/db-schema/schema/reminders'
import { SyncQueueManager } from './queue'
import {
  ReminderSyncService,
  initReminderSyncService,
  getReminderSyncService,
  resetReminderSyncService
} from './reminder-sync'

const TEST_REMINDER = {
  id: 'rem-1',
  targetType: 'note',
  targetId: 'note-1',
  remindAt: '2026-05-15T08:00:00.000Z',
  status: 'pending'
}

describe('ReminderSyncService', () => {
  let testDb: TestDatabaseResult
  let queue: SyncQueueManager
  let service: ReminderSyncService

  beforeEach(() => {
    testDb = createTestDataDb()
    queue = new SyncQueueManager(asClientDb(testDb.db))
    service = new ReminderSyncService({
      queue,
      db: asClientDb(testDb.db),
      getDeviceId: () => 'device-A'
    })
  })

  afterEach(() => {
    resetReminderSyncService()
    testDb.close()
  })

  describe('#given a reminder exists #when enqueueUpdate called', () => {
    it('#then enqueues an update operation and increments clock', () => {
      testDb.db.insert(reminders).values(TEST_REMINDER).run()

      service.enqueueUpdate('rem-1')

      const [item] = queue.dequeue(1)
      expect(item.itemId).toBe('rem-1')
      expect(item.operation).toBe('update')
      expect(item.type).toBe('reminder')

      const payload = JSON.parse(item.payload)
      expect(payload.clock).toEqual({ 'device-A': 1 })
    })
  })

  describe('#given a triggered reminder #when enqueueUpdate called', () => {
    it('#then normalizes status to pending and strips triggeredAt in the outbound payload', () => {
      testDb.db
        .insert(reminders)
        .values({
          ...TEST_REMINDER,
          status: 'triggered',
          triggeredAt: '2026-05-15T08:00:01.000Z'
        })
        .run()

      service.enqueueUpdate('rem-1')

      const [item] = queue.dequeue(1)
      const payload = JSON.parse(item.payload)
      expect(payload.status).toBe('pending')
      expect(payload).not.toHaveProperty('triggeredAt')

      // The local row itself is untouched — triggeredAt stays for THIS device.
      const row = testDb.db.select().from(reminders).where(eq(reminders.id, 'rem-1')).get()
      expect(row?.triggeredAt).toBe('2026-05-15T08:00:01.000Z')
      expect(row?.status).toBe('triggered')
    })
  })

  describe('#given a dismissed reminder #when enqueueUpdate called', () => {
    it('#then leaves the real status untouched in the outbound payload', () => {
      testDb.db
        .insert(reminders)
        .values({
          ...TEST_REMINDER,
          status: 'dismissed',
          dismissedAt: '2026-05-15T08:05:00.000Z'
        })
        .run()

      service.enqueueUpdate('rem-1')

      const [item] = queue.dequeue(1)
      const payload = JSON.parse(item.payload)
      expect(payload.status).toBe('dismissed')
    })
  })

  describe('#when enqueueDelete called', () => {
    it('#then enqueues a delete payload with incremented clock', () => {
      const snapshot = JSON.stringify(TEST_REMINDER)
      service.enqueueDelete('rem-1', snapshot)

      const [item] = queue.dequeue(1)
      expect(item.itemId).toBe('rem-1')
      expect(item.operation).toBe('delete')
      const payload = JSON.parse(item.payload)
      expect(payload).toMatchObject(TEST_REMINDER)
      expect(payload.clock).toEqual({ 'device-A': 1 })
    })
  })

  describe('module-level accessor', () => {
    it('#then getReminderSyncService returns null before init', () => {
      expect(getReminderSyncService()).toBeNull()
    })

    it('#then getReminderSyncService returns instance after init', () => {
      const svc = initReminderSyncService({
        queue,
        db: asClientDb(testDb.db),
        getDeviceId: () => 'dev-1'
      })
      expect(getReminderSyncService()).toBe(svc)
    })

    it('#then resetReminderSyncService clears instance', () => {
      initReminderSyncService({ queue, db: asClientDb(testDb.db), getDeviceId: () => 'dev-1' })
      resetReminderSyncService()
      expect(getReminderSyncService()).toBeNull()
    })
  })
})
