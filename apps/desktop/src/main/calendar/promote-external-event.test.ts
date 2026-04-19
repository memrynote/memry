import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, type TestDatabaseResult, type TestDb } from '@tests/utils/test-db'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { promoteExternalEvent, ExternalEventNotFoundError } from './promote-external-event'
import type { DataDb } from '../database'

const CAL_SOURCE_ID = 'google-calendar:work-remote'
const EXTERNAL_ID = 'external-evt-1'
const REMOTE_EVENT_ID = 'google-remote-event-42'
const REMOTE_CAL_ID = 'work-remote'

function seedSource(db: TestDb): void {
  db.insert(calendarSources)
    .values({
      id: CAL_SOURCE_ID,
      provider: 'google',
      kind: 'calendar',
      accountId: 'google-account:acct-1',
      remoteId: REMOTE_CAL_ID,
      title: 'Work',
      timezone: 'UTC',
      color: null,
      isPrimary: false,
      isSelected: true,
      isMemryManaged: false,
      syncCursor: null,
      syncStatus: 'ok',
      lastSyncedAt: null,
      metadata: null,
      clock: { 'device-a': 1 },
      createdAt: '2026-05-01T06:00:00.000Z',
      modifiedAt: '2026-05-01T06:00:00.000Z'
    })
    .run()
}

function seedExternalEvent(
  db: TestDb,
  overrides: Partial<typeof calendarExternalEvents.$inferInsert> = {}
): void {
  db.insert(calendarExternalEvents)
    .values({
      id: EXTERNAL_ID,
      sourceId: CAL_SOURCE_ID,
      remoteEventId: REMOTE_EVENT_ID,
      remoteEtag: '"etag-v1"',
      remoteUpdatedAt: '2026-05-01T07:00:00.000Z',
      title: 'External kickoff',
      description: 'Shared invite',
      location: 'Room 4',
      startAt: '2026-05-02T09:00:00.000Z',
      endAt: '2026-05-02T10:00:00.000Z',
      timezone: 'UTC',
      isAllDay: false,
      status: 'confirmed',
      recurrenceRule: null,
      rawPayload: { summary: 'External kickoff' },
      clock: { 'device-a': 2 },
      createdAt: '2026-05-01T07:05:00.000Z',
      modifiedAt: '2026-05-01T07:05:00.000Z',
      ...overrides
    })
    .run()
}

vi.mock('../calendar/change-events', () => ({
  emitCalendarProjectionChanged: vi.fn(),
  emitCalendarChanged: vi.fn()
}))

describe('promoteExternalEvent (M2)', () => {
  let dbResult: TestDatabaseResult
  let db: DataDb

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db as unknown as DataDb
    seedSource(dbResult.db)
  })

  afterEach(() => {
    dbResult.close()
  })

  it('#given an external event #when promoted #then creates a calendar_events row with the external fields and targetCalendarId set to the source calendar', () => {
    seedExternalEvent(dbResult.db)

    const result = promoteExternalEvent(db, { externalEventId: EXTERNAL_ID })

    expect(result.success).toBe(true)
    expect(result.eventId).toBeTruthy()

    const row = dbResult.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, result.eventId!))
      .get()
    expect(row).toMatchObject({
      title: 'External kickoff',
      description: 'Shared invite',
      location: 'Room 4',
      startAt: '2026-05-02T09:00:00.000Z',
      endAt: '2026-05-02T10:00:00.000Z',
      timezone: 'UTC',
      isAllDay: false,
      targetCalendarId: REMOTE_CAL_ID,
      archivedAt: null
    })
  })

  it('#given an external event #when promoted #then creates a binding pointing at the same remote event (provider_managed ownership)', () => {
    seedExternalEvent(dbResult.db)

    const result = promoteExternalEvent(db, { externalEventId: EXTERNAL_ID })

    const bindings = dbResult.db
      .select()
      .from(calendarBindings)
      .where(eq(calendarBindings.sourceId, result.eventId!))
      .all()
    expect(bindings).toHaveLength(1)
    expect(bindings[0]).toMatchObject({
      sourceType: 'event',
      provider: 'google',
      remoteCalendarId: REMOTE_CAL_ID,
      remoteEventId: REMOTE_EVENT_ID,
      ownershipMode: 'provider_managed',
      writebackMode: 'time_and_text'
    })
  })

  it('#given an external event #when promoted #then archives the external event mirror', () => {
    seedExternalEvent(dbResult.db)

    promoteExternalEvent(db, { externalEventId: EXTERNAL_ID })

    const row = dbResult.db
      .select()
      .from(calendarExternalEvents)
      .where(eq(calendarExternalEvents.id, EXTERNAL_ID))
      .get()
    expect(row?.archivedAt).not.toBeNull()
  })

  it('#given promote already ran #when called again #then returns the same eventId idempotently and does not duplicate rows', () => {
    seedExternalEvent(dbResult.db)

    const first = promoteExternalEvent(db, { externalEventId: EXTERNAL_ID })
    const second = promoteExternalEvent(db, { externalEventId: EXTERNAL_ID })

    expect(second.success).toBe(true)
    expect(second.eventId).toBe(first.eventId)

    const events = dbResult.db.select().from(calendarEvents).all()
    expect(events).toHaveLength(1)

    const bindings = dbResult.db.select().from(calendarBindings).all()
    expect(bindings).toHaveLength(1)
  })

  it('#given a missing external event id #when promoted #then throws ExternalEventNotFoundError', () => {
    expect(() => promoteExternalEvent(db, { externalEventId: 'does-not-exist' })).toThrow(
      ExternalEventNotFoundError
    )
  })

  it('#given an external event carrying rich Google fields #when promoted #then carries attendees, reminders, visibility, colorId, conferenceData across to the local row (M5)', () => {
    const attendees = [
      { email: 'ceo@example.com', responseStatus: 'accepted', displayName: 'CEO' }
    ]
    const reminders = {
      useDefault: false,
      overrides: [{ method: 'popup' as const, minutes: 5 }]
    }
    const conferenceData = {
      conferenceId: 'meet-abc',
      entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/meet-abc' }]
    }

    seedExternalEvent(dbResult.db, {
      attendees,
      reminders,
      visibility: 'private',
      colorId: '9',
      conferenceData
    })

    const result = promoteExternalEvent(db, { externalEventId: EXTERNAL_ID })

    const row = dbResult.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, result.eventId!))
      .get()

    expect(row?.attendees).toEqual(attendees)
    expect(row?.reminders).toEqual(reminders)
    expect(row?.visibility).toBe('private')
    expect(row?.colorId).toBe('9')
    expect(row?.conferenceData).toEqual(conferenceData)
  })

  it('#given the mirror source row vanishes before promote runs #when promoted #then throws ExternalEventNotFoundError because the FK CASCADE already removed the mirror', () => {
    seedExternalEvent(dbResult.db)
    dbResult.db.delete(calendarSources).where(eq(calendarSources.id, CAL_SOURCE_ID)).run()

    expect(() => promoteExternalEvent(db, { externalEventId: EXTERNAL_ID })).toThrow(
      ExternalEventNotFoundError
    )
  })
})
