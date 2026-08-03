import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, asClientDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { bookmarks } from '@memry/db-schema/schema/bookmarks'
import { reminders } from '@memry/db-schema/schema/reminders'
import { templates } from '@memry/db-schema/schema/templates'
import {
  OFFLINE_DEVICE_KEY,
  incrementBookmarkClockOffline,
  incrementReminderClockOffline,
  incrementTemplateClockOffline
} from './offline-clock'

const TEST_BOOKMARK = {
  id: 'bm-1',
  itemType: 'note',
  itemId: 'note-1',
  position: 0
}

const TEST_REMINDER = {
  id: 'rem-1',
  targetType: 'note',
  targetId: 'note-1',
  remindAt: '2026-08-03T09:00:00.000Z',
  status: 'pending'
}

// These helpers are the ONLY thing that bumps a row's clock while the sync
// service is down. Without the bump a local edit made offline looks unchanged
// on reconnect and is silently lost, so both the increment and its persistence
// are asserted against the row rather than a return value.
describe('offline clock helpers', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDataDb()
  })

  afterEach(() => {
    testDb.close()
  })

  describe('incrementTemplateClockOffline', () => {
    it('#given an unclocked template #then seeds the clock under the offline device key', () => {
      testDb.db.insert(templates).values({ id: 'tpl-1', name: 'Standup' }).run()

      incrementTemplateClockOffline(asClientDb(testDb.db), 'tpl-1')

      const row = testDb.db.select().from(templates).where(eq(templates.id, 'tpl-1')).get()
      expect(row?.clock).toEqual({ [OFFLINE_DEVICE_KEY]: 1 })
    })

    it('#given an existing clock #then increments from the persisted value', () => {
      testDb.db
        .insert(templates)
        .values({
          id: 'tpl-1',
          name: 'Standup',
          clock: { [OFFLINE_DEVICE_KEY]: 2, 'device-A': 5 }
        })
        .run()

      incrementTemplateClockOffline(asClientDb(testDb.db), 'tpl-1')

      const row = testDb.db.select().from(templates).where(eq(templates.id, 'tpl-1')).get()
      expect(row?.clock).toEqual({ [OFFLINE_DEVICE_KEY]: 3, 'device-A': 5 })
    })

    it('#given the template does not exist #then no-ops without throwing', () => {
      expect(() => incrementTemplateClockOffline(asClientDb(testDb.db), 'missing')).not.toThrow()
      expect(testDb.db.select().from(templates).all()).toHaveLength(0)
    })
  })

  describe('incrementBookmarkClockOffline', () => {
    it('#given an unclocked bookmark #then seeds the clock under the offline device key', () => {
      testDb.db.insert(bookmarks).values(TEST_BOOKMARK).run()

      incrementBookmarkClockOffline(asClientDb(testDb.db), 'bm-1')

      const row = testDb.db.select().from(bookmarks).where(eq(bookmarks.id, 'bm-1')).get()
      expect(row?.clock).toEqual({ [OFFLINE_DEVICE_KEY]: 1 })
    })

    it('#given an existing clock #then increments from the persisted value', () => {
      testDb.db
        .insert(bookmarks)
        .values({ ...TEST_BOOKMARK, clock: { [OFFLINE_DEVICE_KEY]: 2, 'device-A': 5 } })
        .run()

      incrementBookmarkClockOffline(asClientDb(testDb.db), 'bm-1')

      const row = testDb.db.select().from(bookmarks).where(eq(bookmarks.id, 'bm-1')).get()
      // The other device's tick must survive — dropping it would lose causality
      // and make a later legitimate remote update look concurrent.
      expect(row?.clock).toEqual({ [OFFLINE_DEVICE_KEY]: 3, 'device-A': 5 })
    })

    it('#given the bookmark does not exist #then no-ops without throwing', () => {
      expect(() => incrementBookmarkClockOffline(asClientDb(testDb.db), 'missing')).not.toThrow()
      expect(testDb.db.select().from(bookmarks).all()).toHaveLength(0)
    })
  })

  describe('incrementReminderClockOffline', () => {
    it('#given an unclocked reminder #then seeds the clock under the offline device key', () => {
      testDb.db.insert(reminders).values(TEST_REMINDER).run()

      incrementReminderClockOffline(asClientDb(testDb.db), 'rem-1')

      const row = testDb.db.select().from(reminders).where(eq(reminders.id, 'rem-1')).get()
      expect(row?.clock).toEqual({ [OFFLINE_DEVICE_KEY]: 1 })
    })

    it('#given an existing clock #then increments from the persisted value', () => {
      testDb.db
        .insert(reminders)
        .values({ ...TEST_REMINDER, clock: { [OFFLINE_DEVICE_KEY]: 1, 'device-B': 4 } })
        .run()

      incrementReminderClockOffline(asClientDb(testDb.db), 'rem-1')

      const row = testDb.db.select().from(reminders).where(eq(reminders.id, 'rem-1')).get()
      expect(row?.clock).toEqual({ [OFFLINE_DEVICE_KEY]: 2, 'device-B': 4 })
    })

    it('#given the reminder does not exist #then no-ops without throwing', () => {
      expect(() => incrementReminderClockOffline(asClientDb(testDb.db), 'missing')).not.toThrow()
      expect(testDb.db.select().from(reminders).all()).toHaveLength(0)
    })

    it('#then leaves the device-local triggeredAt untouched', () => {
      testDb.db
        .insert(reminders)
        .values({ ...TEST_REMINDER, triggeredAt: '2026-08-03T09:00:01.000Z' })
        .run()

      incrementReminderClockOffline(asClientDb(testDb.db), 'rem-1')

      const row = testDb.db.select().from(reminders).where(eq(reminders.id, 'rem-1')).get()
      expect(row?.triggeredAt).toBe('2026-08-03T09:00:01.000Z')
    })
  })
})
