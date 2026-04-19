import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { CalendarExternalEventSyncPayloadSchema } from '@memry/contracts/sync-payloads'
import { getHandler } from './index'
import type { ApplyContext, DrizzleDb } from './types'

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

    const applyResult = handler?.applyUpsert(
      freshCtx,
      'external-rich',
      parsed,
      { 'device-a': 3 }
    )
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
})
