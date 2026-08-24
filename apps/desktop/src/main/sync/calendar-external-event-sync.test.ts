import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  createTestDataDb,
  asClientDb,
  asSyncDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { CalendarExternalEventSyncPayloadSchema } from '@memry/contracts/sync-payloads'
import type { VectorClock } from '@memry/contracts/sync-api'

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { SyncQueueManager } from '@memry/sync-client/queue'
import { MissingSyncParentError } from '@memry/sync-client/item-handlers/types'
import { calendarExternalEventHandler } from '@memry/sync-client/item-handlers/calendar-external-event-handler'
import {
  CalendarExternalEventSyncService,
  initCalendarExternalEventSyncService,
  getCalendarExternalEventSyncService,
  resetCalendarExternalEventSyncService
} from '@memry/sync-client/calendar-external-event-sync'

const TEST_SOURCE = {
  id: 'src-1',
  provider: 'google',
  kind: 'calendar' as const,
  remoteId: 'primary@example.com',
  title: 'Work'
}

const TEST_EXTERNAL = {
  id: 'ext-1',
  sourceId: 'src-1',
  remoteEventId: 'google-evt-1',
  title: 'Imported standup',
  startAt: '2026-08-05T09:00:00.000Z',
  endAt: '2026-08-05T09:15:00.000Z'
}

describe('CalendarExternalEventSyncService', () => {
  let testDb: TestDatabaseResult
  let queue: SyncQueueManager
  let service: CalendarExternalEventSyncService

  beforeEach(() => {
    testDb = createTestDataDb()
    queue = new SyncQueueManager(asClientDb(testDb.db))
    service = new CalendarExternalEventSyncService({
      queue,
      db: asSyncDb(testDb.db),
      getDeviceId: () => 'device-A'
    })
    testDb.db.insert(calendarSources).values(TEST_SOURCE).run()
  })

  afterEach(() => {
    resetCalendarExternalEventSyncService()
    testDb.close()
  })

  describe('#given a local external event exists #when enqueueCreate called', () => {
    it('#then enqueues a calendar_external_event create with a bumped clock', () => {
      testDb.db.insert(calendarExternalEvents).values(TEST_EXTERNAL).run()

      service.enqueueCreate('ext-1')

      const [item] = queue.dequeue(1)
      expect(item.type).toBe('calendar_external_event')
      expect(item.itemId).toBe('ext-1')
      expect(item.operation).toBe('create')

      const payload = JSON.parse(item.payload)
      expect(payload.sourceId).toBe('src-1')
      expect(payload.remoteEventId).toBe('google-evt-1')
      expect(payload.title).toBe('Imported standup')
      expect(payload.clock).toEqual({ 'device-A': 1 })
    })

    it('#then the enqueued payload still parses as a CalendarExternalEventSyncPayload', () => {
      testDb.db.insert(calendarExternalEvents).values(TEST_EXTERNAL).run()

      service.enqueueCreate('ext-1')

      const [item] = queue.dequeue(1)
      const parsed = CalendarExternalEventSyncPayloadSchema.parse(JSON.parse(item.payload))
      // sourceId is the FK the receiving device needs to reattach the event to
      // its calendar — losing it here would strand the event on every peer.
      expect(parsed.sourceId).toBe('src-1')
      expect(parsed.status).toBe('confirmed')
    })
  })

  describe('#given an external event with an existing clock #when enqueueUpdate called', () => {
    it('#then persists the incremented clock on the row and ships the same clock', () => {
      const existingClock: VectorClock = { 'device-A': 3, 'device-B': 1 }
      testDb.db
        .insert(calendarExternalEvents)
        .values({ ...TEST_EXTERNAL, clock: existingClock })
        .run()

      service.enqueueUpdate('ext-1')

      const row = testDb.db
        .select()
        .from(calendarExternalEvents)
        .where(eq(calendarExternalEvents.id, 'ext-1'))
        .get()
      expect(row?.clock).toEqual({ 'device-A': 4, 'device-B': 1 })

      const [item] = queue.dequeue(1)
      expect(item.operation).toBe('update')
      expect(JSON.parse(item.payload).clock).toEqual({ 'device-A': 4, 'device-B': 1 })
    })
  })

  describe('#given a change arrived from sync #when the handler applies it', () => {
    it('#then nothing is enqueued for push (no echo back to the server)', () => {
      const result = calendarExternalEventHandler.applyUpsert(
        { db: asSyncDb(testDb.db), emit: vi.fn() },
        'ext-1',
        {
          sourceId: 'src-1',
          remoteEventId: 'google-evt-1',
          title: 'Imported standup',
          startAt: '2026-08-05T09:00:00.000Z'
        },
        { 'device-B': 1 }
      )

      expect(result).toBe('applied')
      expect(queue.getPendingCount()).toBe(0)
    })
  })

  describe('#given the calendar_source it references is not present locally', () => {
    it('#then the row cannot even exist locally — the FK is enforced', () => {
      expect(() =>
        testDb.db
          .insert(calendarExternalEvents)
          .values({ ...TEST_EXTERNAL, id: 'ext-orphan', sourceId: 'src-never-synced' })
          .run()
      ).toThrow(/FOREIGN KEY constraint failed/)
    })

    // PRODUCT BUG (candidate root cause for "Google Calendar says connected but
    // no events appear" on a second device).
    //
    // calendar_external_events.source_id is a real FK to calendar_sources with
    // ON DELETE cascade. When a pull hands the external event to the handler
    // before its calendar_source has landed (both are ordinary sync items with
    // no ordering guarantee, and the source can easily sit outside this run's
    // cursor window), the insert raises a bare SQLite "FOREIGN KEY constraint
    // failed".
    //
    // The established convention for that case — see
    // item-handlers/types.ts MissingSyncParentError and engine/orphan-repair.ts
    // — is for the handler to throw MissingSyncParentError so the pull
    // coordinator can defer, re-fetch the parent by id, and either repair the
    // child or tombstone it (#837). Today only task-handler.ts does that.
    // calendar-external-event-handler.ts inserts blind, so the pull coordinator
    // sees an unclassified error, retries once, then logs
    // "item skipped until next remote update" and drops the event. There is no
    // next remote update for an unchanged Google event, so the events never
    // appear on that device — while the calendar_source itself syncs fine and
    // the UI still reports "connected".
    //
    // Worse, the insert defaults `sourceId` to the literal 'unknown-source'
    // when the payload omits it, which can only ever FK-fail.
    it('#then the handler reports it as a typed missing-parent, not a raw FK error', () => {
      expect(() =>
        calendarExternalEventHandler.applyUpsert(
          { db: asSyncDb(testDb.db), emit: vi.fn() },
          'ext-orphan',
          {
            sourceId: 'src-never-synced',
            remoteEventId: 'google-evt-orphan',
            title: 'Imported standup',
            startAt: '2026-08-05T09:00:00.000Z'
          },
          { 'device-B': 1 }
        )
      ).toThrow(MissingSyncParentError)
    })
  })

  describe('#given an external event and a local event share an id', () => {
    it('#then enqueueUpdate pushes the imported row, never the local calendar_event', () => {
      testDb.db
        .insert(calendarEvents)
        .values({
          id: 'shared-id',
          title: 'Local standup',
          startAt: '2026-08-05T09:00:00.000Z'
        })
        .run()
      testDb.db
        .insert(calendarExternalEvents)
        .values({ ...TEST_EXTERNAL, id: 'shared-id' })
        .run()

      service.enqueueUpdate('shared-id')

      const [item] = queue.dequeue(1)
      expect(item.type).toBe('calendar_external_event')
      const payload = JSON.parse(item.payload)
      expect(payload.title).toBe('Imported standup')
      expect(payload.sourceId).toBe('src-1')

      // The local event keeps its own identity and clock — a Google-originated
      // change never bumps it.
      const localEvent = testDb.db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.id, 'shared-id'))
        .get()
      expect(localEvent?.title).toBe('Local standup')
      expect(localEvent?.clock).toBeNull()
    })
  })

  describe('#given the row is not present locally #when enqueueCreate called', () => {
    it('#then the outbound push is dropped with no error and no queue entry', () => {
      service.enqueueCreate('ext-missing')

      expect(queue.getPendingCount()).toBe(0)
    })
  })

  describe('#given no device id #when enqueueCreate called', () => {
    it('#then skips silently', () => {
      const noDevice = new CalendarExternalEventSyncService({
        queue,
        db: asSyncDb(testDb.db),
        getDeviceId: () => null
      })
      testDb.db.insert(calendarExternalEvents).values(TEST_EXTERNAL).run()

      noDevice.enqueueCreate('ext-1')

      expect(queue.getPendingCount()).toBe(0)
    })
  })

  describe('#when enqueueDelete called', () => {
    it('#then a snapshot payload is shipped with an incremented clock', () => {
      const snapshot = JSON.stringify({ ...TEST_EXTERNAL, clock: { 'device-A': 2 } })

      service.enqueueDelete('ext-1', snapshot)

      const [item] = queue.dequeue(1)
      expect(item.operation).toBe('delete')
      expect(item.type).toBe('calendar_external_event')
      expect(JSON.parse(item.payload).clock).toEqual({ 'device-A': 3 })
    })

    it('#then a delete with neither snapshot nor row still enqueues an id-only tombstone', () => {
      service.enqueueDelete('ext-gone')

      const [item] = queue.dequeue(1)
      expect(item.operation).toBe('delete')
      expect(JSON.parse(item.payload)).toEqual({ id: 'ext-gone', clock: { 'device-A': 1 } })
    })
  })

  describe('#given a peer holds the same external event #when the built delete payload is applied there', () => {
    it('#then the delete propagates rather than being skipped as concurrent', () => {
      const originClock: VectorClock = { 'device-A': 2 }
      testDb.db
        .insert(calendarExternalEvents)
        .values({ ...TEST_EXTERNAL, clock: originClock })
        .run()

      service.enqueueDelete('ext-1')
      const [item] = queue.dequeue(1)
      const { clock } = JSON.parse(item.payload) as { clock: VectorClock }

      const peerDb = createTestDataDb()
      try {
        peerDb.db.insert(calendarSources).values(TEST_SOURCE).run()
        peerDb.db
          .insert(calendarExternalEvents)
          .values({ ...TEST_EXTERNAL, clock: originClock })
          .run()

        const result = calendarExternalEventHandler.applyDelete(
          { db: asSyncDb(peerDb.db), emit: vi.fn() },
          'ext-1',
          clock
        )

        expect(result).toBe('applied')
        expect(
          peerDb.db
            .select()
            .from(calendarExternalEvents)
            .where(eq(calendarExternalEvents.id, 'ext-1'))
            .get()
        ).toBeUndefined()
      } finally {
        peerDb.close()
      }
    })
  })

  describe('module-level accessor', () => {
    it('#then returns null before init', () => {
      expect(getCalendarExternalEventSyncService()).toBeNull()
    })

    it('#then returns the instance after init and null after reset', () => {
      const svc = initCalendarExternalEventSyncService({
        queue,
        db: asSyncDb(testDb.db),
        getDeviceId: () => 'device-A'
      })
      expect(getCalendarExternalEventSyncService()).toBe(svc)

      resetCalendarExternalEventSyncService()
      expect(getCalendarExternalEventSyncService()).toBeNull()
    })
  })
})
