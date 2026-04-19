import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import keytar from 'keytar'

vi.mock('keytar', () => ({
  default: {
    setPassword: vi.fn(),
    getPassword: vi.fn(),
    deletePassword: vi.fn()
  }
}))

const mockOpenExternal = vi.fn()

vi.mock('electron', () => ({
  shell: {
    openExternal: (...args: unknown[]) => mockOpenExternal(...args)
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

import { GOOGLE_CALENDAR_SCOPE, connectGoogleCalendar, disconnectGoogleCalendar } from './oauth'
import {
  LEGACY_DEFAULT_ACCOUNT_ID,
  clearGoogleCalendarTokens,
  getGoogleCalendarTokens,
  hasGoogleCalendarTokens,
  storeGoogleCalendarTokens
} from './keychain'

describe('google calendar oauth', () => {
  const keytarStore = new Map<string, string>()
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
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
  })

  afterEach(async () => {
    delete process.env.GOOGLE_CALENDAR_CLIENT_ID
    vi.unstubAllGlobals()
    await clearGoogleCalendarTokens(LEGACY_DEFAULT_ACCOUNT_ID)
  })

  it('uses a provider-specific loopback OAuth flow with Calendar scopes and stores tokens in a separate device-local keychain', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input)

      if (url === 'https://oauth2.googleapis.com/token') {
        expect(init?.method).toBe('POST')
        const body = String(init?.body)
        expect(body).toContain('code=google-auth-code')
        expect(body).toContain('grant_type=authorization_code')
        expect(body).toContain('code_verifier=')
        return new Response(
          JSON.stringify({
            access_token: 'google-access-token',
            refresh_token: 'google-refresh-token',
            expires_in: 3600,
            scope: `openid email profile ${GOOGLE_CALENDAR_SCOPE}`,
            token_type: 'Bearer'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }

      if (url === 'https://www.googleapis.com/calendar/v3/users/me/calendarList/primary') {
        expect(init?.headers).toEqual(
          expect.objectContaining({
            Authorization: 'Bearer google-access-token'
          })
        )
        return new Response(
          JSON.stringify({
            id: 'user@example.com',
            summary: 'User Example',
            timeZone: 'Europe/Istanbul',
            backgroundColor: '#0ea5e9',
            primary: true
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }

      throw new Error(`Unexpected fetch call: ${url}`)
    })

    mockOpenExternal.mockImplementation(async (authUrl: string) => {
      const parsed = new URL(authUrl)
      expect(parsed.origin).toBe('https://accounts.google.com')
      expect(parsed.pathname).toBe('/o/oauth2/v2/auth')
      expect(parsed.searchParams.get('scope')).toContain(GOOGLE_CALENDAR_SCOPE)
      expect(parsed.searchParams.get('access_type')).toBe('offline')
      expect(parsed.searchParams.get('prompt')).toBe('consent')

      const state = parsed.searchParams.get('state')
      const redirectUri = parsed.searchParams.get('redirect_uri')

      expect(state).toBeTruthy()
      expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)

      setTimeout(() => {
        http.get(`${redirectUri}?code=google-auth-code&state=${state}`)
      }, 0)
    })

    const result = await connectGoogleCalendar()
    const tokens = await getGoogleCalendarTokens(LEGACY_DEFAULT_ACCOUNT_ID)

    expect(result).toEqual({
      account: {
        remoteId: 'user@example.com',
        title: 'User Example',
        timezone: 'Europe/Istanbul'
      },
      primaryCalendar: {
        remoteId: 'user@example.com',
        title: 'User Example',
        timezone: 'Europe/Istanbul',
        color: '#0ea5e9',
        isPrimary: true
      }
    })
    expect(tokens).toEqual({
      accessToken: 'google-access-token',
      refreshToken: 'google-refresh-token'
    })
    expect(await hasGoogleCalendarTokens(LEGACY_DEFAULT_ACCOUNT_ID)).toBe(true)
    expect(keytar.setPassword).toHaveBeenCalledWith(
      'com.memry.calendar.google',
      expect.stringContaining('access-token'),
      'google-access-token'
    )
    expect(keytar.setPassword).toHaveBeenCalledWith(
      'com.memry.calendar.google',
      expect.stringContaining('refresh-token'),
      'google-refresh-token'
    )
  })

  it('shows a user-friendly message and logs technical details when token exchange returns 400', async () => {
    // #given
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(
          JSON.stringify({
            error: 'invalid_grant',
            error_description: 'Malformed auth code.'
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
      }
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    mockOpenExternal.mockImplementation(async (authUrl: string) => {
      const parsed = new URL(authUrl)
      const redirectUri = parsed.searchParams.get('redirect_uri')
      const state = parsed.searchParams.get('state')

      setTimeout(() => {
        http.get(`${redirectUri}?code=google-auth-code&state=${state}`)
      }, 0)
    })

    // #when
    let caught: Error | null = null
    try {
      await connectGoogleCalendar()
    } catch (err) {
      caught = err as Error
    }

    // #then — user-facing message is friendly and actionable, not technical
    expect(caught).not.toBeNull()
    expect(caught?.message).not.toMatch(/\b400\b/)
    expect(caught?.message).not.toContain('invalid_grant')
    expect(caught?.message.toLowerCase()).toMatch(/connect(ion)?.*(again|expired)/)

    // #then — technical detail is preserved in the log for developers
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Google Calendar token exchange failed',
      expect.objectContaining({
        status: 400,
        error: 'invalid_grant',
        errorDescription: 'Malformed auth code.'
      })
    )

    expect(await hasGoogleCalendarTokens(LEGACY_DEFAULT_ACCOUNT_ID)).toBe(false)
  })

  it('rejects the callback when the OAuth state does not match', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'should-not-happen' }), { status: 500 })
    )

    mockOpenExternal.mockImplementation(async (authUrl: string) => {
      const parsed = new URL(authUrl)
      const redirectUri = parsed.searchParams.get('redirect_uri')

      setTimeout(() => {
        http.get(`${redirectUri}?code=google-auth-code&state=wrong-state`)
      }, 0)
    })

    await expect(connectGoogleCalendar()).rejects.toThrow(
      'Invalid or expired Google Calendar OAuth state'
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await hasGoogleCalendarTokens(LEGACY_DEFAULT_ACCOUNT_ID)).toBe(false)
  })

  it('stores and clears Google Calendar tokens independently from sync auth keychain entries', async () => {
    await storeGoogleCalendarTokens({
      accountId: LEGACY_DEFAULT_ACCOUNT_ID,
      accessToken: 'manual-access-token',
      refreshToken: 'manual-refresh-token'
    })

    expect(await hasGoogleCalendarTokens(LEGACY_DEFAULT_ACCOUNT_ID)).toBe(true)
    expect(await getGoogleCalendarTokens(LEGACY_DEFAULT_ACCOUNT_ID)).toEqual({
      accessToken: 'manual-access-token',
      refreshToken: 'manual-refresh-token'
    })

    await disconnectGoogleCalendar()

    expect(await getGoogleCalendarTokens(LEGACY_DEFAULT_ACCOUNT_ID)).toEqual({
      accessToken: null,
      refreshToken: null
    })
    expect(keytar.deletePassword).toHaveBeenCalledWith(
      'com.memry.calendar.google',
      expect.stringContaining('access-token')
    )
    expect(keytar.deletePassword).toHaveBeenCalledWith(
      'com.memry.calendar.google',
      expect.stringContaining('refresh-token')
    )
  })
})
