import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import keytar from 'keytar'
import { eq } from 'drizzle-orm'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import {
  FakeCaldavServer,
  vevent,
  type FakeCaldavServerOptions
} from '@tests/utils/fake-caldav-server'
import type { DataDb } from '../../database'
import { promoteExternalEvent } from '../promote-external-event'
import { registerBuiltinCalendarProviders } from '../provider/builtin-providers'
import { resolveWriteRoute } from '../provider/write-routing'
import { caldavCalendarSourceId } from './caldav-accounts'
import { connectCaldavAccount } from './caldav-connect'
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

/**
 * Remote changes to objects Memry items are bound to (#1400 review): they have
 * no mirror rows, so every pull mode has to find them some other way.
 */
describe('CalDAV bound objects changed on the server', () => {
  let dbResult: TestDatabaseResult
  let db: DataDb
  let server: FakeCaldavServer
  let collection: string
  let sourceId: string
  const secrets = new Map<string, string>()

  beforeEach(() => {
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
  })

  afterEach(() => {
    dbResult.close()
  })

  async function connect(
    overrides: Partial<FakeCaldavServerOptions> = {},
    syncCollection = true
  ): Promise<void> {
    server = new FakeCaldavServer({
      host: 'dav.example.org',
      username: 'me',
      password: 'app-password',
      calendars: [{ path: WORK, displayName: 'Work', supportsSyncCollection: syncCollection }],
      ...overrides
    })
    await connectCaldavAccount(
      db,
      { serverUrl: 'https://dav.example.org/', username: 'me', password: 'app-password' },
      { fetchImpl: server.fetch }
    )
    collection = server.collectionUrl(WORK)
    sourceId = caldavCalendarSourceId(collection)
  }

  function insertEvent(id: string, startAt = '2026-10-01T09:00:00.000Z'): void {
    dbResult.db
      .insert(calendarEvents)
      .values({
        id,
        title: 'Dentist',
        startAt,
        endAt: new Date(new Date(startAt).getTime() + 3600000).toISOString(),
        timezone: 'UTC',
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

  async function pull() {
    return await syncCaldavCalendarSource(db, sourceId, { fetchImpl: server.fetch, now: () => NOW })
  }

  function event(id: string) {
    return dbResult.db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).get()
  }

  function nameOf(href: string): string {
    return href.slice(collection.length)
  }

  it('ctag mode: a bound object deleted on the server deletes its Memry event', async () => {
    await connect({}, false)
    insertEvent('ctag-event')
    const created = await push('ctag-event')
    expect(await pull()).toMatchObject({ mode: 'full' })

    server.deleteObject(WORK, nameOf(created!.remoteEventId))
    expect(await pull()).toMatchObject({ mode: 'ctag' })

    expect(event('ctag-event')).toBeUndefined()
  })

  it('ctag mode: an unchanged bound object is not fetched again', async () => {
    await connect({}, false)
    insertEvent('ctag-quiet')
    const created = await push('ctag-quiet')
    await pull()
    server.putObject(
      WORK,
      'other.ics',
      vevent({ uid: 'other', summary: 'Other', start: '20261003T090000Z', end: '20261003T100000Z' })
    )
    const before = server.requests.length
    await pull()
    const fetched = server.requests
      .slice(before)
      .filter((request) => request.method === 'REPORT')
      .map((request) => request.body)
      .join('\n')
    expect(fetched).toContain('other.ics')
    expect(fetched).not.toContain(nameOf(created!.remoteEventId))
    expect(event('ctag-quiet')?.title).toBe('Dentist')
  })

  it('full pull: a bound object deleted on the server deletes its Memry event', async () => {
    await connect()
    insertEvent('full-event')
    const created = await push('full-event')
    await pull()
    server.deleteObject(WORK, nameOf(created!.remoteEventId))
    // A reset cursor (invalid token, or a calendar ticked back on) pulls in full.
    dbResult.db
      .update(calendarSources)
      .set({ syncCursor: null })
      .where(eq(calendarSources.id, sourceId))
      .run()

    expect(await pull()).toMatchObject({ mode: 'full' })
    expect(event('full-event')).toBeUndefined()
  })

  it('full pull: a bound object outside the window still flows back', async () => {
    await connect()
    insertEvent('far-event', '2028-06-01T09:00:00.000Z')
    const created = await push('far-event')
    const name = nameOf(created!.remoteEventId)
    server.putObject(
      WORK,
      name,
      server.getObject(WORK, name)!.data.replace('SUMMARY:Dentist', 'SUMMARY:Dentist (far)')
    )

    expect(await pull()).toMatchObject({ mode: 'full' })
    expect(event('far-event')?.title).toBe('Dentist (far)')
  })

  it('a push that finds the object deleted applies the delete instead of failing forever', async () => {
    await connect()
    insertEvent('gone-event')
    const created = await push('gone-event')
    server.deleteObject(WORK, nameOf(created!.remoteEventId))
    dbResult.db
      .update(calendarEvents)
      .set({ title: 'Dentist (edited here)' })
      .where(eq(calendarEvents.id, 'gone-event'))
      .run()

    await expect(push('gone-event')).resolves.toBeNull()

    expect(event('gone-event')).toBeUndefined()
    expect(dbResult.db.select().from(calendarBindings).get()?.archivedAt).not.toBeNull()
    expect(server.listObjectNames(WORK)).toEqual([])
  })

  it('a promoted occurrence excluded on the server (EXDATE) deletes its Memry event', async () => {
    await connect()
    const series = vevent({
      uid: 'weekly',
      summary: 'Standup',
      start: '20261001T090000Z',
      end: '20261001T093000Z',
      rrule: 'FREQ=WEEKLY;COUNT=4'
    })
    server.putObject(WORK, 'weekly.ics', series)
    await pull()
    const second = dbResult.db
      .select()
      .from(calendarExternalEvents)
      .all()
      .find((row) => row.startAt === '2026-10-08T09:00:00.000Z')!
    const { eventId } = promoteExternalEvent(db, { externalEventId: second.id })

    server.putObject(
      WORK,
      'weekly.ics',
      series.replace('RRULE:', 'EXDATE:20261008T090000Z\r\nRRULE:')
    )
    await pull()

    expect(event(eventId!)).toBeUndefined()
    const mirrored = dbResult.db
      .select()
      .from(calendarExternalEvents)
      .all()
      .map((row) => row.startAt)
      .sort()
    expect(mirrored).toEqual([
      '2026-10-01T09:00:00.000Z',
      '2026-10-15T09:00:00.000Z',
      '2026-10-22T09:00:00.000Z'
    ])
  })

  it('a server that answers a PUT without an ETag: the stored copy and ETag are read back', async () => {
    await connect({ rewritesOnPut: true })
    insertEvent('rewrite-event')
    const created = await push('rewrite-event')
    const name = nameOf(created!.remoteEventId)
    const stored = server.getObject(WORK, name)!
    expect(created!.remoteVersion).toBe(stored.etag)
    expect((created!.lastLocalSnapshot as { caldavRaw?: string } | null)?.caldavRaw).toContain(
      'X-SERVER-NORMALISED:1'
    )

    // The pull sees our own write, not a remote edit.
    dbResult.db
      .update(calendarEvents)
      .set({ title: 'Dentist (local, not pushed yet)' })
      .where(eq(calendarEvents.id, 'rewrite-event'))
      .run()
    await pull()
    expect(event('rewrite-event')?.title).toBe('Dentist (local, not pushed yet)')

    await push('rewrite-event')
    const update = server.requests.filter((request) => request.method === 'PUT').at(-1)!
    expect(update.headers['if-match']).toBe(stored.etag)
  })
})
