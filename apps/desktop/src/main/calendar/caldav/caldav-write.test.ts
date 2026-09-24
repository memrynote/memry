import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import keytar from 'keytar'
import { eq } from 'drizzle-orm'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { FakeCaldavServer, vevent } from '@tests/utils/fake-caldav-server'
import type { DataDb } from '../../database'
import { promoteExternalEvent } from '../promote-external-event'
import { PROVIDER_CAPABILITIES } from '../provider/capabilities'
import { writeCalendarProviderSettings } from '../provider/provider-settings'
import { registerBuiltinCalendarProviders } from '../provider/builtin-providers'
import { resolveWriteRoute } from '../provider/write-routing'
import { caldavCalendarSourceId } from './caldav-accounts'
import { connectCaldavAccount, disconnectCaldavAccount } from './caldav-connect'
import { syncCaldavCalendarSource } from './caldav-sync'
import { syncLocalSourceToCaldav } from './caldav-write'

vi.mock('keytar', () => ({
  default: { setPassword: vi.fn(), getPassword: vi.fn(), deletePassword: vi.fn() }
}))
vi.mock('../change-events', () => ({
  emitCalendarChanged: vi.fn(),
  emitCalendarProjectionChanged: vi.fn()
}))
vi.mock('../../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn()
}))
vi.mock('../../telemetry/track', () => ({ trackMainEvent: vi.fn() }))

const WORK = '/me/calendars/work/'
const NOW = new Date('2026-09-24T08:00:00.000Z')

describe('CalDAV write-back (#1400)', () => {
  let dbResult: TestDatabaseResult
  let db: DataDb
  let server: FakeCaldavServer
  let collection: string
  let sourceId: string
  const secrets = new Map<string, string>()

  beforeEach(async () => {
    registerBuiltinCalendarProviders()
    dbResult = createTestDataDb()
    db = dbResult.db as unknown as DataDb
    secrets.clear()
    vi.mocked(keytar.setPassword).mockImplementation(async (service, account, value) => {
      secrets.set(`${service}:${account}`, value)
    })
    vi.mocked(keytar.getPassword).mockImplementation(
      async (service, account) => secrets.get(`${service}:${account}`) ?? null
    )
    vi.mocked(keytar.deletePassword).mockImplementation(async (service, account) =>
      secrets.delete(`${service}:${account}`)
    )
    server = new FakeCaldavServer({
      host: 'dav.example.org',
      username: 'me',
      password: 'app-password',
      calendars: [{ path: WORK, displayName: 'Work' }]
    })
    await connectCaldavAccount(
      db,
      { serverUrl: 'https://dav.example.org/', username: 'me', password: 'app-password' },
      { fetchImpl: server.fetch }
    )
    collection = server.collectionUrl(WORK)
    sourceId = caldavCalendarSourceId(collection)
  })

  afterEach(() => {
    dbResult.close()
  })

  function insertEvent(id: string, title: string): void {
    dbResult.db
      .insert(calendarEvents)
      .values({
        id,
        title,
        startAt: '2026-10-01T09:00:00.000Z',
        endAt: '2026-10-01T10:00:00.000Z',
        timezone: 'Europe/Berlin',
        isAllDay: false,
        targetCalendarId: collection,
        createdAt: NOW.toISOString(),
        modifiedAt: NOW.toISOString()
      })
      .run()
  }

  async function push(id: string) {
    const target = { sourceType: 'event' as const, sourceId: id }
    return await syncLocalSourceToCaldav(db, target, resolveWriteRoute(db, target), {
      fetchImpl: server.fetch
    })
  }

  function puts() {
    return server.requests.filter((request) => request.method === 'PUT')
  }

  it('creates with If-None-Match, updates with If-Match, deletes with If-Match', async () => {
    insertEvent('event-1', 'Design review')
    const created = await push('event-1')
    expect(created).toMatchObject({ provider: 'caldav', remoteCalendarId: collection })
    const create = puts().at(-1)!
    expect(create.headers['if-none-match']).toBe('*')
    expect(create.body).toContain('SUMMARY:Design review')
    expect(create.body).toContain('DTSTART;TZID=Europe/Berlin:20261001T110000')
    const name = created!.remoteEventId.slice(collection.length)
    expect(server.getObject(WORK, name)?.etag).toBe(created!.remoteVersion)

    dbResult.db
      .update(calendarEvents)
      .set({ title: 'Design review (moved)' })
      .where(eq(calendarEvents.id, 'event-1'))
      .run()
    const updated = await push('event-1')
    const update = puts().at(-1)!
    expect(update.headers['if-match']).toBe(created!.remoteVersion)
    expect(server.getObject(WORK, name)?.data).toContain('SUMMARY:Design review (moved)')
    expect(updated!.remoteVersion).toBe(server.getObject(WORK, name)?.etag)

    dbResult.db.delete(calendarEvents).where(eq(calendarEvents.id, 'event-1')).run()
    await push('event-1')
    const del = server.requests.filter((request) => request.method === 'DELETE').at(-1)!
    expect(del.headers['if-match']).toBe(updated!.remoteVersion)
    expect(server.getObject(WORK, name)).toBeUndefined()
    expect(dbResult.db.select().from(calendarBindings).get()?.archivedAt).not.toBeNull()
  })

  it('an update preserves the unknown properties and X- extensions of the stored object', async () => {
    server.putObject(
      WORK,
      'foreign.ics',
      vevent({
        uid: 'foreign',
        summary: 'Offsite',
        start: '20261002T090000Z',
        end: '20261002T170000Z',
        extra: [
          'CATEGORIES:Company',
          'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
          'X-OTHER-CLIENT:keep me'
        ]
      })
    )
    await syncCaldavCalendarSource(db, sourceId, { fetchImpl: server.fetch, now: () => NOW })
    const mirror = dbResult.db.select().from(calendarExternalEvents).get()!
    const { eventId } = promoteExternalEvent(db, { externalEventId: mirror.id })
    dbResult.db
      .update(calendarEvents)
      .set({ title: 'Offsite (Berlin)' })
      .where(eq(calendarEvents.id, eventId!))
      .run()

    await push(eventId!)

    const data = server.getObject(WORK, 'foreign.ics')!.data
    expect(data).toContain('SUMMARY:Offsite (Berlin)')
    expect(data).toContain('CATEGORIES:Company')
    expect(data).toContain('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC')
    expect(data).toContain('X-OTHER-CLIENT:keep me')
    expect(puts().at(-1)!.headers['if-match']).toBe(mirror.remoteEtag)
  })

  it('a remote change under us: 412 → refetch → merge → retry', async () => {
    insertEvent('event-2', 'Planning')
    const created = await push('event-2')
    const name = created!.remoteEventId.slice(collection.length)
    // Another client edits the description and adds its own property first.
    const remoteVersion = server
      .getObject(WORK, name)!
      .data.replace(
        'END:VEVENT',
        'DESCRIPTION:Bring the roadmap\r\nX-OTHER-CLIENT:yes\r\nEND:VEVENT'
      )
    server.raceNextPut(WORK, name, remoteVersion)
    dbResult.db
      .update(calendarEvents)
      .set({ title: 'Planning (Q4)' })
      .where(eq(calendarEvents.id, 'event-2'))
      .run()

    const binding = await push('event-2')

    const attempts = puts().slice(-2)
    expect(attempts).toHaveLength(2)
    expect(attempts[0].headers['if-match']).toBe(created!.remoteVersion)
    const final = server.getObject(WORK, name)!
    expect(attempts[1].headers['if-match']).not.toBe(created!.remoteVersion)
    expect(final.data).toContain('SUMMARY:Planning (Q4)')
    expect(final.data).toContain('X-OTHER-CLIENT:yes')
    expect(binding!.remoteVersion).toBe(final.etag)
    // The remote description was merged into the Memry event.
    expect(
      dbResult.db.select().from(calendarEvents).where(eq(calendarEvents.id, 'event-2')).get()
        ?.description
    ).toBe('Bring the roadmap')
  })

  it('never PUTs or DELETEs with the one-way switch off', async () => {
    writeCalendarProviderSettings(db, 'caldav', { pushEventsToProvider: false })
    insertEvent('event-3', 'Private')
    expect(await push('event-3')).toBeNull()
    expect(puts()).toEqual([])
  })

  it('never PUTs or DELETEs when the provider cannot write', async () => {
    const table = PROVIDER_CAPABILITIES as Record<string, (typeof PROVIDER_CAPABILITIES)[string]>
    const original = table.caldav
    table.caldav = { ...original, supportsWrite: false }
    try {
      insertEvent('event-4', 'Read-only')
      expect(await push('event-4')).toBeNull()
      expect(puts()).toEqual([])
      expect(dbResult.db.select().from(calendarBindings).all()).toEqual([])
    } finally {
      table.caldav = original
    }
  })

  it('after the CalDAV source is disconnected, no further PUT or DELETE', async () => {
    insertEvent('event-5', 'Before disconnect')
    await push('event-5')
    const before = server.requests.length
    await disconnectCaldavAccount(db)

    dbResult.db
      .update(calendarEvents)
      .set({ title: 'After disconnect' })
      .where(eq(calendarEvents.id, 'event-5'))
      .run()
    expect(await push('event-5')).toBeNull()
    dbResult.db.delete(calendarEvents).where(eq(calendarEvents.id, 'event-5')).run()
    expect(await push('event-5')).toBeNull()
    expect(
      server.requests.slice(before).filter((request) => ['PUT', 'DELETE'].includes(request.method))
    ).toEqual([])
  })

  it('a remote edit of a bound object flows back into the Memry event, and a remote delete deletes it', async () => {
    insertEvent('event-6', 'Dentist')
    const created = await push('event-6')
    const name = created!.remoteEventId.slice(collection.length)
    await syncCaldavCalendarSource(db, sourceId, { fetchImpl: server.fetch, now: () => NOW })
    // Our own write is not mirrored as an external event.
    expect(dbResult.db.select().from(calendarExternalEvents).all()).toEqual([])

    server.putObject(
      WORK,
      name,
      server.getObject(WORK, name)!.data.replace('SUMMARY:Dentist', 'SUMMARY:Dentist (rescheduled)')
    )
    await syncCaldavCalendarSource(db, sourceId, { fetchImpl: server.fetch, now: () => NOW })
    expect(
      dbResult.db.select().from(calendarEvents).where(eq(calendarEvents.id, 'event-6')).get()?.title
    ).toBe('Dentist (rescheduled)')

    server.deleteObject(WORK, name)
    await syncCaldavCalendarSource(db, sourceId, { fetchImpl: server.fetch, now: () => NOW })
    expect(
      dbResult.db.select().from(calendarEvents).where(eq(calendarEvents.id, 'event-6')).get()
    ).toBeUndefined()
  })
})
