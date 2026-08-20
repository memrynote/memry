import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, type TestDatabaseResult, type TestDb } from '@tests/utils/test-db'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [])
  }
}))

vi.mock('./oauth', () => ({
  hasGoogleCalendarConnection: vi.fn(async () => true),
  listGoogleAccountIds: vi.fn(() => ['work@example.com']),
  resolveDefaultGoogleAccountId: vi.fn(() => 'work@example.com')
}))

vi.mock('../../../sync/auth-state', () => ({
  isMemryUserSignedIn: vi.fn(async () => true)
}))

import { discoverGoogleCalendarSources } from './sync-service'
import { upsertCalendarSource } from '../../repositories/calendar-sources-repository'

const REMOTE_CALENDARS = [
  {
    id: 'work@example.com',
    title: 'Work',
    timezone: 'Europe/Istanbul',
    color: '#0ea5e9',
    isPrimary: true
  },
  {
    id: 'team-standup@group.calendar.google.com',
    title: 'Team standup',
    timezone: 'Europe/Istanbul',
    color: '#f97316',
    isPrimary: false
  },
  {
    id: 'holidays@group.v.calendar.google.com',
    title: 'Holidays',
    timezone: 'UTC',
    color: '#22c55e',
    isPrimary: false
  }
]

function stubClient(calendars = REMOTE_CALENDARS) {
  return { listCalendars: vi.fn(async () => calendars) }
}

describe('discoverGoogleCalendarSources', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db
  })

  it('records every calendar on the account, pre-selecting only the primary', async () => {
    await discoverGoogleCalendarSources(db, stubClient(), 'work@example.com')

    const rows = db
      .select()
      .from(calendarSources)
      .where(eq(calendarSources.kind, 'calendar'))
      .all()
      .sort((left, right) => left.remoteId.localeCompare(right.remoteId))

    expect(rows.map((row) => row.remoteId)).toEqual([
      'holidays@group.v.calendar.google.com',
      'team-standup@group.calendar.google.com',
      'work@example.com'
    ])
    expect(rows.every((row) => row.accountId === 'work@example.com')).toBe(true)
    // Only the primary is on by default — the others are the user's to opt into.
    expect(rows.filter((row) => row.isSelected).map((row) => row.remoteId)).toEqual([
      'work@example.com'
    ])
  })

  it('leaves an existing selection alone when re-run', async () => {
    await discoverGoogleCalendarSources(db, stubClient(), 'work@example.com')

    const standupId = 'google-calendar:team-standup@group.calendar.google.com'
    const primaryId = 'google-calendar:work@example.com'
    const standup = db.select().from(calendarSources).where(eq(calendarSources.id, standupId)).get()
    const primary = db.select().from(calendarSources).where(eq(calendarSources.id, primaryId)).get()
    // The user turns the standup calendar on and the primary off.
    upsertCalendarSource(db, { ...standup!, isSelected: true })
    upsertCalendarSource(db, { ...primary!, isSelected: false })

    await discoverGoogleCalendarSources(db, stubClient(), 'work@example.com')

    const after = db
      .select()
      .from(calendarSources)
      .where(eq(calendarSources.kind, 'calendar'))
      .all()
    const selected = after.filter((row) => row.isSelected).map((row) => row.remoteId)

    expect(selected).toEqual(['team-standup@group.calendar.google.com'])
  })

  it('refreshes a renamed calendar without disturbing its sync cursor', async () => {
    await discoverGoogleCalendarSources(db, stubClient(), 'work@example.com')

    const standupId = 'google-calendar:team-standup@group.calendar.google.com'
    const seeded = db.select().from(calendarSources).where(eq(calendarSources.id, standupId)).get()
    upsertCalendarSource(db, {
      ...seeded!,
      isSelected: true,
      syncCursor: 'cursor-abc',
      syncStatus: 'ok',
      lastSyncedAt: '2026-08-08T00:00:00.000Z'
    })

    await discoverGoogleCalendarSources(
      db,
      stubClient([
        REMOTE_CALENDARS[0],
        { ...REMOTE_CALENDARS[1], title: 'Team standup (renamed)', color: '#a855f7' },
        REMOTE_CALENDARS[2]
      ]),
      'work@example.com'
    )

    const row = db.select().from(calendarSources).where(eq(calendarSources.id, standupId)).get()

    expect(row?.title).toBe('Team standup (renamed)')
    expect(row?.color).toBe('#a855f7')
    // Dropping the cursor would re-pull the whole calendar from scratch.
    expect(row?.syncCursor).toBe('cursor-abc')
    expect(row?.lastSyncedAt).toBe('2026-08-08T00:00:00.000Z')
  })

  it('revives a calendar archived by an earlier disconnect', async () => {
    await discoverGoogleCalendarSources(db, stubClient(), 'work@example.com')

    // Disconnect archives every source of the account; listCalendarSources
    // filters archived rows out, so leaving the flag set would make a
    // reconnected account come back with an empty calendar picker.
    const rows = db.select().from(calendarSources).where(eq(calendarSources.kind, 'calendar')).all()
    for (const row of rows) {
      upsertCalendarSource(db, { ...row, archivedAt: '2026-08-08T00:00:00.000Z' })
    }

    await discoverGoogleCalendarSources(db, stubClient(), 'work@example.com')

    const after = db
      .select()
      .from(calendarSources)
      .where(eq(calendarSources.kind, 'calendar'))
      .all()

    expect(after.every((row) => row.archivedAt === null)).toBe(true)
  })

  it('keeps two accounts separate rather than reassigning shared calendars', async () => {
    await discoverGoogleCalendarSources(db, stubClient(), 'work@example.com')
    await discoverGoogleCalendarSources(
      db,
      stubClient([
        {
          id: 'personal@example.com',
          title: 'Personal',
          timezone: 'Europe/Istanbul',
          color: '#ec4899',
          isPrimary: true
        }
      ]),
      'personal@example.com'
    )

    const rows = db.select().from(calendarSources).where(eq(calendarSources.kind, 'calendar')).all()

    expect(rows).toHaveLength(4)
    expect(rows.filter((row) => row.accountId === 'work@example.com')).toHaveLength(3)
    expect(rows.filter((row) => row.accountId === 'personal@example.com')).toHaveLength(1)
  })
})
