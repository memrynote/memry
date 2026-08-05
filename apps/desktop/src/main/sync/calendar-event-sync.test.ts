import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  createTestDataDb,
  asClientDb,
  asSyncDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { CalendarEventSyncPayloadSchema } from '@memry/contracts/sync-payloads'
import type { FieldClocks, VectorClock } from '@memry/contracts/sync-api'
import { CALENDAR_EVENT_SYNCABLE_FIELDS } from '../calendar/field-merge-calendar'

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { SyncQueueManager } from './queue'
import { calendarEventHandler } from './item-handlers/calendar-event-handler'
import {
  CalendarEventSyncService,
  initCalendarEventSyncService,
  getCalendarEventSyncService,
  resetCalendarEventSyncService
} from './calendar-event-sync'

const TEST_EVENT = {
  id: 'evt-1',
  title: 'Standup',
  startAt: '2026-08-05T09:00:00.000Z',
  endAt: '2026-08-05T09:15:00.000Z',
  timezone: 'UTC'
}

describe('CalendarEventSyncService', () => {
  let testDb: TestDatabaseResult
  let queue: SyncQueueManager
  let service: CalendarEventSyncService

  beforeEach(() => {
    testDb = createTestDataDb()
    queue = new SyncQueueManager(asClientDb(testDb.db))
    service = new CalendarEventSyncService({
      queue,
      db: asSyncDb(testDb.db),
      getDeviceId: () => 'device-A'
    })
  })

  afterEach(() => {
    resetCalendarEventSyncService()
    testDb.close()
  })

  describe('#given a local event exists #when enqueueCreate called', () => {
    it('#then enqueues a calendar_event create with a bumped doc clock', () => {
      testDb.db.insert(calendarEvents).values(TEST_EVENT).run()

      service.enqueueCreate('evt-1')

      const [item] = queue.dequeue(1)
      expect(item.type).toBe('calendar_event')
      expect(item.itemId).toBe('evt-1')
      expect(item.operation).toBe('create')

      const payload = JSON.parse(item.payload)
      expect(payload.title).toBe('Standup')
      expect(payload.startAt).toBe('2026-08-05T09:00:00.000Z')
      expect(payload.clock).toEqual({ 'device-A': 1 })
    })

    it('#then seeds a field clock for every syncable field', () => {
      testDb.db.insert(calendarEvents).values(TEST_EVENT).run()

      service.enqueueCreate('evt-1')

      const row = testDb.db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.id, 'evt-1'))
        .get()
      const fieldClocks = row?.fieldClocks as FieldClocks
      for (const field of CALENDAR_EVENT_SYNCABLE_FIELDS) {
        expect(fieldClocks[field]).toEqual({ 'device-A': 1 })
      }
    })

    it('#then the enqueued payload still parses as a CalendarEventSyncPayload', () => {
      testDb.db.insert(calendarEvents).values(TEST_EVENT).run()

      service.enqueueCreate('evt-1')

      const [item] = queue.dequeue(1)
      const parsed = CalendarEventSyncPayloadSchema.parse(JSON.parse(item.payload))
      expect(parsed.title).toBe('Standup')
      expect(parsed.fieldClocks?.title).toEqual({ 'device-A': 1 })
    })
  })

  describe('#given changedFields are supplied #when enqueueUpdate called', () => {
    it('#then only those field clocks advance', () => {
      testDb.db.insert(calendarEvents).values(TEST_EVENT).run()
      service.enqueueCreate('evt-1')

      testDb.db
        .update(calendarEvents)
        .set({ title: 'Standup (moved)' })
        .where(eq(calendarEvents.id, 'evt-1'))
        .run()
      service.enqueueUpdate('evt-1', ['title'])

      const row = testDb.db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.id, 'evt-1'))
        .get()
      const fieldClocks = row?.fieldClocks as FieldClocks
      expect(fieldClocks.title).toEqual({ 'device-A': 2 })
      expect(fieldClocks.startAt).toEqual({ 'device-A': 1 })
      expect(row?.clock).toEqual({ 'device-A': 2 })
    })

    it('#then omitting changedFields advances every syncable field', () => {
      testDb.db.insert(calendarEvents).values(TEST_EVENT).run()
      service.enqueueCreate('evt-1')

      service.enqueueUpdate('evt-1')

      const row = testDb.db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.id, 'evt-1'))
        .get()
      const fieldClocks = row?.fieldClocks as FieldClocks
      for (const field of CALENDAR_EVENT_SYNCABLE_FIELDS) {
        expect(fieldClocks[field]).toEqual({ 'device-A': 2 })
      }
    })
  })

  describe('#given a change arrived from sync #when the handler applies it', () => {
    it('#then nothing is enqueued for push (no echo back to the server)', () => {
      // The inbound path writes through the item handler, never through this
      // service. If it ever routed through enqueueUpdate, every pulled event
      // would bounce straight back out and ping-pong between devices.
      const result = calendarEventHandler.applyUpsert(
        { db: asSyncDb(testDb.db), emit: vi.fn() },
        'evt-1',
        { title: 'Standup', startAt: '2026-08-05T09:00:00.000Z', timezone: 'UTC' },
        { 'device-B': 1 }
      )

      expect(result).toBe('applied')
      expect(queue.getPendingCount()).toBe(0)

      const row = testDb.db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.id, 'evt-1'))
        .get()
      expect(row?.title).toBe('Standup')
    })
  })

  describe('#given an external event shares an id with a local event', () => {
    it('#then enqueueUpdate pushes the local calendar_event, never the imported row', () => {
      testDb.db
        .insert(calendarSources)
        .values({
          id: 'src-1',
          provider: 'google',
          kind: 'calendar',
          remoteId: 'primary@example.com',
          title: 'Work'
        })
        .run()
      testDb.db
        .insert(calendarEvents)
        .values({ ...TEST_EVENT, id: 'shared-id' })
        .run()
      testDb.db
        .insert(calendarExternalEvents)
        .values({
          id: 'shared-id',
          sourceId: 'src-1',
          remoteEventId: 'google-evt-1',
          title: 'Google copy',
          startAt: '2026-08-05T09:00:00.000Z'
        })
        .run()

      service.enqueueUpdate('shared-id')

      const [item] = queue.dequeue(1)
      expect(item.type).toBe('calendar_event')
      expect(JSON.parse(item.payload).title).toBe('Standup')

      // The imported row keeps its own identity and is untouched by the local
      // event's clock bump — the two tables are never conflated.
      const external = testDb.db
        .select()
        .from(calendarExternalEvents)
        .where(eq(calendarExternalEvents.id, 'shared-id'))
        .get()
      expect(external?.title).toBe('Google copy')
      expect(external?.clock).toBeNull()
    })
  })

  describe('#given the row is not present locally #when enqueueCreate called', () => {
    it('#then the outbound push is dropped with no error and no queue entry', () => {
      service.enqueueCreate('evt-missing')

      expect(queue.getPendingCount()).toBe(0)
    })
  })

  describe('#given no device id #when enqueueCreate called', () => {
    it('#then skips silently', () => {
      const noDevice = new CalendarEventSyncService({
        queue,
        db: asSyncDb(testDb.db),
        getDeviceId: () => null
      })
      testDb.db.insert(calendarEvents).values(TEST_EVENT).run()

      noDevice.enqueueCreate('evt-1')

      expect(queue.getPendingCount()).toBe(0)
    })
  })

  describe('#when enqueueDelete called', () => {
    it('#then a snapshot payload is shipped with an incremented clock', () => {
      const snapshot = JSON.stringify({ ...TEST_EVENT, clock: { 'device-A': 6 } })

      service.enqueueDelete('evt-1', snapshot)

      const [item] = queue.dequeue(1)
      expect(item.operation).toBe('delete')
      expect(item.type).toBe('calendar_event')
      expect(JSON.parse(item.payload).clock).toEqual({ 'device-A': 7 })
    })

    it('#then a delete with neither snapshot nor row still enqueues an id-only tombstone', () => {
      service.enqueueDelete('evt-gone')

      const [item] = queue.dequeue(1)
      expect(item.operation).toBe('delete')
      expect(JSON.parse(item.payload)).toEqual({ id: 'evt-gone', clock: { 'device-A': 1 } })
    })
  })

  describe('#given a peer holds the same event #when the built delete payload is applied there', () => {
    it('#then the delete propagates rather than being skipped as concurrent', () => {
      const originClock: VectorClock = { 'device-A': 2 }
      testDb.db
        .insert(calendarEvents)
        .values({ ...TEST_EVENT, clock: originClock })
        .run()

      service.enqueueDelete('evt-1')
      const [item] = queue.dequeue(1)
      const { clock } = JSON.parse(item.payload) as { clock: VectorClock }

      const peerDb = createTestDataDb()
      try {
        peerDb.db
          .insert(calendarEvents)
          .values({ ...TEST_EVENT, clock: originClock })
          .run()

        const result = calendarEventHandler.applyDelete(
          { db: asSyncDb(peerDb.db), emit: vi.fn() },
          'evt-1',
          clock
        )

        expect(result).toBe('applied')
        expect(
          peerDb.db.select().from(calendarEvents).where(eq(calendarEvents.id, 'evt-1')).get()
        ).toBeUndefined()
      } finally {
        peerDb.close()
      }
    })
  })

  describe('#given an event pinned to a specific Google calendar', () => {
    // PRODUCT BUG. `targetCalendarId` is what routes a push to the right Google
    // calendar (see calendar/google/account-routing.ts and sync-service.ts), and
    // promote-external-event.ts sets it. serialize() ships the whole row so the
    // column does leave this device — but CalendarEventSyncPayloadSchema has no
    // `targetCalendarId` key, so zod strips it on the receiving side and the
    // peer falls back to the memry-managed calendar. The pin is silently lost
    // cross-device.
    it.fails('#then the target calendar survives the sync payload contract', () => {
      testDb.db
        .insert(calendarEvents)
        .values({ ...TEST_EVENT, targetCalendarId: 'work@group.calendar.google.com' })
        .run()

      service.enqueueCreate('evt-1')

      const [item] = queue.dequeue(1)
      const raw = JSON.parse(item.payload)
      expect(raw.targetCalendarId).toBe('work@group.calendar.google.com')

      const parsed = CalendarEventSyncPayloadSchema.parse(raw) as Record<string, unknown>
      expect(parsed.targetCalendarId).toBe('work@group.calendar.google.com')
    })
  })

  describe('module-level accessor', () => {
    it('#then returns null before init', () => {
      expect(getCalendarEventSyncService()).toBeNull()
    })

    it('#then returns the instance after init and null after reset', () => {
      const svc = initCalendarEventSyncService({
        queue,
        db: asSyncDb(testDb.db),
        getDeviceId: () => 'device-A'
      })
      expect(getCalendarEventSyncService()).toBe(svc)

      resetCalendarEventSyncService()
      expect(getCalendarEventSyncService()).toBeNull()
    })
  })
})
