/**
 * #2374: nothing from the macOS Calendar provider (`apple-eventkit`) ever
 * enters the sync queue, whether through a create, an update, a delete or the
 * unclocked sweep. Windows, Linux and older builds therefore never receive a
 * row from it. The services and handlers live in `packages/sync-client`; their
 * SQLite tests live here because only the desktop package ships a SQLite driver.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  APPLE_EVENTKIT_CALENDAR_PROVIDER,
  DEVICE_LOCAL_CALENDAR_PROVIDERS,
  GOOGLE_CALENDAR_PROVIDER
} from '@memry/contracts/calendar-api'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import {
  asClientDb,
  asSyncDb,
  createTestDataDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { CalendarSourceSyncService } from '@memry/sync-client/calendar-source-sync'
import { CalendarExternalEventSyncService } from '@memry/sync-client/calendar-external-event-sync'
import { calendarExternalEventHandler } from '@memry/sync-client/item-handlers/calendar-external-event-handler'
import { calendarSourceHandler } from '@memry/sync-client/item-handlers/calendar-source-handler'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

const NOW = '2026-09-24T08:00:00.000Z'

describe('device-local calendar provider rows never reach the sync queue (#2374)', () => {
  let testDb: TestDatabaseResult
  let db: DrizzleDb
  let queue: SyncQueueManager
  let sources: CalendarSourceSyncService
  let events: CalendarExternalEventSyncService

  beforeEach(() => {
    testDb = createTestDataDb()
    db = testDb.db as unknown as DrizzleDb
    queue = new SyncQueueManager(asClientDb(testDb.db))
    const deps = { queue, db: asSyncDb(testDb.db), getDeviceId: () => 'device-A' }
    sources = new CalendarSourceSyncService(deps)
    events = new CalendarExternalEventSyncService(deps)
  })

  afterEach(() => {
    testDb.close()
  })

  function insertSource(id: string, provider: string): void {
    db.insert(calendarSources)
      .values({
        id,
        provider,
        kind: 'calendar',
        accountId: `${provider}-account`,
        remoteId: `${id}-remote`,
        title: 'Work',
        isSelected: true,
        syncStatus: 'ok',
        createdAt: NOW,
        modifiedAt: NOW
      })
      .run()
  }

  function insertEvent(id: string, sourceId: string): void {
    db.insert(calendarExternalEvents)
      .values({
        id,
        sourceId,
        remoteEventId: `${id}-remote`,
        title: 'Stand-up',
        startAt: NOW,
        isAllDay: false,
        status: 'confirmed',
        createdAt: NOW,
        modifiedAt: NOW
      })
      .run()
  }

  function queued(): Array<{ type: string; itemId: string; operation: string }> {
    return db
      .select()
      .from(syncQueue)
      .all()
      .map(({ type, itemId, operation }) => ({ type, itemId, operation }))
  }

  it('lists the provider as device-local for sources and mirrors', () => {
    expect(DEVICE_LOCAL_CALENDAR_PROVIDERS.sources).toContain(APPLE_EVENTKIT_CALENDAR_PROVIDER)
    expect(DEVICE_LOCAL_CALENDAR_PROVIDERS.mirrors).toContain(APPLE_EVENTKIT_CALENDAR_PROVIDER)
  })

  it('never enqueues a source row on create, update or delete, and leaves it unclocked', () => {
    insertSource('apple-eventkit:cal-1', APPLE_EVENTKIT_CALENDAR_PROVIDER)

    sources.enqueueCreate('apple-eventkit:cal-1')
    sources.enqueueUpdate('apple-eventkit:cal-1')
    sources.enqueueDelete('apple-eventkit:cal-1')

    expect(queued()).toEqual([])
    const row = db
      .select()
      .from(calendarSources)
      .where(eq(calendarSources.id, 'apple-eventkit:cal-1'))
      .get()
    expect(row?.clock).toBeNull()
  })

  it('never enqueues a source delete from a snapshot once the row is gone', () => {
    insertSource('apple-eventkit:cal-1', APPLE_EVENTKIT_CALENDAR_PROVIDER)
    const snapshot = JSON.stringify(
      db.select().from(calendarSources).where(eq(calendarSources.id, 'apple-eventkit:cal-1')).get()
    )
    db.delete(calendarSources).where(eq(calendarSources.id, 'apple-eventkit:cal-1')).run()

    sources.enqueueDelete('apple-eventkit:cal-1', snapshot)

    expect(queued()).toEqual([])
  })

  it('never enqueues an event on create, update or delete, with or without a snapshot', () => {
    insertSource('apple-eventkit:cal-1', APPLE_EVENTKIT_CALENDAR_PROVIDER)
    insertEvent('evt-1', 'apple-eventkit:cal-1')
    insertEvent('evt-2', 'apple-eventkit:cal-1')

    events.enqueueCreate('evt-1')
    events.enqueueUpdate('evt-1')
    events.enqueueDelete('evt-1')

    const snapshot = JSON.stringify(
      db.select().from(calendarExternalEvents).where(eq(calendarExternalEvents.id, 'evt-2')).get()
    )
    db.delete(calendarExternalEvents).where(eq(calendarExternalEvents.id, 'evt-2')).run()
    events.enqueueDelete('evt-2', snapshot)

    expect(queued()).toEqual([])
    const row = db
      .select()
      .from(calendarExternalEvents)
      .where(eq(calendarExternalEvents.id, 'evt-1'))
      .get()
    expect(row?.clock).toBeNull()
  })

  it('leaves both out of the unclocked sweep while a synced provider still goes', () => {
    insertSource('apple-eventkit:cal-1', APPLE_EVENTKIT_CALENDAR_PROVIDER)
    insertEvent('mac-evt', 'apple-eventkit:cal-1')
    insertSource('google-src', GOOGLE_CALENDAR_PROVIDER)
    insertEvent('google-evt', 'google-src')

    expect(calendarSourceHandler.seedUnclocked(db, 'device-A', queue)).toBe(1)
    expect(calendarExternalEventHandler.seedUnclocked(db, 'device-A', queue)).toBe(1)

    expect(queued().map((item) => item.itemId)).toEqual(['google-src', 'google-evt'])
  })

  it('still enqueues a synced provider through the same services', () => {
    insertSource('google-src', GOOGLE_CALENDAR_PROVIDER)
    insertEvent('google-evt', 'google-src')

    sources.enqueueUpdate('google-src')
    events.enqueueCreate('google-evt')

    expect(queued()).toEqual([
      { type: 'calendar_source', itemId: 'google-src', operation: 'update' },
      { type: 'calendar_external_event', itemId: 'google-evt', operation: 'create' }
    ])
  })
})
