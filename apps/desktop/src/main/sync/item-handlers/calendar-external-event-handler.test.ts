import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { asSyncDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { CalendarExternalEventSyncPayloadSchema } from '@memry/contracts/sync-payloads'
import { SyncQueueManager } from '../queue'
import { getHandler } from './index'
import { MissingSyncParentError } from './types'
import type { ApplyContext, DrizzleDb } from './types'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

function makeCtx(testDb: TestDatabaseResult): ApplyContext {
  return {
    db: testDb.db as unknown as DrizzleDb,
    emit: vi.fn()
  }
}

describe('calendar external event handler — rich fields (M5 Codex P2c)', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext

  beforeEach(() => {
    testDb = createTestDataDb()
    ctx = makeCtx(testDb)
    testDb.db
      .insert(calendarSources)
      .values({
        id: 'source-rich',
        provider: 'google',
        kind: 'calendar',
        accountId: null,
        remoteId: 'remote-cal',
        title: 'Work',
        timezone: 'UTC',
        isSelected: true,
        isMemryManaged: false,
        syncCursor: null,
        syncStatus: 'ok',
        clock: { 'device-a': 1 },
        createdAt: '2026-04-18T12:00:00.000Z',
        modifiedAt: '2026-04-18T12:00:00.000Z'
      })
      .run()
  })

  afterEach(() => {
    testDb.close()
  })

  it('round-trips attendees/reminders/visibility/colorId/conferenceData through buildPushPayload → applyUpsert', () => {
    const attendees = [
      { email: 'alice@example.com', responseStatus: 'accepted', displayName: 'Alice' }
    ]
    const reminders = {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: 10 }]
    }
    const conferenceData = {
      conferenceId: 'meet-abc',
      entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/meet-abc' }]
    }

    testDb.db
      .insert(calendarExternalEvents)
      .values({
        id: 'external-rich',
        sourceId: 'source-rich',
        remoteEventId: 'google-evt-1',
        remoteEtag: 'etag-1',
        remoteUpdatedAt: '2026-04-18T12:00:00.000Z',
        title: 'Rich imported event',
        description: null,
        location: null,
        startAt: '2026-04-20T09:00:00.000Z',
        endAt: '2026-04-20T10:00:00.000Z',
        timezone: 'UTC',
        isAllDay: false,
        status: 'confirmed',
        attendees,
        reminders,
        visibility: 'private',
        colorId: '9',
        conferenceData,
        clock: { 'device-a': 3 },
        createdAt: '2026-04-18T12:00:00.000Z',
        modifiedAt: '2026-04-18T12:00:00.000Z'
      })
      .run()

    const handler = getHandler('calendar_external_event')
    expect(handler).toBeDefined()

    // #when device A serializes the row for push
    const pushed = handler?.buildPushPayload?.(
      testDb.db as unknown as DrizzleDb,
      'external-rich',
      'device-a',
      'update'
    )
    expect(pushed).toBeTruthy()

    // #then the payload carries the rich fields end-to-end
    const parsed = JSON.parse(pushed ?? '{}')
    expect(parsed.attendees).toEqual(attendees)
    expect(parsed.reminders).toEqual(reminders)
    expect(parsed.visibility).toBe('private')
    expect(parsed.colorId).toBe('9')
    expect(parsed.conferenceData).toEqual(conferenceData)

    // #and the schema accepts it (no parse failure)
    const parsedBySchema = CalendarExternalEventSyncPayloadSchema.parse(parsed)
    expect(parsedBySchema.attendees).toEqual(attendees)

    // #and device B applying the payload lands the rich fields locally
    const freshDb = createTestDataDb()
    freshDb.db
      .insert(calendarSources)
      .values({
        id: 'source-rich',
        provider: 'google',
        kind: 'calendar',
        accountId: null,
        remoteId: 'remote-cal',
        title: 'Work',
        timezone: 'UTC',
        isSelected: true,
        isMemryManaged: false,
        syncCursor: null,
        syncStatus: 'ok',
        clock: { 'device-a': 1 },
        createdAt: '2026-04-18T12:00:00.000Z',
        modifiedAt: '2026-04-18T12:00:00.000Z'
      })
      .run()
    const freshCtx = makeCtx(freshDb)

    const applyResult = handler?.applyUpsert(freshCtx, 'external-rich', parsed, { 'device-a': 3 })
    expect(applyResult).toBe('applied')

    const row = freshDb.db
      .select()
      .from(calendarExternalEvents)
      .where(eq(calendarExternalEvents.id, 'external-rich'))
      .get()
    expect(row?.attendees).toEqual(attendees)
    expect(row?.reminders).toEqual(reminders)
    expect(row?.visibility).toBe('private')
    expect(row?.colorId).toBe('9')
    expect(row?.conferenceData).toEqual(conferenceData)

    freshDb.close()
  })

  it('applies defaults, preserves omitted rich fields, and clears explicit nullable fields', () => {
    const handler = getHandler('calendar_external_event')
    expect(handler?.applyUpsert(ctx, 'external-defaults', { sourceId: 'source-rich' }, {})).toBe(
      'applied'
    )

    expect(
      testDb.db
        .select()
        .from(calendarExternalEvents)
        .where(eq(calendarExternalEvents.id, 'external-defaults'))
        .get()
    ).toMatchObject({
      sourceId: 'source-rich',
      remoteEventId: 'external-defaults',
      title: 'Untitled imported event',
      isAllDay: false,
      status: 'confirmed'
    })

    const attendees = [{ email: 'existing@example.com', optional: true }]
    const conferenceData = { conferenceId: 'existing-meet', entryPoints: [] }
    testDb.db
      .insert(calendarExternalEvents)
      .values({
        id: 'external-update',
        sourceId: 'source-rich',
        remoteEventId: 'google-update',
        title: 'Existing',
        startAt: '2026-04-20T09:00:00.000Z',
        isAllDay: false,
        status: 'confirmed',
        attendees,
        visibility: 'private',
        colorId: '9',
        conferenceData,
        rawPayload: { old: true },
        clock: { 'device-a': 1 }
      })
      .run()

    expect(
      handler?.applyUpsert(
        ctx,
        'external-update',
        {
          sourceId: 'source-rich',
          title: 'Updated',
          location: 'Office',
          rawPayload: { newer: true }
        },
        { 'device-a': 2 }
      )
    ).toBe('applied')

    expect(
      testDb.db
        .select()
        .from(calendarExternalEvents)
        .where(eq(calendarExternalEvents.id, 'external-update'))
        .get()
    ).toMatchObject({
      title: 'Updated',
      location: 'Office',
      attendees,
      visibility: 'private',
      colorId: '9',
      conferenceData,
      rawPayload: { newer: true },
      clock: { 'device-a': 2 }
    })

    expect(
      handler?.applyUpsert(
        ctx,
        'external-update',
        {
          sourceId: 'source-rich',
          attendees: null,
          reminders: null,
          visibility: null,
          colorId: null,
          conferenceData: null
        },
        { 'device-a': 3 }
      )
    ).toBe('applied')

    expect(
      testDb.db
        .select()
        .from(calendarExternalEvents)
        .where(eq(calendarExternalEvents.id, 'external-update'))
        .get()
    ).toMatchObject({
      attendees: null,
      reminders: null,
      visibility: null,
      colorId: null,
      conferenceData: null
    })
  })

  it('reports a create whose calendar_source has not landed as a typed missing parent', () => {
    const handler = getHandler('calendar_external_event')

    let thrown: unknown
    try {
      handler?.applyUpsert(
        ctx,
        'external-orphan',
        {
          sourceId: 'source-not-pulled-yet',
          title: 'Imported',
          startAt: '2026-04-20T09:00:00.000Z'
        },
        { 'device-b': 1 }
      )
    } catch (err) {
      thrown = err
    }

    // Naming the parent is what routes the item into orphan repair instead of
    // "skipped until next remote update" — an unchanged Google event has no
    // next remote update, so a bare FK error loses it permanently.
    expect(thrown).toBeInstanceOf(MissingSyncParentError)
    expect((thrown as MissingSyncParentError).parentType).toBe('calendar_source')
    expect((thrown as MissingSyncParentError).parentId).toBe('source-not-pulled-yet')

    // The failed apply is fully rolled back — deferring must never half-write.
    expect(
      testDb.db
        .select()
        .from(calendarExternalEvents)
        .where(eq(calendarExternalEvents.id, 'external-orphan'))
        .get()
    ).toBeUndefined()
  })

  it('reports a create with no sourceId at all rather than inventing an id that can only FK-fail', () => {
    const handler = getHandler('calendar_external_event')

    expect(() =>
      handler?.applyUpsert(ctx, 'external-sourceless', { title: 'Imported' }, {})
    ).toThrow(MissingSyncParentError)
    expect(
      testDb.db
        .select()
        .from(calendarExternalEvents)
        .where(eq(calendarExternalEvents.id, 'external-sourceless'))
        .get()
    ).toBeUndefined()
  })

  it('reports an update that moves the event onto a source that has not landed', () => {
    const handler = getHandler('calendar_external_event')
    testDb.db
      .insert(calendarExternalEvents)
      .values({
        id: 'external-moved',
        sourceId: 'source-rich',
        remoteEventId: 'google-moved',
        title: 'Existing',
        startAt: '2026-04-20T09:00:00.000Z',
        clock: { 'device-a': 1 }
      })
      .run()

    expect(() =>
      handler?.applyUpsert(
        ctx,
        'external-moved',
        { sourceId: 'source-added-later' },
        {
          'device-a': 2
        }
      )
    ).toThrow(MissingSyncParentError)

    // Rolled back: the row keeps the parent it had.
    expect(
      testDb.db
        .select()
        .from(calendarExternalEvents)
        .where(eq(calendarExternalEvents.id, 'external-moved'))
        .get()
    ).toMatchObject({ sourceId: 'source-rich', title: 'Existing' })
  })

  it('handles stale/concurrent clocks, delete guards, fetch, null payload, and seed queueing', () => {
    const handler = getHandler('calendar_external_event')
    testDb.db
      .insert(calendarExternalEvents)
      .values([
        {
          id: 'external-synced',
          sourceId: 'source-rich',
          remoteEventId: 'google-synced',
          title: 'Synced',
          startAt: '2026-04-20T09:00:00.000Z',
          isAllDay: false,
          status: 'confirmed',
          clock: { 'device-a': 2 }
        },
        {
          id: 'external-local',
          sourceId: 'source-rich',
          remoteEventId: 'google-local',
          title: 'Local',
          startAt: '2026-04-21T09:00:00.000Z',
          isAllDay: false,
          status: 'confirmed'
        }
      ])
      .run()

    expect(
      handler?.applyUpsert(
        ctx,
        'external-synced',
        { sourceId: 'source-rich', title: 'Stale' },
        { 'device-a': 1 }
      )
    ).toBe('skipped')
    expect(
      handler?.applyUpsert(
        ctx,
        'external-synced',
        { sourceId: 'source-rich', title: 'Concurrent' },
        { 'device-b': 1 }
      )
    ).toBe('conflict')
    expect(handler?.fetchLocal(testDb.db as unknown as DrizzleDb, 'external-synced')).toMatchObject(
      {
        title: 'Concurrent',
        clock: { 'device-a': 2, 'device-b': 1 }
      }
    )
    expect(handler?.fetchLocal(testDb.db as unknown as DrizzleDb, 'missing')).toBeUndefined()
    expect(
      handler?.buildPushPayload?.(testDb.db as unknown as DrizzleDb, 'missing', 'd', 'u')
    ).toBeNull()

    expect(handler?.applyDelete(ctx, 'missing')).toBe('skipped')
    expect(handler?.applyDelete(ctx, 'external-synced', { 'device-c': 1 })).toBe('skipped')
    expect(
      handler?.applyDelete(ctx, 'external-synced', {
        'device-a': 2,
        'device-b': 1,
        'device-c': 1
      })
    ).toBe('applied')

    const queue = new SyncQueueManager(asSyncDb(testDb.db))
    expect(handler?.seedUnclocked(testDb.db as unknown as DrizzleDb, 'device-a', queue)).toBe(1)
    const [queued] = queue.dequeue(1)
    expect(queued).toMatchObject({
      type: 'calendar_external_event',
      itemId: 'external-local',
      operation: 'create'
    })
    expect(JSON.parse(queued.payload)).toMatchObject({
      id: 'external-local',
      clock: { 'device-a': 1 }
    })
  })
})
