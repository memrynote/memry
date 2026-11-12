/**
 * #4018: Google refuses an incremental events.list on a public holiday
 * calendar. It hands out a nextSyncToken with the full listing, then answers
 * the first request that carries it with 410. The fake below honours that.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import type { DataDb } from '../../database'
import type { GoogleCalendarClient, GoogleCalendarRemoteEvent } from '../types'

const { loggerMock, enqueueUpdate, enqueueCreate } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  enqueueUpdate: vi.fn(),
  enqueueCreate: vi.fn()
}))

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: vi.fn(() => []) } }))

vi.mock('../../lib/logger', () => ({ createLogger: () => loggerMock }))

vi.mock('./oauth', () => ({
  hasGoogleCalendarConnection: vi.fn(async () => true),
  listGoogleAccountIds: vi.fn(() => ['me@example.com']),
  resolveDefaultGoogleAccountId: vi.fn(() => 'me@example.com')
}))

vi.mock('../../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: enqueueCreate,
  enqueueLocalSyncUpdate: enqueueUpdate,
  enqueueLocalSyncDelete: vi.fn()
}))

import { syncGoogleCalendarSource } from './sync-service'

const HOLIDAY = 'google-calendar:en.usa#holiday@group.v.calendar.google.com'
const TEAM = 'google-calendar:team@group.calendar.google.com'
const DAY_MS = 24 * 60 * 60 * 1000

type ListEventsInput = Parameters<GoogleCalendarClient['listEvents']>[0]
type ListEventsResult = Awaited<ReturnType<GoogleCalendarClient['listEvents']>>

function remoteEvent(
  calendarId: string,
  id: string,
  overrides: Partial<GoogleCalendarRemoteEvent> = {}
): GoogleCalendarRemoteEvent {
  return {
    id,
    calendarId,
    title: id,
    description: null,
    location: null,
    startAt: '2026-11-11T00:00:00.000Z',
    endAt: '2026-11-12T00:00:00.000Z',
    isAllDay: true,
    timezone: 'UTC',
    status: 'confirmed',
    etag: `"${id}-1"`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    attendees: [{ email: 'a@example.com', displayName: undefined }],
    reminders: null,
    visibility: null,
    colorId: null,
    conferenceData: null,
    recurringEventId: null,
    originalStartTime: null,
    raw: { id },
    ...overrides
  }
}

interface FakeGoogleCalendar {
  events: GoogleCalendarRemoteEvent[]
  /** A calendar that honours the tokens it issues, or one that refuses every token it issued. */
  honoursTokens: boolean
  listEvents: ReturnType<typeof vi.fn<(input: ListEventsInput) => Promise<ListEventsResult>>>
}

function fakeGoogleCalendar(
  calendarId: string,
  eventIds: string[],
  honoursTokens: boolean
): FakeGoogleCalendar {
  const fake: FakeGoogleCalendar = {
    events: eventIds.map((id) => remoteEvent(calendarId, id)),
    honoursTokens,
    listEvents: vi.fn(async ({ syncCursor }: ListEventsInput): Promise<ListEventsResult> => {
      if (!syncCursor) return { events: fake.events, nextSyncCursor: 'token' }
      if (!fake.honoursTokens) return { events: [], nextSyncCursor: null, cursorGone: true }
      return { events: [], nextSyncCursor: 'token' }
    })
  }
  return fake
}

describe('syncGoogleCalendarSource against Google incremental sync semantics (#4018)', () => {
  let dbResult: TestDatabaseResult
  let db: DataDb

  beforeEach(() => {
    vi.clearAllMocks()
    dbResult = createTestDataDb()
    db = dbResult.db as unknown as DataDb
    for (const [id, remoteId] of [
      [HOLIDAY, 'en.usa#holiday@group.v.calendar.google.com'],
      [TEAM, 'team@group.calendar.google.com']
    ] as const) {
      dbResult.db
        .insert(calendarSources)
        .values({
          id,
          provider: 'google',
          kind: 'calendar',
          accountId: 'me@example.com',
          remoteId,
          title: id,
          timezone: 'UTC',
          isSelected: true,
          syncStatus: 'idle',
          metadata: null
        })
        .run()
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    dbResult.close()
  })

  const sync = (sourceId: string, calendar: FakeGoogleCalendar): Promise<void> =>
    syncGoogleCalendarSource(db, sourceId, { client: calendar })

  const source = (id: string): typeof calendarSources.$inferSelect => {
    const row = dbResult.db.select().from(calendarSources).where(eq(calendarSources.id, id)).get()
    if (!row) throw new Error(`source missing: ${id}`)
    return row
  }

  const eventRow = (sourceId: string, remoteEventId: string) =>
    dbResult.db
      .select()
      .from(calendarExternalEvents)
      .where(
        and(
          eq(calendarExternalEvents.sourceId, sourceId),
          eq(calendarExternalEvents.remoteEventId, remoteEventId)
        )
      )
      .get()

  const liveTitles = (sourceId: string): string[] =>
    dbResult.db
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

  const externalEventUpdates = (): number =>
    enqueueUpdate.mock.calls.filter(([type]) => type === 'calendar_external_event').length

  const invalidationWarnings = (): number =>
    loggerMock.warn.mock.calls.filter(([message]) => String(message).includes('cursor invalidated'))
      .length

  describe('a calendar Google refuses incremental sync for', () => {
    const IDS = ['independence-day', 'labor-day', 'veterans-day']

    it('keeps its events and logs no invalidation warning on any pass', async () => {
      const holiday = fakeGoogleCalendar(HOLIDAY, IDS, false)

      for (let pass = 0; pass < 5; pass += 1) await sync(HOLIDAY, holiday)

      expect(liveTitles(HOLIDAY)).toEqual(IDS)
      expect(invalidationWarnings()).toBe(0)
      expect(loggerMock.warn).not.toHaveBeenCalled()
    })

    it('stops sending the token Google refuses once it has refused one it just issued', async () => {
      const holiday = fakeGoogleCalendar(HOLIDAY, IDS, false)

      await sync(HOLIDAY, holiday)
      await sync(HOLIDAY, holiday)
      holiday.listEvents.mockClear()
      await sync(HOLIDAY, holiday)
      await sync(HOLIDAY, holiday)

      expect(holiday.listEvents).toHaveBeenCalledTimes(2)
      for (const [input] of holiday.listEvents.mock.calls) expect(input.syncCursor).toBeNull()
      expect(source(HOLIDAY).syncCursor).toBeNull()
    })

    it('tries incremental sync again after a week, in case Google starts honouring it', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-11-05T10:00:00.000Z'))
      const holiday = fakeGoogleCalendar(HOLIDAY, IDS, false)
      await sync(HOLIDAY, holiday)
      await sync(HOLIDAY, holiday)

      holiday.honoursTokens = true
      vi.setSystemTime(Date.now() + 8 * DAY_MS)
      await sync(HOLIDAY, holiday)
      await sync(HOLIDAY, holiday)

      expect(source(HOLIDAY).syncCursor).toBe('token')
      expect(holiday.listEvents.mock.calls.at(-1)?.[0].syncCursor).toBe('token')
    })

    it('enqueues no sync update for events Google did not change', async () => {
      const holiday = fakeGoogleCalendar(HOLIDAY, IDS, false)
      await sync(HOLIDAY, holiday)
      expect(enqueueCreate).toHaveBeenCalledTimes(IDS.length)
      enqueueUpdate.mockClear()

      await sync(HOLIDAY, holiday)
      await sync(HOLIDAY, holiday)

      expect(externalEventUpdates()).toBe(0)
    })
  })

  describe('the events of a full listing', () => {
    const IDS = ['a', 'b', 'c']

    it('enqueue one update for an event whose etag changed and none for the rest', async () => {
      const holiday = fakeGoogleCalendar(HOLIDAY, IDS, false)
      await sync(HOLIDAY, holiday)
      enqueueUpdate.mockClear()
      holiday.events = holiday.events.map((event) =>
        event.id === 'b'
          ? { ...event, title: 'b renamed', etag: '"b-2"', updatedAt: '2026-02-01T00:00:00.000Z' }
          : event
      )

      await sync(HOLIDAY, holiday)

      expect(externalEventUpdates()).toBe(1)
      expect(eventRow(HOLIDAY, 'b')?.title).toBe('b renamed')
      expect(eventRow(HOLIDAY, 'b')?.remoteEtag).toBe('"b-2"')
    })

    it('revive an event that was archived locally while Google still has it', async () => {
      const holiday = fakeGoogleCalendar(HOLIDAY, IDS, false)
      await sync(HOLIDAY, holiday)
      dbResult.db
        .update(calendarExternalEvents)
        .set({ archivedAt: '2026-11-05T10:00:00.000Z' })
        .where(eq(calendarExternalEvents.remoteEventId, 'a'))
        .run()
      enqueueUpdate.mockClear()

      await sync(HOLIDAY, holiday)

      expect(eventRow(HOLIDAY, 'a')?.archivedAt).toBeNull()
      expect(externalEventUpdates()).toBe(1)
    })

    it('archive a cancelled event once and leave its tombstone alone on later passes', async () => {
      const holiday = fakeGoogleCalendar(HOLIDAY, IDS, false)
      await sync(HOLIDAY, holiday)
      enqueueUpdate.mockClear()
      holiday.events = holiday.events.map((event) =>
        event.id === 'c' ? { ...event, status: 'cancelled' as const } : event
      )

      await sync(HOLIDAY, holiday)
      const archivedAt = eventRow(HOLIDAY, 'c')?.archivedAt
      await sync(HOLIDAY, holiday)

      expect(archivedAt).toEqual(expect.any(String))
      expect(eventRow(HOLIDAY, 'c')?.archivedAt).toBe(archivedAt)
      expect(externalEventUpdates()).toBe(1)
      expect(liveTitles(HOLIDAY)).toEqual(['a', 'b'])
    })
  })

  describe('a calendar Google honours incremental sync for', () => {
    it('proves its token on the next pass and re-syncs in full when Google later expires it', async () => {
      const team = fakeGoogleCalendar(TEAM, ['standup'], true)
      await sync(TEAM, team)
      await sync(TEAM, team)
      expect(source(TEAM).syncCursor).toBe('token')

      team.honoursTokens = false
      await sync(TEAM, team)
      team.honoursTokens = true
      team.listEvents.mockClear()
      await sync(TEAM, team)

      expect(source(TEAM).syncCursor).toBe('token')
      expect(team.listEvents.mock.calls[0]?.[0].syncCursor).toBe('token')
      expect(liveTitles(TEAM)).toEqual(['standup'])
      expect(loggerMock.warn).not.toHaveBeenCalled()
    })
  })

  describe('a delta response without a nextSyncToken', () => {
    it('re-syncs from scratch and says why', async () => {
      const team = fakeGoogleCalendar(TEAM, ['standup'], true)
      await sync(TEAM, team)
      await sync(TEAM, team)
      team.listEvents.mockImplementationOnce(async () => ({ events: [], nextSyncCursor: null }))

      await sync(TEAM, team)

      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.stringContaining('no nextSyncToken'),
        expect.objectContaining({ sourceId: TEAM })
      )
      expect(source(TEAM).syncCursor).toBe('token')
    })
  })
})
