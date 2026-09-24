/**
 * Live CalDAV verification against a local Radicale server (#1399, #1400).
 * Skips unless Radicale is available; see tests/utils/radicale.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import keytar from 'keytar'
import { eq } from 'drizzle-orm'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import {
  RADICALE_BIN,
  makeCalendar,
  startRadicale,
  type RadicaleServer
} from '@tests/utils/radicale'
import { vevent } from '@tests/utils/fake-caldav-server'
import type { DataDb } from '../../database'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
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
vi.mock('../../telemetry/track', () => ({ trackMainEvent: vi.fn() }))
vi.mock('../../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn()
}))

const CALENDAR_PATH = 'memry/work/'
const soon = (days: number, hour: number): string => {
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
  date.setUTCHours(hour, 0, 0, 0)
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
}

describe.skipIf(!RADICALE_BIN)('CalDAV against a live Radicale server', () => {
  let server: RadicaleServer
  let dbResult: TestDatabaseResult
  let db: DataDb
  let sourceId: string
  const secrets = new Map<string, string>()

  beforeAll(async () => {
    server = await startRadicale()
    await makeCalendar(server, CALENDAR_PATH, 'Work')
    vi.mocked(keytar.setPassword).mockImplementation(async (service, account, value) => {
      secrets.set(`${service}:${account}`, value)
    })
    vi.mocked(keytar.getPassword).mockImplementation(
      async (service, account) => secrets.get(`${service}:${account}`) ?? null
    )
    vi.mocked(keytar.deletePassword).mockImplementation(async (service, account) =>
      secrets.delete(`${service}:${account}`)
    )
    dbResult = createTestDataDb()
    db = dbResult.db as unknown as DataDb
  })

  afterAll(async () => {
    dbResult?.close()
    await server?.stop()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function putRemote(name: string, ics: string): Promise<void> {
    const response = await server.request(`${CALENDAR_PATH}${name}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/calendar' },
      body: ics
    })
    expect([201, 204]).toContain(response.status)
  }

  function mirrored(): string[] {
    return dbResult.db
      .select()
      .from(calendarExternalEvents)
      .where(eq(calendarExternalEvents.sourceId, sourceId))
      .all()
      .map((row) => row.title)
      .sort()
  }

  function cursor(): string | null {
    return (
      dbResult.db.select().from(calendarSources).where(eq(calendarSources.id, sourceId)).get()
        ?.syncCursor ?? null
    )
  }

  it('discovery: well-known → principal → home set → the calendar', async () => {
    await putRemote(
      'standup.ics',
      vevent({ uid: 'standup', summary: 'Standup', start: soon(1, 9), end: soon(1, 10) })
    )
    const { info } = await connectCaldavAccount(db, {
      serverUrl: server.url,
      username: server.username,
      password: server.password
    })
    expect(info.calendars.map((calendar) => calendar.displayName)).toEqual(['Work'])
    expect(info.calendars[0].supportsSyncCollection).toBe(true)
    sourceId = caldavCalendarSourceId(info.calendars[0].url)
  })

  it('initial sync pulls the calendar and stores a sync-token cursor', async () => {
    const result = await syncCaldavCalendarSource(db, sourceId)
    expect(result.mode).toBe('full')
    expect(mirrored()).toEqual(['Standup'])
    expect(cursor()).toMatch(/^sync-token:/)
  })

  it('incremental sync with the sync-token picks up exactly the change', async () => {
    await putRemote(
      'dentist.ics',
      vevent({ uid: 'dentist', summary: 'Dentist', start: soon(2, 14), end: soon(2, 15) })
    )
    const before = cursor()
    const result = await syncCaldavCalendarSource(db, sourceId)
    expect(result.mode).toBe('sync-token')
    expect(result.changedRows).toBe(1)
    expect(mirrored()).toEqual(['Dentist', 'Standup'])
    expect(cursor()).not.toBe(before)
  })

  it('an invalid sync-token falls back to a full resync', async () => {
    dbResult.db
      .update(calendarSources)
      .set({ syncCursor: 'sync-token:http://radicale.org/ns/sync/not-a-real-token' })
      .where(eq(calendarSources.id, sourceId))
      .run()
    await putRemote('review.ics', vevent({ uid: 'review', summary: 'Review', start: soon(3, 11) }))

    const result = await syncCaldavCalendarSource(db, sourceId)

    expect(result.mode).toBe('full')
    expect(mirrored()).toEqual(['Dentist', 'Review', 'Standup'])
    expect(cursor()).toMatch(/^sync-token:http/)
  })

  it('a remote delete removes exactly that event', async () => {
    const response = await server.request(`${CALENDAR_PATH}dentist.ics`, { method: 'DELETE' })
    expect(response.status).toBe(200)
    await syncCaldavCalendarSource(db, sourceId)
    expect(mirrored()).toEqual(['Review', 'Standup'])
  })
  const writes: Array<{ method: string; url: string; ifMatch: string | null }> = []
  const recordingFetch = async (input: string, init: RequestInit): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase()
    if (method === 'PUT' || method === 'DELETE') {
      writes.push({ method, url: input, ifMatch: new Headers(init.headers).get('if-match') })
    }
    return await fetch(input, init)
  }

  function collectionUrl(): string {
    return dbResult.db.select().from(calendarSources).where(eq(calendarSources.id, sourceId)).get()!
      .remoteId
  }

  async function pushEvent(id: string) {
    const target = { sourceType: 'event' as const, sourceId: id }
    return await syncLocalSourceToCaldav(db, target, resolveWriteRoute(db, target), {
      fetchImpl: recordingFetch
    })
  }

  async function remoteObject(
    href: string
  ): Promise<{ status: number; body: string; etag: string | null }> {
    const response = await server.request(new URL(href).pathname, { method: 'GET' })
    return {
      status: response.status,
      body: await response.text(),
      etag: response.headers.get('etag')
    }
  }

  it('create, update and delete from memrynote', async () => {
    dbResult.db
      .insert(calendarEvents)
      .values({
        id: 'memry-1',
        title: 'Written by memrynote',
        startAt: new Date(Date.now() + 4 * 86400000).toISOString(),
        endAt: new Date(Date.now() + 4 * 86400000 + 3600000).toISOString(),
        timezone: 'Europe/Istanbul',
        isAllDay: false,
        targetCalendarId: collectionUrl(),
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString()
      })
      .run()

    const created = await pushEvent('memry-1')
    expect(created?.provider).toBe('caldav')
    expect((await remoteObject(created!.remoteEventId)).body).toContain(
      'SUMMARY:Written by memrynote'
    )

    dbResult.db
      .update(calendarEvents)
      .set({ title: 'Updated by memrynote' })
      .where(eq(calendarEvents.id, 'memry-1'))
      .run()
    const updated = await pushEvent('memry-1')
    expect(writes.at(-1)).toMatchObject({ method: 'PUT', ifMatch: created!.remoteVersion })
    const afterUpdate = await remoteObject(created!.remoteEventId)
    expect(afterUpdate.body).toContain('SUMMARY:Updated by memrynote')
    expect(updated!.remoteVersion).toBe(afterUpdate.etag)

    // The pull recognises its own object and does not mirror it.
    await syncCaldavCalendarSource(db, sourceId)
    expect(mirrored()).not.toContain('Updated by memrynote')

    dbResult.db.delete(calendarEvents).where(eq(calendarEvents.id, 'memry-1')).run()
    await pushEvent('memry-1')
    expect(writes.at(-1)).toMatchObject({ method: 'DELETE', ifMatch: updated!.remoteVersion })
    expect((await remoteObject(created!.remoteEventId)).status).toBe(404)
  })

  it('a remote edit makes the next write fail with 412, then merge and retry', async () => {
    dbResult.db
      .insert(calendarEvents)
      .values({
        id: 'memry-2',
        title: 'Planning',
        startAt: new Date(Date.now() + 5 * 86400000).toISOString(),
        endAt: new Date(Date.now() + 5 * 86400000 + 3600000).toISOString(),
        timezone: 'UTC',
        isAllDay: false,
        targetCalendarId: collectionUrl(),
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString()
      })
      .run()
    const created = await pushEvent('memry-2')
    const href = created!.remoteEventId

    // Another client edits the description and adds its own property.
    const current = await remoteObject(href)
    const edited = current.body.replace(
      'END:VEVENT',
      'DESCRIPTION:Bring the roadmap\r\nX-OTHER-CLIENT:yes\r\nEND:VEVENT'
    )
    const put = await server.request(new URL(href).pathname, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/calendar', 'If-Match': current.etag ?? '*' },
      body: edited
    })
    expect([201, 204]).toContain(put.status)

    dbResult.db
      .update(calendarEvents)
      .set({ title: 'Planning (Q4)' })
      .where(eq(calendarEvents.id, 'memry-2'))
      .run()
    writes.length = 0
    const binding = await pushEvent('memry-2')

    expect(writes.map((write) => write.ifMatch)).toEqual([
      created!.remoteVersion,
      expect.any(String)
    ])
    const final = await remoteObject(href)
    expect(final.body).toContain('SUMMARY:Planning (Q4)')
    expect(final.body).toContain('Bring the roadmap')
    expect(final.body).toContain('X-OTHER-CLIENT:yes')
    expect(binding!.remoteVersion).toBe(final.etag)
  })

  it('after the CalDAV source is disconnected, no further PUT or DELETE', async () => {
    const bound = dbResult.db
      .select()
      .from(calendarBindings)
      .where(eq(calendarBindings.sourceId, 'memry-2'))
      .get()!
    await disconnectCaldavAccount(db)
    writes.length = 0

    dbResult.db
      .update(calendarEvents)
      .set({ title: 'Edited after disconnect' })
      .where(eq(calendarEvents.id, 'memry-2'))
      .run()
    expect(await pushEvent('memry-2')).toBeNull()
    dbResult.db.delete(calendarEvents).where(eq(calendarEvents.id, 'memry-2')).run()
    expect(await pushEvent('memry-2')).toBeNull()

    expect(writes).toEqual([])
    expect((await remoteObject(bound.remoteEventId)).body).toContain('SUMMARY:Planning (Q4)')
  })
})
