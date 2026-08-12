import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, asClientDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { bookmarks } from '@memry/db-schema/schema/bookmarks'
import { reminders } from '@memry/db-schema/schema/reminders'
import { templates } from '@memry/db-schema/schema/templates'
import { tasks } from '@memry/db-schema/schema/tasks'
import { projects } from '@memry/db-schema/schema/projects'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'

const logMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: (...args: unknown[]) => logMocks.debug(...args),
    info: (...args: unknown[]) => logMocks.info(...args),
    warn: (...args: unknown[]) => logMocks.warn(...args),
    error: (...args: unknown[]) => logMocks.error(...args)
  })
}))

import {
  OFFLINE_DEVICE_KEY,
  incrementBookmarkClockOffline,
  incrementNoteClockOffline,
  incrementReminderClockOffline,
  incrementTaskClocksOffline,
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
    logMocks.debug.mockClear()
    logMocks.info.mockClear()
    logMocks.warn.mockClear()
    logMocks.error.mockClear()
  })

  afterEach(() => {
    testDb.close()
  })

  // Tasks are the highest-volume offline path: this runs once per field change
  // for every task edited while the sync runtime is down, and every argument is
  // built eagerly regardless of the transport's level. So the payload itself,
  // not just the level, is what has to stay small.
  describe('incrementTaskClocksOffline', () => {
    const insertTask = (values: Record<string, unknown>): void => {
      testDb.db.insert(projects).values({ id: 'p1', name: 'P1', color: '#000', position: 0 }).run()
      testDb.db
        .insert(tasks)
        .values({ id: 'task-1', projectId: 'p1', title: 'A task', ...values } as never)
        .run()
    }

    it('#given a field change while offline #then bumps the doc clock and the changed field clock', () => {
      insertTask({ clock: { [OFFLINE_DEVICE_KEY]: 1 } })

      incrementTaskClocksOffline(asClientDb(testDb.db), 'task-1', ['title'])

      const row = testDb.db.select().from(tasks).where(eq(tasks.id, 'task-1')).get()
      expect(row?.clock).toEqual({ [OFFLINE_DEVICE_KEY]: 2 })
      expect(row?.fieldClocks?.title).toEqual({ [OFFLINE_DEVICE_KEY]: 2 })
    })

    it('#then logs at debug with ids only, never an info line carrying clock objects', () => {
      insertTask({ clock: { [OFFLINE_DEVICE_KEY]: 1 } })

      incrementTaskClocksOffline(asClientDb(testDb.db), 'task-1', ['title', 'priority'])

      expect(logMocks.info).not.toHaveBeenCalled()
      expect(logMocks.debug).toHaveBeenCalledTimes(1)
      expect(logMocks.debug).toHaveBeenCalledWith('Incremented offline task clocks', {
        taskId: 'task-1',
        changedFields: ['title', 'priority']
      })
    })

    it('#given the task does not exist #then no-ops without logging', () => {
      expect(() =>
        incrementTaskClocksOffline(asClientDb(testDb.db), 'missing', ['title'])
      ).not.toThrow()
      expect(logMocks.debug).not.toHaveBeenCalled()
      expect(logMocks.info).not.toHaveBeenCalled()
    })
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

  // The note fallback is the only one that bumps under the real device id and
  // clears `syncedAt` — see the doc comment on the helper for why. What it owes
  // callers is a row `recoverDirtyItems` will re-push, with a clock the server
  // cannot dismiss as a replay.
  describe('incrementNoteClockOffline', () => {
    const SYNCED_AT = '2026-08-04T10:00:00.000Z'

    const insertNote = (values: Record<string, unknown>): void => {
      testDb.db
        .insert(noteMetadata)
        .values({
          path: `notes/${values.id as string}.md`,
          title: 'A note',
          createdAt: '2026-08-01T00:00:00.000Z',
          modifiedAt: '2026-08-01T00:00:00.000Z',
          ...values
        } as never)
        .run()
    }

    const registerDevice = (id: string): void => {
      testDb.db
        .insert(syncDevices)
        .values({
          id,
          name: 'Test device',
          platform: 'darwin',
          appVersion: '1.0.0',
          linkedAt: new Date('2026-08-01T00:00:00.000Z'),
          isCurrentDevice: true,
          signingPublicKey: 'pk'
        })
        .run()
    }

    const readNote = (id: string): { clock: unknown; syncedAt: string | null } | undefined =>
      testDb.db.select().from(noteMetadata).where(eq(noteMetadata.id, id)).get()

    it('#given a synced note #then bumps the clock under the current device and clears syncedAt', () => {
      registerDevice('device-A')
      insertNote({ id: 'note-1', clock: { 'device-A': 3 }, syncedAt: SYNCED_AT })

      incrementNoteClockOffline(asClientDb(testDb.db), 'note-1')

      const row = readNote('note-1')
      expect(row?.clock).toEqual({ 'device-A': 4 })
      expect(row?.syncedAt).toBeNull()
    })

    it('#then never parks a tick under the offline device key', () => {
      registerDevice('device-A')
      insertNote({ id: 'note-1', clock: { 'device-B': 2 }, syncedAt: SYNCED_AT })

      incrementNoteClockOffline(asClientDb(testDb.db), 'note-1')

      // Notes have no rebinding step on the way out, so an `_offline` tick would
      // reach peers verbatim and collide with theirs.
      expect(readNote('note-1')?.clock).toEqual({ 'device-B': 2, 'device-A': 1 })
    })

    it('#given a local-only note #then leaves the row untouched', () => {
      registerDevice('device-A')
      insertNote({ id: 'note-1', clock: { 'device-A': 3 }, syncedAt: SYNCED_AT, localOnly: true })

      incrementNoteClockOffline(asClientDb(testDb.db), 'note-1')

      const row = readNote('note-1')
      expect(row?.clock).toEqual({ 'device-A': 3 })
      expect(row?.syncedAt).toBe(SYNCED_AT)
    })

    it('#given a note that was never pushed #then leaves it to the unclocked seed', () => {
      registerDevice('device-A')
      insertNote({ id: 'note-1' })

      incrementNoteClockOffline(asClientDb(testDb.db), 'note-1')

      expect(readNote('note-1')?.clock).toBeNull()
    })

    it('#given no registered device #then leaves the row untouched', () => {
      insertNote({ id: 'note-1', clock: { 'device-A': 3 }, syncedAt: SYNCED_AT })

      incrementNoteClockOffline(asClientDb(testDb.db), 'note-1')

      const row = readNote('note-1')
      expect(row?.clock).toEqual({ 'device-A': 3 })
      expect(row?.syncedAt).toBe(SYNCED_AT)
    })

    it('#given the note does not exist #then no-ops without throwing', () => {
      registerDevice('device-A')

      expect(() => incrementNoteClockOffline(asClientDb(testDb.db), 'missing')).not.toThrow()
      expect(testDb.db.select().from(noteMetadata).all()).toHaveLength(0)
    })
  })
})
