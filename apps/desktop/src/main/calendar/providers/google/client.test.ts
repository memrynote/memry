import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import keytar from 'keytar'

vi.mock('keytar', () => ({
  default: {
    setPassword: vi.fn(),
    getPassword: vi.fn(),
    deletePassword: vi.fn()
  }
}))

vi.mock('electron', () => ({
  shell: {
    openExternal: vi.fn()
  }
}))

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}))

vi.mock('../../../lib/logger', () => ({
  createLogger: () => loggerMock
}))

// oauth-errors resolves its copy through the main-process i18n singleton, which
// only exists after setMainI18n() during app boot. Without this, every mapped
// API/token failure below throws 'main-process i18n not initialized' instead of
// the mapped message — and throwCalendarApiFailure never attaches
// error.status / error.apiStatus.
vi.mock('../../../lib/main-i18n', () => ({
  getMainI18n: () => ({
    t: (key: string) => key,
    getFixedT: () => (key: string) => key
  })
}))

import { createGoogleCalendarClient } from './client'
import {
  LEGACY_DEFAULT_ACCOUNT_ID,
  clearGoogleCalendarTokens,
  getGoogleCalendarTokens,
  storeGoogleCalendarTokens
} from './keychain'

describe('google calendar client — push channels (Task 7)', () => {
  const keytarStore = new Map<string, string>()
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(async () => {
    vi.clearAllMocks()
    keytarStore.clear()
    process.env.GOOGLE_CALENDAR_CLIENT_ID = 'google-client-id-123'
    vi.stubGlobal('fetch', fetchMock)

    vi.mocked(keytar.setPassword).mockImplementation(async (service, account, value) => {
      keytarStore.set(`${service}:${account}`, value)
    })
    vi.mocked(keytar.getPassword).mockImplementation(async (service, account) => {
      return keytarStore.get(`${service}:${account}`) ?? null
    })
    vi.mocked(keytar.deletePassword).mockImplementation(async (service, account) => {
      keytarStore.delete(`${service}:${account}`)
      return true
    })

    await storeGoogleCalendarTokens({
      accountId: LEGACY_DEFAULT_ACCOUNT_ID,
      accessToken: 'seeded-access-token',
      refreshToken: 'seeded-refresh-token'
    })
  })

  afterEach(async () => {
    delete process.env.GOOGLE_CALENDAR_CLIENT_ID
    vi.unstubAllGlobals()
    await clearGoogleCalendarTokens(LEGACY_DEFAULT_ACCOUNT_ID)
  })

  describe('watchCalendar', () => {
    it('POSTs events.watch with id/token/type/address/expiration and returns resourceId + expiration', async () => {
      const nowMs = 1_700_000_000_000
      vi.spyOn(Date, 'now').mockReturnValue(nowMs)

      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input)
        expect(url).toBe(
          'https://www.googleapis.com/calendar/v3/calendars/primary%40group.calendar.google.com/events/watch'
        )
        expect(init?.method).toBe('POST')
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          'Bearer seeded-access-token'
        )
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect(body).toEqual({
          id: 'channel-abc',
          token: 'plaintext-secret-xyz',
          type: 'web_hook',
          address: 'https://sync.memry.io/webhooks/google-calendar',
          expiration: String(nowMs + 7 * 24 * 60 * 60 * 1000)
        })
        return new Response(
          JSON.stringify({
            kind: 'api#channel',
            id: 'channel-abc',
            resourceId: 'resource-123',
            resourceUri: 'https://www.googleapis.com/calendar/v3/calendars/primary/events?alt=json',
            expiration: String(nowMs + 7 * 24 * 60 * 60 * 1000)
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })

      const client = createGoogleCalendarClient({ accountId: LEGACY_DEFAULT_ACCOUNT_ID })
      const result = await client.watchCalendar({
        calendarId: 'primary@group.calendar.google.com',
        channelId: 'channel-abc',
        token: 'plaintext-secret-xyz',
        webhookUrl: 'https://sync.memry.io/webhooks/google-calendar',
        ttlSeconds: 7 * 24 * 60 * 60
      })

      expect(result).toEqual({
        resourceId: 'resource-123',
        expiration: nowMs + 7 * 24 * 60 * 60 * 1000
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('throws a user-facing error when Google rejects the watch request', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { status: 'PERMISSION_DENIED', message: 'webhook domain not verified' }
          }),
          { status: 403 }
        )
      )

      const client = createGoogleCalendarClient({ accountId: LEGACY_DEFAULT_ACCOUNT_ID })
      await expect(
        client.watchCalendar({
          calendarId: 'primary',
          channelId: 'c1',
          token: 't1',
          webhookUrl: 'https://sync.memry.io/webhooks/google-calendar',
          ttlSeconds: 3600
        })
      ).rejects.toThrow()
    })
  })

  describe('stopChannel', () => {
    it('POSTs channels.stop with {id, resourceId} and resolves on 204', async () => {
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input)
        expect(url).toBe('https://www.googleapis.com/calendar/v3/channels/stop')
        expect(init?.method).toBe('POST')
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect(body).toEqual({ id: 'channel-abc', resourceId: 'resource-123' })
        return new Response(null, { status: 204 })
      })

      const client = createGoogleCalendarClient({ accountId: LEGACY_DEFAULT_ACCOUNT_ID })
      await expect(
        client.stopChannel({ channelId: 'channel-abc', resourceId: 'resource-123' })
      ).resolves.toBeUndefined()
    })

    it('tolerates 404 without throwing (channel already stale on Google side)', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({ error: { status: 'NOT_FOUND', message: 'channel not found' } }),
          { status: 404 }
        )
      )

      const client = createGoogleCalendarClient({ accountId: LEGACY_DEFAULT_ACCOUNT_ID })
      await expect(
        client.stopChannel({ channelId: 'stale', resourceId: 'stale-resource' })
      ).resolves.toBeUndefined()
    })

    it('throws for non-404 errors (e.g. 500)', async () => {
      fetchMock.mockResolvedValue(new Response('oops', { status: 500 }))

      const client = createGoogleCalendarClient({ accountId: LEGACY_DEFAULT_ACCOUNT_ID })
      await expect(client.stopChannel({ channelId: 'c', resourceId: 'r' })).rejects.toThrow()
    })
  })

  describe('upsertEvent — recurring single-instance exceptions (M5)', () => {
    function buildOkResponse(): Response {
      return new Response(
        JSON.stringify({
          id: 'google-child-1',
          status: 'confirmed',
          summary: 'Exception',
          start: { dateTime: '2026-05-10T10:00:00.000Z', timeZone: 'UTC' },
          end: { dateTime: '2026-05-10T11:00:00.000Z', timeZone: 'UTC' }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    function captureBody(): { body: Record<string, unknown> | null } {
      const captured: { body: Record<string, unknown> | null } = { body: null }
      fetchMock.mockImplementation(async (_input, init) => {
        if (typeof init?.body === 'string') {
          captured.body = JSON.parse(init.body)
        }
        return buildOkResponse()
      })
      return captured
    }

    it('#given an all-day recurring exception #when upserted #then emits originalStartTime as { date } (no dateTime)', async () => {
      const captured = captureBody()

      const client = createGoogleCalendarClient({ accountId: LEGACY_DEFAULT_ACCOUNT_ID })
      await client.upsertEvent({
        calendarId: 'primary',
        eventId: null,
        event: {
          sourceType: 'event',
          sourceId: 'local-all-day-exception',
          title: 'Annual review (moved once)',
          description: null,
          location: null,
          startAt: '2026-05-10',
          endAt: '2026-05-11',
          isAllDay: true,
          timezone: 'UTC',
          recurrence: null,
          recurringEventId: 'google-series-annual',
          // memrynote normalises all-day originalStartTime to a midnight UTC ISO
          // on the read side — the write path must re-extract the date.
          originalStartTime: '2026-05-10T00:00:00.000Z'
        }
      })

      expect(captured.body?.recurringEventId).toBe('google-series-annual')
      expect(captured.body?.originalStartTime).toEqual({ date: '2026-05-10' })
    })

    it('#given a timed recurring exception #when upserted #then emits originalStartTime as { dateTime, timeZone }', async () => {
      const captured = captureBody()

      const client = createGoogleCalendarClient({ accountId: LEGACY_DEFAULT_ACCOUNT_ID })
      await client.upsertEvent({
        calendarId: 'primary',
        eventId: null,
        event: {
          sourceType: 'event',
          sourceId: 'local-timed-exception',
          title: 'Weekly sync (moved once)',
          description: null,
          location: null,
          startAt: '2026-05-10T10:00:00.000Z',
          endAt: '2026-05-10T11:00:00.000Z',
          isAllDay: false,
          timezone: 'UTC',
          recurrence: null,
          recurringEventId: 'google-series-weekly',
          originalStartTime: '2026-05-10T09:00:00.000Z'
        }
      })

      expect(captured.body?.originalStartTime).toEqual({
        dateTime: '2026-05-10T09:00:00.000Z',
        timeZone: 'UTC'
      })
    })
  })

  describe('refresh token handling', () => {
    it('stores a rotated refresh token locally when Google returns one during access-token refresh', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('expired', { status: 401 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              access_token: 'fresh-access-token',
              refresh_token: 'rotated-refresh-token',
              expires_in: 3600,
              token_type: 'Bearer'
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        )

      const client = createGoogleCalendarClient({ accountId: LEGACY_DEFAULT_ACCOUNT_ID })
      await expect(client.listCalendars()).resolves.toEqual([])

      expect(await getGoogleCalendarTokens(LEGACY_DEFAULT_ACCOUNT_ID)).toEqual({
        accessToken: 'fresh-access-token',
        refreshToken: 'rotated-refresh-token'
      })
    })

    it('clears local auth when Google rejects refresh with invalid_grant', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('expired', { status: 401 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: 'invalid_grant',
              error_description: 'Token has been expired or revoked.'
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          )
        )

      const client = createGoogleCalendarClient({ accountId: LEGACY_DEFAULT_ACCOUNT_ID })
      await expect(client.listCalendars()).rejects.toThrow()

      expect(await getGoogleCalendarTokens(LEGACY_DEFAULT_ACCOUNT_ID)).toEqual({
        accessToken: null,
        refreshToken: null
      })
    })
  })

  describe('calendar and event API coverage', () => {
    it('requires a non-empty account id', () => {
      expect(() => createGoogleCalendarClient({ accountId: '   ' })).toThrow(
        'createGoogleCalendarClient requires a non-empty accountId'
      )
    })

    it('maps calendar list defaults and createCalendar request body', async () => {
      fetchMock
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              items: [
                { id: 'primary' },
                {
                  id: 'work',
                  summary: 'Work',
                  timeZone: 'Europe/Istanbul',
                  backgroundColor: '#3367d6',
                  primary: true
                }
              ]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
        .mockImplementationOnce(async (input, init) => {
          expect(String(input)).toBe('https://www.googleapis.com/calendar/v3/calendars')
          expect(init?.method).toBe('POST')
          expect(JSON.parse(String(init?.body))).toEqual({
            summary: 'Team',
            timeZone: 'UTC'
          })
          return new Response(
            JSON.stringify({
              id: 'team',
              summary: 'Team',
              timeZone: 'UTC',
              backgroundColor: '#111111'
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        })

      const client = createGoogleCalendarClient({ accountId: LEGACY_DEFAULT_ACCOUNT_ID })
      await expect(client.listCalendars()).resolves.toEqual([
        {
          id: 'primary',
          title: 'primary',
          timezone: null,
          color: null,
          isPrimary: false
        },
        {
          id: 'work',
          title: 'Work',
          timezone: 'Europe/Istanbul',
          color: '#3367d6',
          isPrimary: true
        }
      ])
      await expect(client.createCalendar({ title: 'Team', timezone: 'UTC' })).resolves.toEqual({
        id: 'team',
        title: 'Team',
        timezone: 'UTC',
        color: '#111111',
        isPrimary: false
      })
    })

    it('maps rich all-day events and switches query shape for sync cursors', async () => {
      fetchMock
        .mockImplementationOnce(async (input) => {
          const url = new URL(String(input))
          expect(url.pathname).toBe('/calendar/v3/calendars/primary/events')
          expect(url.searchParams.get('showDeleted')).toBe('true')
          expect(url.searchParams.get('singleEvents')).toBe('true')
          expect(url.searchParams.get('timeMin')).toBe('2026-05-01T00:00:00.000Z')
          expect(url.searchParams.get('timeMax')).toBe('2026-06-01T00:00:00.000Z')
          expect(url.searchParams.has('syncToken')).toBe(false)
          return new Response(
            JSON.stringify({
              nextSyncToken: 'cursor-2',
              items: [
                {
                  id: 'event-1',
                  status: 'tentative',
                  summary: 'Planning',
                  description: 'Agenda',
                  location: 'HQ',
                  start: { date: '2026-05-10', timeZone: 'Europe/Istanbul' },
                  end: { date: '2026-05-11' },
                  etag: 'etag-1',
                  updated: '2026-05-09T12:00:00.000Z',
                  attendees: [
                    {
                      email: 'alice@example.com',
                      displayName: 'Alice',
                      responseStatus: 'accepted',
                      optional: false,
                      organizer: true,
                      self: true
                    }
                  ],
                  reminders: {
                    useDefault: false,
                    overrides: [{ method: 'popup', minutes: 15 }]
                  },
                  visibility: 'private',
                  colorId: '9',
                  conferenceData: {
                    conferenceId: 'meet-1',
                    conferenceSolution: {
                      key: { type: 'hangoutsMeet' },
                      name: 'Google Meet',
                      iconUri: 'https://meet.google.com/icon'
                    },
                    entryPoints: [
                      {
                        entryPointType: 'video',
                        uri: 'https://meet.google.com/abc-defg-hij',
                        label: 'Meet',
                        pin: '123',
                        meetingCode: 'abc-defg-hij',
                        passcode: 'secret',
                        regionCode: 'US'
                      }
                    ],
                    notes: 'Join early'
                  },
                  recurringEventId: 'series-1',
                  originalStartTime: { date: '2026-05-09' }
                }
              ]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        })
        .mockImplementationOnce(async (input) => {
          const url = new URL(String(input))
          expect(url.searchParams.get('syncToken')).toBe('cursor-2')
          expect(url.searchParams.has('timeMin')).toBe(false)
          expect(url.searchParams.has('timeMax')).toBe(false)
          return new Response(JSON.stringify({ items: [], nextSyncToken: 'cursor-3' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        })

      const client = createGoogleCalendarClient({ accountId: LEGACY_DEFAULT_ACCOUNT_ID })
      const first = await client.listEvents({
        calendarId: 'primary',
        timeMin: '2026-05-01T00:00:00.000Z',
        timeMax: '2026-06-01T00:00:00.000Z',
        syncCursor: null
      })
      expect(first.nextSyncCursor).toBe('cursor-2')
      expect(first.events[0]).toMatchObject({
        id: 'event-1',
        calendarId: 'primary',
        title: 'Planning',
        description: 'Agenda',
        location: 'HQ',
        startAt: '2026-05-10T00:00:00.000Z',
        endAt: '2026-05-11T00:00:00.000Z',
        isAllDay: true,
        timezone: 'Europe/Istanbul',
        status: 'tentative',
        attendees: [
          {
            email: 'alice@example.com',
            displayName: 'Alice',
            responseStatus: 'accepted',
            optional: false,
            organizer: true,
            self: true
          }
        ],
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] },
        visibility: 'private',
        colorId: '9',
        recurringEventId: 'series-1',
        originalStartTime: '2026-05-09T00:00:00.000Z'
      })
      expect(first.events[0].conferenceData).toMatchObject({
        conferenceId: 'meet-1',
        conferenceSolution: {
          key: { type: 'hangoutsMeet' },
          name: 'Google Meet',
          iconUri: 'https://meet.google.com/icon'
        },
        entryPoints: [
          {
            entryPointType: 'video',
            uri: 'https://meet.google.com/abc-defg-hij',
            label: 'Meet',
            pin: '123',
            meetingCode: 'abc-defg-hij',
            passcode: 'secret',
            regionCode: 'US'
          }
        ],
        notes: 'Join early'
      })

      await expect(
        client.listEvents({ calendarId: 'primary', syncCursor: 'cursor-2' })
      ).resolves.toEqual({ events: [], nextSyncCursor: 'cursor-3' })
    })

    it('resets a stale sync cursor on HTTP 410 and fetches individual timed events', async () => {
      fetchMock.mockResolvedValueOnce(new Response('gone', { status: 410 })).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'event-2',
            summary: 'Focus',
            start: { dateTime: '2026-05-10T10:00:00.000Z' },
            end: { dateTime: '2026-05-10T11:00:00.000Z', timeZone: 'UTC' },
            originalStartTime: { dateTime: '2026-05-10T09:00:00.000Z' }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )

      const client = createGoogleCalendarClient({ accountId: LEGACY_DEFAULT_ACCOUNT_ID })
      await expect(
        client.listEvents({ calendarId: 'primary', syncCursor: 'stale-cursor' })
      ).resolves.toEqual({ events: [], nextSyncCursor: null })
      await expect(
        client.getEvent({ calendarId: 'primary', eventId: 'event-2' })
      ).resolves.toMatchObject({
        id: 'event-2',
        title: 'Focus',
        startAt: '2026-05-10T10:00:00.000Z',
        endAt: '2026-05-10T11:00:00.000Z',
        isAllDay: false,
        timezone: 'UTC',
        originalStartTime: '2026-05-10T09:00:00.000Z'
      })
    })

    it('follows nextPageToken across pages and reads the cursor from the final page only', async () => {
      const requested: URL[] = []
      fetchMock
        .mockImplementationOnce(async (input) => {
          requested.push(new URL(String(input)))
          // Google omits nextSyncToken while a nextPageToken exists.
          return new Response(
            JSON.stringify({
              nextPageToken: 'page-2',
              items: [
                {
                  id: 'recurring-instance-1',
                  summary: 'Standup',
                  start: { dateTime: '2026-05-05T09:00:00.000Z' },
                  end: { dateTime: '2026-05-05T09:15:00.000Z' }
                }
              ]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        })
        .mockImplementationOnce(async (input) => {
          requested.push(new URL(String(input)))
          return new Response(
            JSON.stringify({
              nextSyncToken: 'cursor-final',
              items: [
                {
                  id: 'one-off-1',
                  summary: 'Dentist',
                  start: { dateTime: '2026-05-12T14:00:00.000Z' },
                  end: { dateTime: '2026-05-12T15:00:00.000Z' }
                }
              ]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        })

      const client = createGoogleCalendarClient({ accountId: LEGACY_DEFAULT_ACCOUNT_ID })
      const result = await client.listEvents({
        calendarId: 'primary',
        timeMin: '2026-05-01T00:00:00.000Z',
        timeMax: '2026-06-01T00:00:00.000Z',
        syncCursor: null
      })

      expect(result.events.map((event) => event.id)).toEqual(['recurring-instance-1', 'one-off-1'])
      expect(result.nextSyncCursor).toBe('cursor-final')

      expect(requested).toHaveLength(2)
      expect(requested[0]?.searchParams.get('maxResults')).toBe('250')
      expect(requested[0]?.searchParams.has('pageToken')).toBe(false)
      expect(requested[1]?.searchParams.get('pageToken')).toBe('page-2')
      // The window survives across pages.
      expect(requested[1]?.searchParams.get('timeMin')).toBe('2026-05-01T00:00:00.000Z')
      expect(requested[1]?.searchParams.get('timeMax')).toBe('2026-06-01T00:00:00.000Z')
    })

    it('paginates the sync-token branch too, carrying the syncToken on every page', async () => {
      const requested: URL[] = []
      fetchMock
        .mockImplementationOnce(async (input) => {
          requested.push(new URL(String(input)))
          return new Response(
            JSON.stringify({
              nextPageToken: 'delta-page-2',
              items: [{ id: 'delta-1', start: { dateTime: '2026-05-05T09:00:00.000Z' } }]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        })
        .mockImplementationOnce(async (input) => {
          requested.push(new URL(String(input)))
          return new Response(
            JSON.stringify({
              nextSyncToken: 'cursor-delta-final',
              items: [{ id: 'delta-2', start: { dateTime: '2026-05-06T09:00:00.000Z' } }]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        })

      const client = createGoogleCalendarClient({ accountId: LEGACY_DEFAULT_ACCOUNT_ID })
      const result = await client.listEvents({ calendarId: 'primary', syncCursor: 'cursor-1' })

      expect(result.events.map((event) => event.id)).toEqual(['delta-1', 'delta-2'])
      expect(result.nextSyncCursor).toBe('cursor-delta-final')
      expect(requested).toHaveLength(2)
      expect(requested[0]?.searchParams.get('syncToken')).toBe('cursor-1')
      expect(requested[1]?.searchParams.get('syncToken')).toBe('cursor-1')
      expect(requested[1]?.searchParams.get('pageToken')).toBe('delta-page-2')
    })

    it('makes exactly one request when the first page is the last page', async () => {
      const requested: URL[] = []
      fetchMock.mockImplementationOnce(async (input) => {
        requested.push(new URL(String(input)))
        return new Response(
          JSON.stringify({
            nextSyncToken: 'cursor-single',
            items: [{ id: 'only-1', start: { dateTime: '2026-05-05T09:00:00.000Z' } }]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      })

      const client = createGoogleCalendarClient({ accountId: LEGACY_DEFAULT_ACCOUNT_ID })
      const result = await client.listEvents({
        calendarId: 'primary',
        timeMin: '2026-05-01T00:00:00.000Z',
        timeMax: '2026-06-01T00:00:00.000Z',
        syncCursor: null
      })

      expect(result.events.map((event) => event.id)).toEqual(['only-1'])
      expect(result.nextSyncCursor).toBe('cursor-single')
      expect(requested).toHaveLength(1)
      expect(requested[0]?.searchParams.has('pageToken')).toBe(false)
    })

    it('discards partial pages and clears the cursor when Google returns 410 mid-pagination', async () => {
      fetchMock
        .mockImplementationOnce(
          async () =>
            new Response(
              JSON.stringify({
                nextPageToken: 'delta-page-2',
                items: [{ id: 'delta-1', start: { dateTime: '2026-05-05T09:00:00.000Z' } }]
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
        )
        .mockImplementationOnce(async () => new Response('gone', { status: 410 }))

      const client = createGoogleCalendarClient({ accountId: LEGACY_DEFAULT_ACCOUNT_ID })
      await expect(
        client.listEvents({ calendarId: 'primary', syncCursor: 'stale-cursor' })
      ).resolves.toEqual({ events: [], nextSyncCursor: null })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('sends PATCH headers and optional rich event fields on update', async () => {
      let capturedUrl = ''
      let capturedInit: RequestInit | undefined
      fetchMock.mockImplementationOnce(async (input, init) => {
        capturedUrl = String(input)
        capturedInit = init
        return new Response(
          JSON.stringify({
            id: 'google-event-1',
            status: 'confirmed',
            summary: 'Updated',
            start: { dateTime: '2026-05-10T10:00:00.000Z', timeZone: 'UTC' },
            end: { dateTime: '2026-05-10T11:00:00.000Z', timeZone: 'UTC' }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      })

      const client = createGoogleCalendarClient({ accountId: LEGACY_DEFAULT_ACCOUNT_ID })
      await client.upsertEvent({
        calendarId: 'primary',
        eventId: 'google-event-1',
        ifMatch: 'etag-old',
        event: {
          sourceType: 'task',
          sourceId: 'task-1',
          title: 'Updated',
          description: 'Notes',
          location: 'Room',
          startAt: '2026-05-10T10:00:00.000Z',
          endAt: null,
          isAllDay: false,
          timezone: 'UTC',
          recurrence: ['RRULE:FREQ=WEEKLY'],
          attendees: [
            {
              email: 'bob@example.com',
              displayName: 'Bob',
              responseStatus: 'accepted',
              optional: true,
              organizer: false,
              self: false
            }
          ],
          reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 30 }] },
          visibility: 'public',
          colorId: '5',
          recurringEventId: null,
          originalStartTime: null
        }
      })

      expect(capturedUrl).toBe(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events/google-event-1'
      )
      expect(capturedInit?.method).toBe('PATCH')
      expect((capturedInit?.headers as Record<string, string>)['If-Match']).toBe('etag-old')
      expect(JSON.parse(String(capturedInit?.body))).toMatchObject({
        summary: 'Updated',
        description: 'Notes',
        location: 'Room',
        end: { dateTime: '2026-05-10T10:00:00.000Z', timeZone: 'UTC' },
        recurrence: ['RRULE:FREQ=WEEKLY'],
        attendees: [
          {
            email: 'bob@example.com',
            displayName: 'Bob',
            responseStatus: 'accepted',
            optional: true,
            organizer: false,
            self: false
          }
        ],
        reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 30 }] },
        visibility: 'public',
        colorId: '5',
        extendedProperties: {
          private: {
            memrySourceType: 'task',
            memrySourceId: 'task-1'
          }
        }
      })
    })

    it('covers delete tolerances and watch expiration fallback', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(new Response('server broke', { status: 500 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: 'channel-1',
              resourceId: 'resource-1',
              expiration: 'not-a-number'
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )

      const beforeWatch = Date.now()
      const client = createGoogleCalendarClient({ accountId: LEGACY_DEFAULT_ACCOUNT_ID })
      await expect(
        client.deleteEvent({ calendarId: 'primary', eventId: 'already-deleted' })
      ).resolves.toBeUndefined()
      await expect(
        client.deleteEvent({ calendarId: 'primary', eventId: 'broken' })
      ).rejects.toThrow()
      const watched = await client.watchCalendar({
        calendarId: 'primary',
        channelId: 'channel-1',
        token: 'token-1',
        webhookUrl: 'https://sync.memry.io/webhooks/google-calendar',
        ttlSeconds: 60
      })
      const afterWatch = Date.now()
      expect(watched.resourceId).toBe('resource-1')
      expect(watched.expiration).toBeGreaterThanOrEqual(beforeWatch + 60_000)
      expect(watched.expiration).toBeLessThanOrEqual(afterWatch + 60_000)
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(loggerMock.error).toHaveBeenCalled()
    })
  })
})
