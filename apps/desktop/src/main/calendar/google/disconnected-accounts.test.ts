import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  asClientDb,
  createTestDataDb,
  type TestDatabaseResult,
  type TestDb
} from '@tests/utils/test-db'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [])
  }
}))

import { archiveCalendarsOfDisconnectedGoogleAccounts } from './disconnected-accounts'

const NOW = '2026-09-29T10:00:00.000Z'

describe('archiveCalendarsOfDisconnectedGoogleAccounts (#2516, #2555)', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db
  })

  afterEach(() => {
    dbResult.close()
  })

  function seedAccount(accountId: string, archivedAt: string | null): void {
    db.insert(calendarSources)
      .values({
        id: `google-account:${accountId}`,
        provider: 'google',
        kind: 'account',
        accountId,
        remoteId: accountId,
        title: accountId,
        archivedAt,
        createdAt: NOW,
        modifiedAt: NOW
      })
      .run()
  }

  function seedCalendar(id: string, accountId: string | null): void {
    db.insert(calendarSources)
      .values({
        id: `google-calendar:${id}`,
        provider: 'google',
        kind: 'calendar',
        accountId,
        remoteId: id,
        title: id,
        isSelected: true,
        createdAt: NOW,
        modifiedAt: NOW
      })
      .run()
    db.insert(calendarExternalEvents)
      .values({
        id: `external:${id}`,
        sourceId: `google-calendar:${id}`,
        remoteEventId: `event-${id}`,
        title: 'Standup',
        startAt: '2026-09-30T09:00:00.000Z',
        endAt: '2026-09-30T09:30:00.000Z',
        timezone: 'UTC',
        isAllDay: false,
        createdAt: NOW,
        modifiedAt: NOW
      })
      .run()
  }

  function archivedAtOf(id: string): string | null | undefined {
    return db.select().from(calendarSources).where(eq(calendarSources.id, id)).get()?.archivedAt
  }

  it('archives the live calendars of a disconnected account and drops their events', () => {
    // An older version let an in-flight sync write this calendar back live
    // after the account was disconnected.
    seedAccount('gone@example.com', NOW)
    seedCalendar('gone-primary', 'gone@example.com')

    archiveCalendarsOfDisconnectedGoogleAccounts(asClientDb(db))

    expect(archivedAtOf('google-calendar:gone-primary')).toEqual(expect.any(String))
    expect(
      db
        .select()
        .from(calendarExternalEvents)
        .where(eq(calendarExternalEvents.sourceId, 'google-calendar:gone-primary'))
        .all()
    ).toHaveLength(0)
  })

  it('leaves connected accounts and calendars with no known account alone', () => {
    seedAccount('live@example.com', null)
    seedCalendar('live-primary', 'live@example.com')
    seedCalendar('legacy', null)
    seedCalendar('no-account-row', 'unknown@example.com')

    archiveCalendarsOfDisconnectedGoogleAccounts(asClientDb(db))

    expect(archivedAtOf('google-calendar:live-primary')).toBeNull()
    expect(archivedAtOf('google-calendar:legacy')).toBeNull()
    expect(archivedAtOf('google-calendar:no-account-row')).toBeNull()
    expect(db.select().from(calendarExternalEvents).all()).toHaveLength(3)
  })
})
