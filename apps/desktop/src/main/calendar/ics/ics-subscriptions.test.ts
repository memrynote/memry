import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult,
  type TestDb
} from '@tests/utils/test-db'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import type { DataDb, IndexDb } from '../../database'

const { syncEffects } = vi.hoisted(() => ({
  syncEffects: [] as string[]
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))

vi.mock('../runtime-effects', () => ({
  syncCalendarSourceCreate: (id: string) => syncEffects.push(`create:${id}`),
  syncCalendarSourceUpdate: (id: string) => syncEffects.push(`update:${id}`)
}))

import { getCalendarRangeProjection } from '../projection'
import { promoteExternalEvent } from '../promote-external-event'
import { IcsFeedError } from './ics-feed'
import type { FetchLike } from './ics-fetch'
import {
  refreshDueIcsCalendars,
  refreshIcsCalendarSource,
  subscribeIcsCalendar,
  unsubscribeIcsCalendar
} from './ics-subscriptions'

const FEED_URL = 'https://calendar.example.com/feeds/secret-token/basic.ics'
const NOW = new Date('2026-05-01T12:00:00.000Z')

function feedBody(events: string[]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Test//EN',
    'X-WR-CALNAME:Proton Personal',
    ...events,
    'END:VCALENDAR'
  ].join('\r\n')
}

function vevent(uid: string, start: string, summary: string): string[] {
  return ['BEGIN:VEVENT', `UID:${uid}`, `DTSTART:${start}`, `SUMMARY:${summary}`, 'END:VEVENT']
}

interface FakeResponse {
  status: number
  body?: string
  headers?: Record<string, string>
}

function fakeFetch(responses: FakeResponse[]): {
  fetch: FetchLike
  requests: Array<{ url: string; headers: Record<string, string> }>
} {
  const requests: Array<{ url: string; headers: Record<string, string> }> = []
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, headers: { ...(init.headers as Record<string, string>) } })
    const next = responses.shift()
    if (!next) throw new TypeError('fetch failed')
    return new Response(next.status === 304 ? null : (next.body ?? ''), {
      status: next.status,
      headers: next.headers
    })
  }
  return { fetch, requests }
}

describe('ICS calendar subscriptions', () => {
  let dbResult: TestDatabaseResult
  let indexResult: TestDatabaseResult
  let db: TestDb

  beforeEach(() => {
    dbResult = createTestDataDb()
    indexResult = createTestIndexDb()
    db = dbResult.db
    syncEffects.length = 0
  })

  afterEach(() => {
    dbResult.close()
    indexResult.close()
  })

  function dataDb(): DataDb {
    return db as unknown as DataDb
  }

  function projectedTitles(): Array<{ title: string; canMove: boolean; provider: string | null }> {
    return getCalendarRangeProjection(
      dataDb(),
      indexResult.db as unknown as IndexDb,
      {
        startAt: '2026-04-01T00:00:00.000Z',
        endAt: '2026-07-01T00:00:00.000Z',
        includeUnselectedSources: false
      },
      []
    ).items.map((item) => ({
      title: item.title,
      canMove: item.editability.canMove,
      provider: item.source.provider
    }))
  }

  it('subscribes from a webcal link and shows the feed read-only on the calendar', async () => {
    const { fetch, requests } = fakeFetch([
      {
        status: 200,
        body: feedBody(vevent('a@test', '20260510T090000Z', 'Dentist')),
        headers: { etag: '"v1"' }
      }
    ])

    const source = await subscribeIcsCalendar(
      dataDb(),
      { url: 'webcal://calendar.example.com/feeds/secret-token/basic.ics' },
      { fetch, now: () => NOW }
    )

    expect(requests.map((request) => request.url)).toEqual([FEED_URL])
    expect(source).toMatchObject({
      provider: 'ics',
      kind: 'calendar',
      remoteId: FEED_URL,
      title: 'Proton Personal',
      isSelected: true,
      syncStatus: 'ok',
      lastSyncedAt: NOW.toISOString(),
      lastError: null
    })
    expect(syncEffects).toEqual([`create:${source.id}`])
    expect(projectedTitles()).toEqual([{ title: 'Dentist', canMove: false, provider: 'ics' }])

    const [mirrored] = db.select().from(calendarExternalEvents).all()
    expect(() => promoteExternalEvent(dataDb(), { externalEventId: mirrored.id })).toThrow(
      /read-only subscription/
    )
  })

  it('saves nothing when the link does not return a calendar', async () => {
    const { fetch } = fakeFetch([{ status: 200, body: '<html>Sign in</html>' }])

    await expect(
      subscribeIcsCalendar(dataDb(), { url: FEED_URL }, { fetch, now: () => NOW })
    ).rejects.toMatchObject({ code: 'not_a_calendar' })
    await expect(
      subscribeIcsCalendar(dataDb(), { url: 'calendar.example.com' }, { fetch, now: () => NOW })
    ).rejects.toMatchObject({ code: 'invalid_url' })

    expect(db.select().from(calendarSources).all()).toEqual([])
    expect(syncEffects).toEqual([])
  })

  it('refreshes with the last ETag, applies edits and deletions, and keeps an unchanged 304', async () => {
    const { fetch, requests } = fakeFetch([
      {
        status: 200,
        body: feedBody([
          ...vevent('a@test', '20260510T090000Z', 'Dentist'),
          ...vevent('b@test', '20260511T090000Z', 'Gym')
        ]),
        headers: { etag: '"v1"' }
      },
      {
        status: 200,
        body: feedBody(vevent('a@test', '20260510T100000Z', 'Dentist (moved)')),
        headers: { etag: '"v2"' }
      },
      { status: 304 }
    ])
    const deps = { fetch, now: () => NOW }
    const source = await subscribeIcsCalendar(dataDb(), { url: FEED_URL }, deps)

    await refreshIcsCalendarSource(dataDb(), source.id, deps)
    expect(projectedTitles()).toEqual([
      { title: 'Dentist (moved)', canMove: false, provider: 'ics' }
    ])

    await refreshIcsCalendarSource(dataDb(), source.id, deps)
    expect(projectedTitles()).toEqual([
      { title: 'Dentist (moved)', canMove: false, provider: 'ics' }
    ])
    expect(requests.map((request) => request.headers['If-None-Match'] ?? null)).toEqual([
      null,
      '"v1"',
      '"v2"'
    ])
    expect(syncEffects).toEqual([`create:${source.id}`])
  })

  it('records a failed refresh on the source and keeps the events it already had', async () => {
    const { fetch } = fakeFetch([
      { status: 200, body: feedBody(vevent('a@test', '20260510T090000Z', 'Dentist')) },
      { status: 404 }
    ])
    const deps = { fetch, now: () => NOW }
    const source = await subscribeIcsCalendar(dataDb(), { url: FEED_URL }, deps)

    await expect(refreshIcsCalendarSource(dataDb(), source.id, deps)).rejects.toBeInstanceOf(
      IcsFeedError
    )

    expect(
      db
        .select({ syncStatus: calendarSources.syncStatus, lastError: calendarSources.lastError })
        .from(calendarSources)
        .where(eq(calendarSources.id, source.id))
        .get()
    ).toEqual({ syncStatus: 'error', lastError: 'not_found' })
    expect(projectedTitles()).toEqual([{ title: 'Dentist', canMove: false, provider: 'ics' }])
  })

  it('unsubscribing tombstones the synced source, drops local events, and resubscribing restores it', async () => {
    const body = feedBody(vevent('a@test', '20260510T090000Z', 'Dentist'))
    const { fetch } = fakeFetch([
      { status: 200, body, headers: { etag: '"v1"' } },
      { status: 200, body, headers: { etag: '"v1"' } }
    ])
    const deps = { fetch, now: () => NOW }
    const source = await subscribeIcsCalendar(dataDb(), { url: FEED_URL }, deps)

    const removed = unsubscribeIcsCalendar(dataDb(), source.id, deps)
    expect(removed.archivedAt).toBe(NOW.toISOString())
    expect(db.select().from(calendarExternalEvents).all()).toEqual([])
    expect(projectedTitles()).toEqual([])

    const restored = await subscribeIcsCalendar(dataDb(), { url: FEED_URL }, deps)
    expect(restored).toMatchObject({ id: source.id, archivedAt: null })
    expect(projectedTitles()).toEqual([{ title: 'Dentist', canMove: false, provider: 'ics' }])
    expect(syncEffects).toEqual([
      `create:${source.id}`,
      `update:${source.id}`,
      `update:${source.id}`
    ])
  })

  it('the runner reads a source another device subscribed and clears one it removed', async () => {
    const { fetch, requests } = fakeFetch([
      { status: 200, body: feedBody(vevent('a@test', '20260510T090000Z', 'Dentist')) }
    ])
    db.insert(calendarSources)
      .values({
        id: 'ics-calendar:remote',
        provider: 'ics',
        kind: 'calendar',
        remoteId: FEED_URL,
        title: 'Shared from laptop',
        isSelected: true,
        clock: { laptop: 1 },
        createdAt: NOW.toISOString(),
        modifiedAt: NOW.toISOString()
      })
      .run()

    await refreshDueIcsCalendars(dataDb(), { fetch, now: () => NOW })
    await refreshDueIcsCalendars(dataDb(), { fetch, now: () => NOW })
    expect(requests).toHaveLength(1)
    expect(projectedTitles()).toEqual([{ title: 'Dentist', canMove: false, provider: 'ics' }])

    db.update(calendarSources)
      .set({ archivedAt: NOW.toISOString() })
      .where(eq(calendarSources.id, 'ics-calendar:remote'))
      .run()
    await refreshDueIcsCalendars(dataDb(), { fetch, now: () => NOW })
    expect(db.select().from(calendarExternalEvents).all()).toEqual([])
    expect(syncEffects).toEqual([])
  })
})
