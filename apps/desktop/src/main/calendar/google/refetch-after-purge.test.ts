import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import {
  asClientDb,
  createTestDataDb,
  type TestDatabaseResult,
  type TestDb
} from '@tests/utils/test-db'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import type { GoogleCalendarRemoteEvent } from '../types'

const { fakeGoogle } = vi.hoisted(() => ({
  fakeGoogle: {
    listCalendars: vi.fn(),
    listEvents: vi.fn()
  }
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))

vi.mock('./oauth', () => ({
  connectGoogleCalendar: vi.fn(async () => ({
    accountId: 'work@example.com',
    account: {
      remoteId: 'work@example.com',
      email: 'work@example.com',
      title: 'Work',
      timezone: 'UTC'
    },
    primaryCalendar: {
      remoteId: 'work@example.com',
      title: 'Work',
      timezone: 'UTC',
      color: null,
      isPrimary: true
    }
  })),
  disconnectGoogleCalendar: vi.fn(async () => {}),
  hasAnyGoogleCalendarLocalAuth: vi.fn(async () => true),
  hasGoogleCalendarLocalAuth: vi.fn(async () => true),
  listGoogleAccountIds: vi.fn(() => ['work@example.com']),
  resolveDefaultGoogleAccountId: vi.fn(() => 'work@example.com')
}))

vi.mock('./client', () => ({
  createGoogleCalendarClient: vi.fn(() => fakeGoogle)
}))

vi.mock('./google-sync-runner', () => ({
  startGoogleCalendarSyncRunner: vi.fn(async () => {}),
  stopGoogleCalendarSyncRunner: vi.fn()
}))

import { googleCalendarProvider } from './google-provider'
import { syncGoogleCalendarSource } from './sync-service'

const ACCOUNT = 'work@example.com'
const PRIMARY = `google-calendar:${ACCOUNT}`
const TEAM = 'google-calendar:team@group.calendar.google.com'
const ALL_EVENTS = ['planning', 'retro', 'standup']

function remoteEvent(calendarId: string, id: string): GoogleCalendarRemoteEvent {
  return {
    id,
    calendarId,
    title: id,
    description: null,
    location: null,
    startAt: '2026-11-05T09:00:00.000Z',
    endAt: '2026-11-05T09:30:00.000Z',
    isAllDay: false,
    timezone: 'UTC',
    status: 'confirmed',
    etag: null,
    updatedAt: null,
    attendees: null,
    reminders: null,
    visibility: null,
    colorId: null,
    conferenceData: null,
    recurringEventId: null,
    originalStartTime: null,
    raw: {}
  }
}

describe('a Google calendar whose events were purged is pulled in full again', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  beforeEach(async () => {
    dbResult = createTestDataDb()
    db = dbResult.db
    fakeGoogle.listCalendars.mockResolvedValue([
      { id: ACCOUNT, title: 'Work', timezone: 'UTC', color: null, isPrimary: true },
      {
        id: 'team@group.calendar.google.com',
        title: 'Team',
        timezone: 'UTC',
        color: null,
        isPrimary: false
      }
    ])
    // Google's sync token semantics: a token returns only what changed since
    // it was issued, and nothing changed on these calendars.
    fakeGoogle.listEvents.mockImplementation(
      async ({ calendarId, syncCursor }: { calendarId: string; syncCursor: string | null }) =>
        syncCursor
          ? { events: [], nextSyncCursor: 'token-2' }
          : {
              events: ALL_EVENTS.map((id) => remoteEvent(calendarId, id)),
              nextSyncCursor: 'token-1'
            }
    )

    await googleCalendarProvider.connect(asClientDb(db), { provider: 'google' })
    db.update(calendarSources).set({ isSelected: true }).where(eq(calendarSources.id, TEAM)).run()
    for (const id of [PRIMARY, TEAM]) {
      await syncGoogleCalendarSource(asClientDb(db), id)
    }
  })

  afterEach(() => {
    dbResult.close()
  })

  function liveEventTitles(sourceId: string): string[] {
    return db
      .select({ title: calendarExternalEvents.title })
      .from(calendarExternalEvents)
      .where(
        and(
          eq(calendarExternalEvents.sourceId, sourceId),
          isNull(calendarExternalEvents.archivedAt)
        )
      )
      .all()
      .map((row) => row.title)
      .toSorted()
  }

  function source(id: string): typeof calendarSources.$inferSelect {
    const row = db.select().from(calendarSources).where(eq(calendarSources.id, id)).get()
    if (!row) throw new Error(`source missing: ${id}`)
    return row
  }

  function setSelected(id: string, isSelected: boolean): void {
    const before = source(id)
    db.update(calendarSources).set({ isSelected }).where(eq(calendarSources.id, id)).run()
    googleCalendarProvider.onSelectionChanged(asClientDb(db), before, source(id))
  }

  async function disconnect(): Promise<void> {
    expect(liveEventTitles(PRIMARY)).toEqual(ALL_EVENTS)
    await googleCalendarProvider.disconnect(asClientDb(db), {
      provider: 'google',
      accountId: ACCOUNT
    })
    expect(liveEventTitles(PRIMARY)).toEqual([])
    expect(liveEventTitles(TEAM)).toEqual([])
  }

  async function reconnectAndSync(): Promise<void> {
    await googleCalendarProvider.connect(asClientDb(db), { provider: 'google' })
    for (const id of [PRIMARY, TEAM]) {
      await syncGoogleCalendarSource(asClientDb(db), id)
    }
  }

  it('after the account is disconnected and connected again', async () => {
    await disconnect()
    await reconnectAndSync()

    expect(liveEventTitles(PRIMARY)).toEqual(ALL_EVENTS)
    expect(liveEventTitles(TEAM)).toEqual(ALL_EVENTS)
  })

  it('after the calendar is turned off and on again', async () => {
    expect(liveEventTitles(TEAM)).toEqual(ALL_EVENTS)
    setSelected(TEAM, false)
    expect(liveEventTitles(TEAM)).toEqual([])

    setSelected(TEAM, true)

    await vi.waitFor(() => expect(liveEventTitles(TEAM)).toEqual(ALL_EVENTS))
  })

  it('after reconnecting an account an older build disconnected, keeping the cursors', async () => {
    await disconnect()
    db.update(calendarSources)
      .set({ syncCursor: 'token-1' })
      .where(eq(calendarSources.kind, 'calendar'))
      .run()

    await reconnectAndSync()

    expect(liveEventTitles(PRIMARY)).toEqual(ALL_EVENTS)
    expect(liveEventTitles(TEAM)).toEqual(ALL_EVENTS)
  })
})
