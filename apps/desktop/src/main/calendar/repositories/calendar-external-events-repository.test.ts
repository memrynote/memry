import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import {
  upsertCalendarExternalEvent,
  getCalendarExternalEventById
} from './calendar-external-events-repository'
import type { DataDb } from '../../database/types'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'

const NOW = '2026-04-18T12:00:00.000Z'

function seedSource(db: DataDb, sourceId: string): void {
  db.insert(calendarSources)
    .values({
      id: sourceId,
      provider: 'google',
      kind: 'calendar',
      accountId: null,
      remoteId: 'remote-cal-1',
      title: 'Work',
      timezone: 'UTC',
      isSelected: true,
      isMemryManaged: false,
      syncCursor: null,
      syncStatus: 'ok',
      clock: { 'device-a': 1 },
      createdAt: NOW,
      modifiedAt: NOW
    })
    .run()
}

describe('calendarExternalEvents rich fields (M5)', () => {
  let dbResult: TestDatabaseResult
  let dataDb: DataDb

  beforeEach(() => {
    dbResult = createTestDataDb()
    dataDb = dbResult.db as unknown as DataDb
    seedSource(dataDb, 'source-1')
  })

  afterEach(() => {
    dbResult.close()
  })

  it('round-trips attendees, reminders, visibility, colorId, conferenceData through the repository', () => {
    const attendees = [
      { email: 'alice@example.com', responseStatus: 'accepted' },
      { email: 'bob@example.com', responseStatus: 'declined' }
    ]
    const reminders = {
      useDefault: true,
      overrides: [] as Array<{ method: 'email' | 'popup'; minutes: number }>
    }
    const conferenceData = {
      entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/xyz' }]
    }

    upsertCalendarExternalEvent(dataDb, {
      id: 'external-rich-1',
      sourceId: 'source-1',
      remoteEventId: 'google-evt-1',
      remoteEtag: 'etag-1',
      remoteUpdatedAt: NOW,
      title: 'Imported rich event',
      description: null,
      location: null,
      startAt: '2026-04-20T09:00:00.000Z',
      endAt: '2026-04-20T10:00:00.000Z',
      timezone: 'UTC',
      isAllDay: false,
      status: 'confirmed',
      attendees,
      reminders,
      visibility: 'confidential',
      colorId: '5',
      conferenceData,
      clock: { 'device-a': 1 },
      createdAt: NOW,
      modifiedAt: NOW
    })

    const stored = getCalendarExternalEventById(dataDb, 'external-rich-1')

    expect(stored?.attendees).toEqual(attendees)
    expect(stored?.reminders).toEqual(reminders)
    expect(stored?.visibility).toBe('confidential')
    expect(stored?.colorId).toBe('5')
    expect(stored?.conferenceData).toEqual(conferenceData)
  })

  it('defaults all rich fields to null when omitted', () => {
    upsertCalendarExternalEvent(dataDb, {
      id: 'external-rich-null',
      sourceId: 'source-1',
      remoteEventId: 'google-evt-null',
      remoteEtag: null,
      remoteUpdatedAt: null,
      title: 'Plain imported event',
      description: null,
      location: null,
      startAt: '2026-04-20T09:00:00.000Z',
      endAt: null,
      timezone: 'UTC',
      isAllDay: false,
      status: 'confirmed',
      clock: { 'device-a': 1 },
      createdAt: NOW,
      modifiedAt: NOW
    })

    const stored = getCalendarExternalEventById(dataDb, 'external-rich-null')

    expect(stored?.attendees).toBeNull()
    expect(stored?.reminders).toBeNull()
    expect(stored?.visibility).toBeNull()
    expect(stored?.colorId).toBeNull()
    expect(stored?.conferenceData).toBeNull()
  })
})
