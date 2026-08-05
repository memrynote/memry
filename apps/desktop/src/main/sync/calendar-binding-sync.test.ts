import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  createTestDataDb,
  asClientDb,
  asSyncDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { CalendarBindingSyncPayloadSchema } from '@memry/contracts/sync-payloads'
import type { VectorClock } from '@memry/contracts/sync-api'

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { SyncQueueManager } from './queue'
import { calendarBindingHandler } from './item-handlers/calendar-binding-handler'
import {
  CalendarBindingSyncService,
  initCalendarBindingSyncService,
  getCalendarBindingSyncService,
  resetCalendarBindingSyncService
} from './calendar-binding-sync'

const TEST_BINDING = {
  id: 'bind-1',
  sourceType: 'event' as const,
  sourceId: 'evt-1',
  provider: 'google',
  remoteCalendarId: 'primary@example.com',
  remoteEventId: 'google-evt-1',
  ownershipMode: 'memry_managed' as const,
  writebackMode: 'broad' as const
}

describe('CalendarBindingSyncService', () => {
  let testDb: TestDatabaseResult
  let queue: SyncQueueManager
  let service: CalendarBindingSyncService

  beforeEach(() => {
    testDb = createTestDataDb()
    queue = new SyncQueueManager(asClientDb(testDb.db))
    service = new CalendarBindingSyncService({
      queue,
      db: asSyncDb(testDb.db),
      getDeviceId: () => 'device-A'
    })
  })

  afterEach(() => {
    resetCalendarBindingSyncService()
    testDb.close()
  })

  describe('#given a local binding exists #when enqueueCreate called', () => {
    it('#then enqueues a calendar_binding create carrying the row and a bumped clock', () => {
      testDb.db.insert(calendarBindings).values(TEST_BINDING).run()

      service.enqueueCreate('bind-1')

      const [item] = queue.dequeue(1)
      expect(item.type).toBe('calendar_binding')
      expect(item.itemId).toBe('bind-1')
      expect(item.operation).toBe('create')

      const payload = JSON.parse(item.payload)
      expect(payload.sourceType).toBe('event')
      expect(payload.sourceId).toBe('evt-1')
      expect(payload.remoteEventId).toBe('google-evt-1')
      expect(payload.clock).toEqual({ 'device-A': 1 })
    })

    it('#then the enqueued payload still parses as a CalendarBindingSyncPayload', () => {
      testDb.db.insert(calendarBindings).values(TEST_BINDING).run()

      service.enqueueCreate('bind-1')

      const [item] = queue.dequeue(1)
      const parsed = CalendarBindingSyncPayloadSchema.parse(JSON.parse(item.payload))
      expect(parsed.ownershipMode).toBe('memry_managed')
      expect(parsed.writebackMode).toBe('broad')
    })
  })

  describe('#given a binding with an existing clock #when enqueueUpdate called', () => {
    it('#then persists the incremented clock on the row and ships the same clock', () => {
      const existingClock: VectorClock = { 'device-A': 1, 'device-B': 5 }
      testDb.db
        .insert(calendarBindings)
        .values({ ...TEST_BINDING, clock: existingClock })
        .run()

      service.enqueueUpdate('bind-1')

      const row = testDb.db
        .select()
        .from(calendarBindings)
        .where(eq(calendarBindings.id, 'bind-1'))
        .get()
      expect(row?.clock).toEqual({ 'device-A': 2, 'device-B': 5 })

      const [item] = queue.dequeue(1)
      expect(item.operation).toBe('update')
      expect(JSON.parse(item.payload).clock).toEqual({ 'device-A': 2, 'device-B': 5 })
    })
  })

  describe('#given a change arrived from sync #when the handler applies it', () => {
    it('#then nothing is enqueued for push (no echo back to the server)', () => {
      const result = calendarBindingHandler.applyUpsert(
        { db: asSyncDb(testDb.db), emit: vi.fn() },
        'bind-1',
        {
          sourceType: 'event',
          sourceId: 'evt-1',
          provider: 'google',
          remoteCalendarId: 'primary@example.com',
          remoteEventId: 'google-evt-1',
          ownershipMode: 'memry_managed',
          writebackMode: 'broad'
        },
        { 'device-B': 1 }
      )

      expect(result).toBe('applied')
      expect(queue.getPendingCount()).toBe(0)
    })
  })

  describe('#given the calendar_source it points at is not present locally', () => {
    it('#then the binding is still written and still pushes — it holds no FK to calendar_sources', () => {
      // calendar_bindings addresses the remote calendar by provider +
      // remote_calendar_id strings, with no `references()` to calendar_sources.
      // So the missing-parent convention in item-handlers/types.ts
      // (MissingSyncParentError -> engine/orphan-repair) never applies here:
      // a binding can neither be blocked by nor repaired against a missing
      // source. It survives, but it also stays permanently unresolvable if the
      // source never arrives.
      expect(
        testDb.db.select().from(calendarSources).where(eq(calendarSources.id, 'src-1')).get()
      ).toBeUndefined()

      testDb.db
        .insert(calendarBindings)
        .values({ ...TEST_BINDING, remoteCalendarId: 'never-synced@example.com' })
        .run()

      service.enqueueCreate('bind-1')

      const [item] = queue.dequeue(1)
      expect(item.operation).toBe('create')
      expect(JSON.parse(item.payload).remoteCalendarId).toBe('never-synced@example.com')
    })
  })

  describe('#given the row is not present locally #when enqueueCreate called', () => {
    it('#then the outbound push is dropped with no error and no queue entry', () => {
      service.enqueueCreate('bind-missing')

      expect(queue.getPendingCount()).toBe(0)
    })
  })

  describe('#given no device id #when enqueueCreate called', () => {
    it('#then skips silently', () => {
      const noDevice = new CalendarBindingSyncService({
        queue,
        db: asSyncDb(testDb.db),
        getDeviceId: () => null
      })
      testDb.db.insert(calendarBindings).values(TEST_BINDING).run()

      noDevice.enqueueCreate('bind-1')

      expect(queue.getPendingCount()).toBe(0)
    })
  })

  describe('#when enqueueDelete called', () => {
    it('#then a snapshot payload is shipped with an incremented clock', () => {
      const snapshot = JSON.stringify({ ...TEST_BINDING, clock: { 'device-A': 4 } })

      service.enqueueDelete('bind-1', snapshot)

      const [item] = queue.dequeue(1)
      expect(item.operation).toBe('delete')
      expect(item.type).toBe('calendar_binding')
      expect(JSON.parse(item.payload).clock).toEqual({ 'device-A': 5 })
    })

    it('#then a delete with neither snapshot nor row still enqueues an id-only tombstone', () => {
      service.enqueueDelete('bind-gone')

      const [item] = queue.dequeue(1)
      expect(item.operation).toBe('delete')
      expect(JSON.parse(item.payload)).toEqual({ id: 'bind-gone', clock: { 'device-A': 1 } })
    })
  })

  describe('#given a peer holds the same binding #when the built delete payload is applied there', () => {
    it('#then the delete propagates rather than being skipped as concurrent', () => {
      const originClock: VectorClock = { 'device-A': 3 }
      testDb.db
        .insert(calendarBindings)
        .values({ ...TEST_BINDING, clock: originClock })
        .run()

      service.enqueueDelete('bind-1')
      const [item] = queue.dequeue(1)
      const { clock } = JSON.parse(item.payload) as { clock: VectorClock }

      const peerDb = createTestDataDb()
      try {
        peerDb.db
          .insert(calendarBindings)
          .values({ ...TEST_BINDING, clock: originClock })
          .run()

        const result = calendarBindingHandler.applyDelete(
          { db: asSyncDb(peerDb.db), emit: vi.fn() },
          'bind-1',
          clock
        )

        expect(result).toBe('applied')
        expect(
          peerDb.db.select().from(calendarBindings).where(eq(calendarBindings.id, 'bind-1')).get()
        ).toBeUndefined()
      } finally {
        peerDb.close()
      }
    })
  })

  describe('module-level accessor', () => {
    it('#then returns null before init', () => {
      expect(getCalendarBindingSyncService()).toBeNull()
    })

    it('#then returns the instance after init and null after reset', () => {
      const svc = initCalendarBindingSyncService({
        queue,
        db: asSyncDb(testDb.db),
        getDeviceId: () => 'device-A'
      })
      expect(getCalendarBindingSyncService()).toBe(svc)

      resetCalendarBindingSyncService()
      expect(getCalendarBindingSyncService()).toBeNull()
    })
  })
})
