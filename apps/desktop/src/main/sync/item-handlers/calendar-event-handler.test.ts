import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import type { VectorClock } from '@memry/contracts/sync-api'
import { enqueueLocalSyncCreate, enqueueLocalSyncDelete, enqueueLocalSyncUpdate } from '../local-mutations'
import { SyncQueueManager } from '../queue'
import { getHandler, getRemoteSyncAdapter } from './index'
import type { ApplyContext, DrizzleDb } from './types'

function makeCtx(testDb: TestDatabaseResult): ApplyContext {
  return {
    db: testDb.db as unknown as DrizzleDb,
    emit: vi.fn()
  }
}

describe('calendar sync handlers', () => {
  let testDb: TestDatabaseResult
  let queue: SyncQueueManager
  let ctx: ApplyContext

  beforeEach(() => {
    testDb = createTestDataDb()
    queue = new SyncQueueManager(testDb.db as unknown as DrizzleDb)
    ctx = makeCtx(testDb)
  })

  afterEach(async () => {
    const eventSync = await import('../calendar-event-sync').catch(() => null)
    eventSync?.resetCalendarEventSyncService()

    const sourceSync = await import('../calendar-source-sync').catch(() => null)
    sourceSync?.resetCalendarSourceSyncService()

    const bindingSync = await import('../calendar-binding-sync').catch(() => null)
    bindingSync?.resetCalendarBindingSyncService()

    const externalSync = await import('../calendar-external-event-sync').catch(() => null)
    externalSync?.resetCalendarExternalEventSyncService()

    testDb.close()
  })

  it('enqueues create, update, and delete mutations for calendar events and round-trips payloads', async () => {
    const { initCalendarEventSyncService } = await import('../calendar-event-sync')

    testDb.db
      .insert(calendarEvents)
      .values({
        id: 'event-1',
        title: 'Planning',
        description: 'Quarterly planning',
        location: 'Studio',
        startAt: '2026-04-12T09:00:00.000Z',
        endAt: '2026-04-12T10:00:00.000Z',
        timezone: 'UTC',
        isAllDay: false,
        clock: { 'device-a': 1 },
        createdAt: '2026-04-12T08:00:00.000Z',
        modifiedAt: '2026-04-12T08:00:00.000Z'
      })
      .run()

    initCalendarEventSyncService({
      queue,
      db: testDb.db as unknown as DrizzleDb,
      getDeviceId: () => 'device-a'
    })

    enqueueLocalSyncCreate('calendar_event', 'event-1')

    let queued = queue.peek(1)
    expect(queued).toHaveLength(1)
    expect(queued[0].type).toBe('calendar_event')
    expect(queued[0].operation).toBe('create')
    expect(JSON.parse(queued[0].payload)).toMatchObject({
      title: 'Planning',
      clock: { 'device-a': 2 }
    })

    queue.clear()

    enqueueLocalSyncUpdate('calendar_event', 'event-1')

    queued = queue.peek(1)
    expect(queued).toHaveLength(1)
    expect(queued[0].operation).toBe('update')

    const eventHandler = getHandler('calendar_event')
    const eventAdapter = getRemoteSyncAdapter('calendar_event')

    expect(eventHandler).toBeDefined()
    expect(eventAdapter).toBeDefined()

    const pushPayload = eventHandler?.buildPushPayload?.(
      testDb.db as unknown as DrizzleDb,
      'event-1',
      'device-a',
      'update'
    )
    expect(pushPayload).toBeTruthy()
    expect(JSON.parse(pushPayload ?? '{}')).toMatchObject({
      title: 'Planning',
      description: 'Quarterly planning'
    })

    const upsertResult = eventHandler?.applyUpsert(
      ctx,
      'event-remote',
      {
        title: 'Imported Planning',
        description: 'Created elsewhere',
        location: 'Remote room',
        startAt: '2026-04-13T11:00:00.000Z',
        endAt: '2026-04-13T12:00:00.000Z',
        timezone: 'Europe/Istanbul',
        isAllDay: false,
        createdAt: '2026-04-12T09:00:00.000Z',
        modifiedAt: '2026-04-12T09:00:00.000Z'
      },
      { 'device-b': 1 }
    )

    expect(upsertResult).toBe('applied')
    expect(
      testDb.db.select().from(calendarEvents).where(eq(calendarEvents.id, 'event-remote')).get()
    ).toMatchObject({
      title: 'Imported Planning',
      timezone: 'Europe/Istanbul'
    })

    queue.clear()
    enqueueLocalSyncDelete(
      'calendar_event',
      'event-1',
      JSON.stringify({
        id: 'event-1',
        title: 'Planning',
        clock: { 'device-a': 2 }
      })
    )

    queued = queue.peek(1)
    expect(queued).toHaveLength(1)
    expect(queued[0].operation).toBe('delete')

    const deleteResult = eventHandler?.applyDelete(ctx, 'event-remote', {
      'device-b': 1,
      'device-c': 1
    })
    expect(deleteResult).toBe('applied')
    expect(
      testDb.db.select().from(calendarEvents).where(eq(calendarEvents.id, 'event-remote')).get()
    ).toBeUndefined()
  })

  it('preserves synced provider metadata, bindings, and imported cache rows across handler upserts', async () => {
    const { initCalendarSourceSyncService } = await import('../calendar-source-sync')
    const { initCalendarBindingSyncService } = await import('../calendar-binding-sync')
    const { initCalendarExternalEventSyncService } = await import('../calendar-external-event-sync')

    initCalendarSourceSyncService({
      queue,
      db: testDb.db as unknown as DrizzleDb,
      getDeviceId: () => 'device-a'
    })
    initCalendarBindingSyncService({
      queue,
      db: testDb.db as unknown as DrizzleDb,
      getDeviceId: () => 'device-a'
    })
    initCalendarExternalEventSyncService({
      queue,
      db: testDb.db as unknown as DrizzleDb,
      getDeviceId: () => 'device-a'
    })

    const sourceHandler = getHandler('calendar_source')
    const bindingHandler = getHandler('calendar_binding')
    const externalHandler = getHandler('calendar_external_event')

    expect(sourceHandler).toBeDefined()
    expect(bindingHandler).toBeDefined()
    expect(externalHandler).toBeDefined()

    const sourceClock: VectorClock = { 'device-b': 1 }
    const sourceResult = sourceHandler?.applyUpsert(
      ctx,
      'source-1',
      {
        provider: 'google',
        kind: 'calendar',
        accountId: 'account-1',
        remoteId: 'google-calendar-1',
        title: 'Work',
        timezone: 'Europe/Istanbul',
        isSelected: true,
        isMemryManaged: false,
        syncStatus: 'ok',
        syncCursor: 'cursor-1',
        createdAt: '2026-04-12T08:00:00.000Z',
        modifiedAt: '2026-04-12T08:00:00.000Z'
      },
      sourceClock
    )

    expect(sourceResult).toBe('applied')
    expect(
      testDb.db.select().from(calendarSources).where(eq(calendarSources.id, 'source-1')).get()
    ).toMatchObject({
      remoteId: 'google-calendar-1',
      syncCursor: 'cursor-1',
      isSelected: true
    })

    const bindingResult = bindingHandler?.applyUpsert(
      ctx,
      'binding-1',
      {
        sourceType: 'task',
        sourceId: 'task-1',
        provider: 'google',
        remoteCalendarId: 'memry-calendar',
        remoteEventId: 'remote-task-1',
        ownershipMode: 'memry_managed',
        writebackMode: 'broad',
        remoteVersion: 'etag-1',
        lastLocalSnapshot: { title: 'Task One' },
        createdAt: '2026-04-12T08:10:00.000Z',
        modifiedAt: '2026-04-12T08:10:00.000Z'
      },
      { 'device-b': 2 }
    )

    expect(bindingResult).toBe('applied')
    expect(
      testDb.db.select().from(calendarBindings).where(eq(calendarBindings.id, 'binding-1')).get()
    ).toMatchObject({
      sourceType: 'task',
      remoteEventId: 'remote-task-1'
    })

    const externalResult = externalHandler?.applyUpsert(
      ctx,
      'external-1',
      {
        sourceId: 'source-1',
        remoteEventId: 'google-event-1',
        remoteEtag: 'etag-1',
        remoteUpdatedAt: '2026-04-12T08:15:00.000Z',
        title: 'Imported Meeting',
        description: 'Imported from Google',
        location: 'Office',
        startAt: '2026-04-12T10:00:00.000Z',
        endAt: '2026-04-12T11:00:00.000Z',
        timezone: 'Europe/Istanbul',
        isAllDay: false,
        status: 'confirmed',
        rawPayload: { summary: 'Imported Meeting' },
        createdAt: '2026-04-12T08:15:00.000Z',
        modifiedAt: '2026-04-12T08:15:00.000Z'
      },
      { 'device-b': 3 }
    )

    expect(externalResult).toBe('applied')
    expect(
      testDb.db
        .select()
        .from(calendarExternalEvents)
        .where(eq(calendarExternalEvents.id, 'external-1'))
        .get()
    ).toMatchObject({
      sourceId: 'source-1',
      remoteEventId: 'google-event-1',
      remoteEtag: 'etag-1'
    })

    queue.clear()
    enqueueLocalSyncCreate('calendar_source', 'source-1')
    enqueueLocalSyncUpdate('calendar_binding', 'binding-1')
    enqueueLocalSyncDelete(
      'calendar_external_event',
      'external-1',
      JSON.stringify({
        id: 'external-1',
        sourceId: 'source-1',
        remoteEventId: 'google-event-1',
        clock: { 'device-a': 1 }
      })
    )

    const queuedTypes = queue
      .peek(10)
      .map((item) => `${item.type}:${item.operation}`)
      .sort()

    expect(queuedTypes).toEqual([
      'calendar_binding:update',
      'calendar_external_event:delete',
      'calendar_source:create'
    ])
  })
})
