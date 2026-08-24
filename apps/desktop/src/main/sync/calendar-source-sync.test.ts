import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  createTestDataDb,
  asClientDb,
  asSyncDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { CalendarSourceSyncPayloadSchema } from '@memry/contracts/sync-payloads'
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
import { calendarSourceHandler } from '@memry/sync-client/item-handlers/calendar-source-handler'
import {
  CalendarSourceSyncService,
  initCalendarSourceSyncService,
  getCalendarSourceSyncService,
  resetCalendarSourceSyncService
} from '@memry/sync-client/calendar-source-sync'

const TEST_SOURCE = {
  id: 'src-1',
  provider: 'google',
  kind: 'calendar' as const,
  accountId: 'acct-1',
  remoteId: 'primary@example.com',
  title: 'Work',
  isPrimary: true,
  isSelected: true
}

describe('CalendarSourceSyncService', () => {
  let testDb: TestDatabaseResult
  let queue: SyncQueueManager
  let service: CalendarSourceSyncService

  beforeEach(() => {
    testDb = createTestDataDb()
    queue = new SyncQueueManager(asClientDb(testDb.db))
    service = new CalendarSourceSyncService({
      queue,
      db: asSyncDb(testDb.db),
      getDeviceId: () => 'device-A'
    })
  })

  afterEach(() => {
    resetCalendarSourceSyncService()
    testDb.close()
  })

  describe('#given a local source exists #when enqueueCreate called', () => {
    it('#then enqueues a calendar_source create carrying the row and a bumped clock', () => {
      testDb.db.insert(calendarSources).values(TEST_SOURCE).run()

      service.enqueueCreate('src-1')

      const [item] = queue.dequeue(1)
      expect(item.type).toBe('calendar_source')
      expect(item.itemId).toBe('src-1')
      expect(item.operation).toBe('create')

      const payload = JSON.parse(item.payload)
      expect(payload.title).toBe('Work')
      expect(payload.remoteId).toBe('primary@example.com')
      expect(payload.isSelected).toBe(true)
      expect(payload.clock).toEqual({ 'device-A': 1 })
    })

    it('#then the enqueued payload still parses as a CalendarSourceSyncPayload', () => {
      // serialize() ships the raw drizzle row, so a column the contract does not
      // know about must not break the receiving device's schema.parse().
      testDb.db.insert(calendarSources).values(TEST_SOURCE).run()

      service.enqueueCreate('src-1')

      const [item] = queue.dequeue(1)
      const parsed = CalendarSourceSyncPayloadSchema.parse(JSON.parse(item.payload))
      expect(parsed.title).toBe('Work')
      expect(parsed.kind).toBe('calendar')
    })
  })

  describe('#given a source with an existing clock #when enqueueUpdate called', () => {
    it('#then persists the incremented clock on the row and ships the same clock', () => {
      const existingClock: VectorClock = { 'device-A': 2, 'device-B': 4 }
      testDb.db
        .insert(calendarSources)
        .values({ ...TEST_SOURCE, clock: existingClock })
        .run()

      service.enqueueUpdate('src-1')

      const row = testDb.db
        .select()
        .from(calendarSources)
        .where(eq(calendarSources.id, 'src-1'))
        .get()
      expect(row?.clock).toEqual({ 'device-A': 3, 'device-B': 4 })

      const [item] = queue.dequeue(1)
      expect(item.operation).toBe('update')
      expect(JSON.parse(item.payload).clock).toEqual({ 'device-A': 3, 'device-B': 4 })
    })
  })

  describe('#given a change arrived from sync #when the handler applies it', () => {
    it('#then nothing is enqueued for push (no echo back to the server)', () => {
      // The inbound path writes through the item handler, never through this
      // service — that separation IS the echo guard. If a handler ever started
      // routing writes through enqueueUpdate, every pulled source would bounce
      // straight back out and ping-pong between devices.
      const result = calendarSourceHandler.applyUpsert(
        { db: asSyncDb(testDb.db), emit: vi.fn() },
        'src-1',
        {
          provider: 'google',
          kind: 'calendar',
          remoteId: 'primary@example.com',
          title: 'Work'
        },
        { 'device-B': 1 }
      )

      expect(result).toBe('applied')
      expect(queue.getPendingCount()).toBe(0)

      const row = testDb.db
        .select()
        .from(calendarSources)
        .where(eq(calendarSources.id, 'src-1'))
        .get()
      expect(row?.clock).toEqual({ 'device-B': 1 })
    })
  })

  describe('#given the row is not present locally #when enqueueCreate called', () => {
    it('#then the outbound push is dropped with no error and no queue entry', () => {
      // Documented current behaviour: RecordSyncController.load() returning
      // undefined is an unconditional silent return. A caller that enqueues
      // before the insert commits loses the push entirely.
      service.enqueueCreate('src-missing')

      expect(queue.getPendingCount()).toBe(0)
    })
  })

  describe('#given no device id #when enqueueCreate called', () => {
    it('#then skips silently', () => {
      const noDevice = new CalendarSourceSyncService({
        queue,
        db: asSyncDb(testDb.db),
        getDeviceId: () => null
      })
      testDb.db.insert(calendarSources).values(TEST_SOURCE).run()

      noDevice.enqueueCreate('src-1')

      expect(queue.getPendingCount()).toBe(0)
    })
  })

  describe('#when enqueueDelete called', () => {
    it('#then a snapshot payload is shipped with an incremented clock', () => {
      const snapshot = JSON.stringify({ ...TEST_SOURCE, clock: { 'device-A': 2 } })

      service.enqueueDelete('src-1', snapshot)

      const [item] = queue.dequeue(1)
      expect(item.operation).toBe('delete')
      expect(item.type).toBe('calendar_source')
      const payload = JSON.parse(item.payload)
      expect(payload.title).toBe('Work')
      expect(payload.clock).toEqual({ 'device-A': 3 })
    })

    it('#then a delete with no snapshot still ships the row and its bumped clock', () => {
      testDb.db
        .insert(calendarSources)
        .values({ ...TEST_SOURCE, clock: { 'device-A': 2 } })
        .run()

      service.enqueueDelete('src-1')

      const [item] = queue.dequeue(1)
      expect(item.operation).toBe('delete')
      expect(JSON.parse(item.payload).clock).toEqual({ 'device-A': 3 })
    })

    it('#then a delete with neither snapshot nor row still enqueues an id-only tombstone', () => {
      service.enqueueDelete('src-gone')

      const [item] = queue.dequeue(1)
      expect(item.operation).toBe('delete')
      expect(JSON.parse(item.payload)).toEqual({ id: 'src-gone', clock: { 'device-A': 1 } })
    })
  })

  describe('#given a peer holds the same source #when the built delete payload is applied there', () => {
    it('#then the delete propagates rather than being skipped as concurrent', () => {
      const originClock: VectorClock = { 'device-A': 2 }
      testDb.db
        .insert(calendarSources)
        .values({ ...TEST_SOURCE, clock: originClock })
        .run()

      service.enqueueDelete('src-1')
      const [item] = queue.dequeue(1)
      const { clock } = JSON.parse(item.payload) as { clock: VectorClock }

      const peerDb = createTestDataDb()
      try {
        peerDb.db
          .insert(calendarSources)
          .values({ ...TEST_SOURCE, clock: originClock })
          .run()

        const result = calendarSourceHandler.applyDelete(
          { db: asSyncDb(peerDb.db), emit: vi.fn() },
          'src-1',
          clock
        )

        expect(result).toBe('applied')
        const row = peerDb.db
          .select()
          .from(calendarSources)
          .where(eq(calendarSources.id, 'src-1'))
          .get()
        expect(row).toBeUndefined()
      } finally {
        peerDb.close()
      }
    })
  })

  describe('module-level accessor', () => {
    it('#then returns null before init', () => {
      expect(getCalendarSourceSyncService()).toBeNull()
    })

    it('#then returns the instance after init and null after reset', () => {
      const svc = initCalendarSourceSyncService({
        queue,
        db: asSyncDb(testDb.db),
        getDeviceId: () => 'device-A'
      })
      expect(getCalendarSourceSyncService()).toBe(svc)

      resetCalendarSourceSyncService()
      expect(getCalendarSourceSyncService()).toBeNull()
    })
  })
})
