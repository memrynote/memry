import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import keytar from 'keytar'
import { eq } from 'drizzle-orm'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { FakeCaldavServer, vevent } from '@tests/utils/fake-caldav-server'
import type { DataDb } from '../../database'
import { ProviderAuthError } from '../provider/errors'
import { caldavCalendarSourceId, hasCaldavLocalAuth } from './caldav-accounts'
import { CaldavConnectError, connectCaldavAccount, disconnectCaldavAccount } from './caldav-connect'
import { syncCaldavCalendarSource, syncCaldavNow } from './caldav-sync'

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

import { enqueueLocalSyncDelete } from '../../sync/local-mutations'

const NOW = new Date('2026-09-24T08:00:00.000Z')
const WORK = '/me/calendars/work/'
const TASKS = '/me/calendars/tasks/'

function iCloudLike(overrides: Partial<ConstructorParameters<typeof FakeCaldavServer>[0]> = {}) {
  return new FakeCaldavServer({
    host: 'caldav.icloud.com',
    partitionHost: 'p67-caldav.icloud.com',
    username: 'me',
    password: 'app-password',
    calendars: [
      { path: WORK, displayName: 'Work', color: '#FF2968FF' },
      { path: TASKS, displayName: 'Reminders', components: ['VTODO'] }
    ],
    ...overrides
  })
}

describe('CalDAV read adapter against a recorded fixture server (#1399)', () => {
  let dbResult: TestDatabaseResult
  let db: DataDb
  const secrets = new Map<string, string>()

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db as unknown as DataDb
    secrets.clear()
    vi.mocked(enqueueLocalSyncDelete).mockClear()
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

  async function connect(server: FakeCaldavServer): Promise<string> {
    await connectCaldavAccount(
      db,
      { serverUrl: server.options.host, username: 'me', password: 'app-password' },
      { fetchImpl: server.fetch }
    )
    return caldavCalendarSourceId(server.collectionUrl(WORK))
  }

  function rows(sourceId: string) {
    return dbResult.db
      .select()
      .from(calendarExternalEvents)
      .where(eq(calendarExternalEvents.sourceId, sourceId))
      .all()
      .sort((left, right) => left.remoteEventId.localeCompare(right.remoteEventId))
  }

  it('discovers through a redirect to the partition host and keeps event calendars only', async () => {
    const server = iCloudLike()
    const sourceId = await connect(server)

    const sources = dbResult.db.select().from(calendarSources).all()
    expect(sources.map((source) => [source.kind, source.title]).sort()).toEqual([
      ['account', 'me'],
      ['calendar', 'Work']
    ])
    const work = sources.find((source) => source.id === sourceId)
    expect(work).toMatchObject({
      provider: 'caldav',
      remoteId: 'https://p67-caldav.icloud.com/me/calendars/work/',
      color: '#ff2968',
      isSelected: true
    })
    expect(
      server.requests.some((request) => request.url.startsWith('https://p67-caldav.icloud.com/'))
    ).toBe(true)
    // The password is on this device only; nothing synced carries it.
    expect(JSON.stringify(sources)).not.toContain('app-password')
    expect([...secrets.keys()]).toEqual([
      expect.stringMatching(/^com\.memry\.calendar\.caldav:password-caldav-/)
    ])
  })

  it('never sends credentials to a host outside the account’s scope', async () => {
    const server = iCloudLike({ wellKnownRedirectHost: 'evil.example.net' })
    await connect(server)

    const toEvil = server.requests.filter((request) => request.url.includes('evil.example.net'))
    expect(toEvil.length).toBeGreaterThan(0)
    expect(toEvil.every((request) => request.authorization === null)).toBe(true)
  })

  it('reports a rejected password as unauthorized, saving nothing', async () => {
    const server = iCloudLike()
    await expect(
      connectCaldavAccount(
        db,
        { serverUrl: server.options.host, username: 'me', password: 'my-apple-id-password' },
        { fetchImpl: server.fetch }
      )
    ).rejects.toMatchObject({ code: 'unauthorized' } satisfies Partial<CaldavConnectError>)
    expect(dbResult.db.select().from(calendarSources).all()).toEqual([])
    expect(secrets.size).toBe(0)
  })

  it('connects to a Digest-only server', async () => {
    const server = iCloudLike({
      host: 'dav.example.org',
      partitionHost: undefined,
      digestOnly: true
    })
    await connect(server)
    expect(server.requests.some((request) => request.authorization?.startsWith('Digest '))).toBe(
      true
    )
  })

  describe('sync-token path', () => {
    it('pulls in full first, then only what changed; a changed and a deleted href replace and remove exactly their instances', async () => {
      const server = iCloudLike()
      server.putObject(
        WORK,
        'standup.ics',
        vevent({
          uid: 'standup',
          summary: 'Standup',
          start: '20260925T090000Z',
          end: '20260925T093000Z',
          rrule: 'FREQ=DAILY;COUNT=3'
        })
      )
      server.putObject(
        WORK,
        'dentist.ics',
        vevent({
          uid: 'dentist',
          summary: 'Dentist',
          start: '20260926T140000Z',
          end: '20260926T150000Z'
        })
      )
      server.putObject(
        WORK,
        'lunch.ics',
        vevent({
          uid: 'lunch',
          summary: 'Lunch',
          start: '20260927T120000Z',
          end: '20260927T130000Z'
        })
      )
      const sourceId = await connect(server)

      const first = await syncCaldavCalendarSource(db, sourceId, {
        fetchImpl: server.fetch,
        now: () => NOW
      })
      expect(first.mode).toBe('full')
      const standupHref = server.objectUrl(WORK, 'standup.ics')
      expect(rows(sourceId).map((row) => row.remoteEventId)).toEqual([
        server.objectUrl(WORK, 'dentist.ics'),
        server.objectUrl(WORK, 'lunch.ics'),
        `${standupHref}::2026-09-25T09:00:00.000Z`,
        `${standupHref}::2026-09-26T09:00:00.000Z`,
        `${standupHref}::2026-09-27T09:00:00.000Z`
      ])
      const lunchBefore = rows(sourceId).find((row) => row.title === 'Lunch')!
      expect(
        dbResult.db.select().from(calendarSources).where(eq(calendarSources.id, sourceId)).get()
          ?.syncCursor
      ).toMatch(/^sync-token:/)

      server.putObject(
        WORK,
        'standup.ics',
        vevent({
          uid: 'standup',
          summary: 'Standup (moved)',
          start: '20260925T100000Z',
          end: '20260925T103000Z',
          rrule: 'FREQ=DAILY;COUNT=2'
        })
      )
      server.deleteObject(WORK, 'dentist.ics')
      server.requests.length = 0

      const second = await syncCaldavCalendarSource(db, sourceId, {
        fetchImpl: server.fetch,
        now: () => NOW
      })

      expect(second.mode).toBe('sync-token')
      expect(server.requests.some((request) => request.body.includes('calendar-query'))).toBe(false)
      expect(rows(sourceId).map((row) => [row.remoteEventId, row.title])).toEqual([
        [server.objectUrl(WORK, 'lunch.ics'), 'Lunch'],
        [`${standupHref}::2026-09-25T10:00:00.000Z`, 'Standup (moved)'],
        [`${standupHref}::2026-09-26T10:00:00.000Z`, 'Standup (moved)']
      ])
      // The untouched object's row was not rewritten.
      expect(rows(sourceId).find((row) => row.title === 'Lunch')).toEqual(lunchBefore)
      expect(vi.mocked(enqueueLocalSyncDelete).mock.calls.map((call) => call[0])).toContain(
        'calendar_external_event'
      )
      // The whole object is kept once per object, for write-back.
      const withIcal = rows(sourceId).filter(
        (row) => (row.rawPayload as { ical?: string } | null)?.ical
      )
      expect(withIcal.map((row) => row.title).sort()).toEqual(['Lunch', 'Standup (moved)'])
    })

    it('an invalid sync token clears the cursor and pulls in full (ProviderGoneError)', async () => {
      const server = iCloudLike()
      server.putObject(WORK, 'a.ics', vevent({ uid: 'a', summary: 'A', start: '20260925T090000Z' }))
      const sourceId = await connect(server)
      await syncCaldavCalendarSource(db, sourceId, { fetchImpl: server.fetch, now: () => NOW })

      server.putObject(WORK, 'b.ics', vevent({ uid: 'b', summary: 'B', start: '20260926T090000Z' }))
      server.invalidateSyncTokens()

      const result = await syncCaldavCalendarSource(db, sourceId, {
        fetchImpl: server.fetch,
        now: () => NOW
      })

      expect(result.mode).toBe('full')
      expect(rows(sourceId).map((row) => row.title)).toEqual(['A', 'B'])
      expect(
        dbResult.db.select().from(calendarSources).where(eq(calendarSources.id, sourceId)).get()
      ).toMatchObject({ syncStatus: 'ok', syncCursor: expect.stringMatching(/^sync-token:/) })
    })
  })

  describe('ctag fallback path', () => {
    it('diffs ETags when the collection has no sync-collection, and skips work when the ctag is unchanged', async () => {
      const server = iCloudLike({
        host: 'dav.example.org',
        partitionHost: undefined,
        calendars: [{ path: WORK, displayName: 'Work', supportsSyncCollection: false }]
      })
      server.putObject(WORK, 'a.ics', vevent({ uid: 'a', summary: 'A', start: '20260925T090000Z' }))
      server.putObject(WORK, 'b.ics', vevent({ uid: 'b', summary: 'B', start: '20260926T090000Z' }))
      const sourceId = await connect(server)

      expect(
        (await syncCaldavCalendarSource(db, sourceId, { fetchImpl: server.fetch, now: () => NOW }))
          .mode
      ).toBe('full')
      expect(
        dbResult.db.select().from(calendarSources).where(eq(calendarSources.id, sourceId)).get()
          ?.syncCursor
      ).toMatch(/^ctag:/)
      expect(
        (await syncCaldavCalendarSource(db, sourceId, { fetchImpl: server.fetch, now: () => NOW }))
          .mode
      ).toBe('unchanged')

      server.putObject(
        WORK,
        'a.ics',
        vevent({ uid: 'a', summary: 'A2', start: '20260925T090000Z' })
      )
      server.deleteObject(WORK, 'b.ics')
      const result = await syncCaldavCalendarSource(db, sourceId, {
        fetchImpl: server.fetch,
        now: () => NOW
      })

      expect(result.mode).toBe('ctag')
      expect(rows(sourceId).map((row) => row.title)).toEqual(['A2'])
    })
  })

  it('a revoked app password marks the account reconnect_required on this device and stops the pass', async () => {
    const server = iCloudLike()
    const sourceId = await connect(server)
    const accountId = dbResult.db
      .select()
      .from(calendarSources)
      .where(eq(calendarSources.id, sourceId))
      .get()!.accountId!
    await syncCaldavCalendarSource(db, sourceId, { fetchImpl: server.fetch, now: () => NOW })
    expect(await hasCaldavLocalAuth(db, accountId)).toBe(true)

    server.revokePassword()

    await expect(
      syncCaldavCalendarSource(db, sourceId, { fetchImpl: server.fetch, now: () => NOW })
    ).rejects.toBeInstanceOf(ProviderAuthError)
    expect(await hasCaldavLocalAuth(db, accountId)).toBe(false)
    expect(
      dbResult.db.select().from(calendarSources).where(eq(calendarSources.id, sourceId)).get()
    ).toMatchObject({ syncStatus: 'error', lastError: 'reconnect_required' })
  })

  it('a device without the password never pulls, and disconnect forgets the password and the events', async () => {
    const server = iCloudLike()
    server.putObject(WORK, 'a.ics', vevent({ uid: 'a', summary: 'A', start: '20260925T090000Z' }))
    const sourceId = await connect(server)
    await syncCaldavNow(db, { fetchImpl: server.fetch, now: () => NOW })
    expect(rows(sourceId)).toHaveLength(1)

    await disconnectCaldavAccount(db)
    expect(secrets.size).toBe(0)
    expect(rows(sourceId)).toHaveLength(0)
    server.requests.length = 0
    expect(await syncCaldavNow(db, { fetchImpl: server.fetch, now: () => NOW })).toEqual({
      synced: 0,
      failed: 0
    })
    expect(server.requests).toEqual([])
  })
})
