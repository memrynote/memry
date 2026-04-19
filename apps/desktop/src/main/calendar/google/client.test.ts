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

vi.mock('../../lib/logger', () => ({
  createLogger: () => loggerMock
}))

import { createGoogleCalendarClient } from './client'
import {
  LEGACY_DEFAULT_ACCOUNT_ID,
  clearGoogleCalendarTokens,
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
          // Memry normalises all-day originalStartTime to a midnight UTC ISO
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
})
