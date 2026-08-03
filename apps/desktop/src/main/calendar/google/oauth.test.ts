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

const { mockListCalendarSources } = vi.hoisted(() => ({
  mockListCalendarSources: vi.fn()
}))

vi.mock('../repositories/calendar-sources-repository', () => ({
  listCalendarSources: (...args: unknown[]) => mockListCalendarSources(...args)
}))

// oauth-errors resolves its copy through the main-process i18n singleton, which
// only exists after setMainI18n() during app boot. Echo the key back so the
// assertions below pin the chosen message, not one locale's wording.
vi.mock('../../lib/main-i18n', () => ({
  getMainI18n: () => ({
    t: (key: string) => key,
    getFixedT: () => (key: string) => key
  })
}))

import {
  GOOGLE_CALENDAR_SCOPE,
  buildGoogleCalendarAuthUrl,
  connectGoogleCalendar,
  disconnectGoogleCalendar,
  hasAnyGoogleCalendarLocalAuth,
  hasGoogleCalendarConnection,
  hasGoogleCalendarLocalAuth,
  listGoogleAccountIds,
  resetGoogleCalendarOAuthState,
  resolveDefaultGoogleAccountId
} from './oauth'
import { isExpectedConditionError } from '../../telemetry/expected-conditions'
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
    delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET
    vi.stubGlobal('fetch', fetchMock)
    mockListCalendarSources.mockReset()

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

      if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') {
        expect(init?.headers).toEqual(
          expect.objectContaining({
            Authorization: 'Bearer google-access-token'
          })
        )
        return new Response(
          JSON.stringify({
            email: 'user@example.com',
            verified_email: true,
            name: 'User Example',
            picture: 'https://example.com/avatar.png'
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
    const tokens = await getGoogleCalendarTokens('user@example.com')

    expect(result).toEqual({
      accountId: 'user@example.com',
      account: {
        remoteId: 'user@example.com',
        email: 'user@example.com',
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
    expect(await hasGoogleCalendarTokens('user@example.com')).toBe(true)
    expect(keytar.setPassword).toHaveBeenCalledWith(
      'com.memry.calendar.google',
      expect.stringContaining('user@example.com'),
      'google-access-token'
    )
    expect(keytar.setPassword).toHaveBeenCalledWith(
      'com.memry.calendar.google',
      expect.stringContaining('user@example.com'),
      'google-refresh-token'
    )
  })

  it('builds the Google consent URL with identity, calendar, and PKCE parameters', () => {
    const authUrl = buildGoogleCalendarAuthUrl({
      clientId: 'client-id',
      redirectUri: 'http://127.0.0.1:1234/callback',
      state: 'state-123',
      codeChallenge: 'challenge-123'
    })

    const parsed = new URL(authUrl)

    expect(parsed.origin).toBe('https://accounts.google.com')
    expect(parsed.searchParams.get('client_id')).toBe('client-id')
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1234/callback')
    expect(parsed.searchParams.get('response_type')).toBe('code')
    expect(parsed.searchParams.get('scope')).toBe(`openid email profile ${GOOGLE_CALENDAR_SCOPE}`)
    expect(parsed.searchParams.get('state')).toBe('state-123')
    expect(parsed.searchParams.get('access_type')).toBe('offline')
    expect(parsed.searchParams.get('prompt')).toBe('consent')
    expect(parsed.searchParams.get('include_granted_scopes')).toBe('true')
    expect(parsed.searchParams.get('code_challenge')).toBe('challenge-123')
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('rejects provider error and malformed callback responses before token exchange', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ should: 'not-run' }), { status: 500 })
    )

    mockOpenExternal.mockImplementationOnce(async (authUrl: string) => {
      const parsed = new URL(authUrl)
      const redirectUri = parsed.searchParams.get('redirect_uri')
      const state = parsed.searchParams.get('state')
      setTimeout(() => {
        http.get(`${redirectUri}?error=access_denied&state=${state}`)
      }, 0)
    })

    await expect(connectGoogleCalendar()).rejects.toThrow(
      'Google Calendar OAuth failed: access_denied'
    )

    mockOpenExternal.mockImplementationOnce(async (authUrl: string) => {
      const parsed = new URL(authUrl)
      const redirectUri = parsed.searchParams.get('redirect_uri')
      const state = parsed.searchParams.get('state')
      setTimeout(() => {
        http.get(`${redirectUri}?state=${state}`)
      }, 0)
    })

    await expect(connectGoogleCalendar()).rejects.toThrow(
      'Google Calendar OAuth callback missing code or state'
    )
    expect(fetchMock).not.toHaveBeenCalled()
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

    // #then — user-facing message is the friendly, actionable localized copy
    // (asserted by key), never the technical provider detail
    expect(caught).not.toBeNull()
    expect(caught?.message).not.toMatch(/\b400\b/)
    expect(caught?.message).not.toContain('invalid_grant')
    expect(caught?.message).toBe('googleCalendar.reconnectNeeded')

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

  it('uses an existing refresh token and fallback calendar metadata when Google omits optional fields', async () => {
    await storeGoogleCalendarTokens({
      accountId: 'reuse@example.com',
      accessToken: 'old-access',
      refreshToken: 'old-refresh'
    })

    fetchMock.mockImplementation(async (input) => {
      const url = String(input)

      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(
          JSON.stringify({
            access_token: 'new-access',
            expires_in: 3600,
            scope: GOOGLE_CALENDAR_SCOPE,
            token_type: 'Bearer'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }

      if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') {
        return new Response(JSON.stringify({ email: 'reuse@example.com' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }

      if (url === 'https://www.googleapis.com/calendar/v3/users/me/calendarList/primary') {
        return new Response(JSON.stringify({ id: 'primary-calendar' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
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

    const result = await connectGoogleCalendar()

    expect(result).toEqual({
      accountId: 'reuse@example.com',
      account: {
        remoteId: 'primary-calendar',
        email: 'reuse@example.com',
        title: 'primary-calendar',
        timezone: null
      },
      primaryCalendar: {
        remoteId: 'primary-calendar',
        title: 'primary-calendar',
        timezone: null,
        color: null,
        isPrimary: true
      }
    })
    expect(await getGoogleCalendarTokens('reuse@example.com')).toEqual({
      accessToken: 'new-access',
      refreshToken: 'old-refresh'
    })
  })

  it('rejects missing Calendar scope and missing refresh token before storing credentials', async () => {
    fetchMock.mockImplementationOnce(async () => {
      return new Response(
        JSON.stringify({
          access_token: 'no-calendar-access',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          scope: 'openid email profile',
          token_type: 'Bearer'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })

    mockOpenExternal.mockImplementationOnce(async (authUrl: string) => {
      const parsed = new URL(authUrl)
      const redirectUri = parsed.searchParams.get('redirect_uri')
      const state = parsed.searchParams.get('state')
      setTimeout(() => {
        http.get(`${redirectUri}?code=google-auth-code&state=${state}`)
      }, 0)
    })

    await expect(connectGoogleCalendar()).rejects.toThrow('googleCalendar.scopeMissing')

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'missing-refresh-access',
            expires_in: 3600,
            scope: GOOGLE_CALENDAR_SCOPE,
            token_type: 'Bearer'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ email: 'missing-refresh@example.com' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )

    mockOpenExternal.mockImplementationOnce(async (authUrl: string) => {
      const parsed = new URL(authUrl)
      const redirectUri = parsed.searchParams.get('redirect_uri')
      const state = parsed.searchParams.get('state')
      setTimeout(() => {
        http.get(`${redirectUri}?code=google-auth-code&state=${state}`)
      }, 0)
    })

    await expect(connectGoogleCalendar()).rejects.toThrow(
      'Google Calendar OAuth did not return a refresh token'
    )
    expect(await hasGoogleCalendarTokens('missing-refresh@example.com')).toBe(false)
  })

  it('maps Google metadata API failures to user-facing calendar errors', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'api-error-access',
            refresh_token: 'api-error-refresh',
            expires_in: 3600,
            scope: GOOGLE_CALENDAR_SCOPE,
            token_type: 'Bearer'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        })
      )

    mockOpenExternal.mockImplementation(async (authUrl: string) => {
      const parsed = new URL(authUrl)
      const redirectUri = parsed.searchParams.get('redirect_uri')
      const state = parsed.searchParams.get('state')
      setTimeout(() => {
        http.get(`${redirectUri}?code=google-auth-code&state=${state}`)
      }, 0)
    })

    await expect(connectGoogleCalendar()).rejects.toThrow('googleCalendar.scopeMissing')
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Failed to fetch Google userinfo',
      expect.objectContaining({ status: 403, apiStatus: 'PERMISSION_DENIED' })
    )
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
    fetchMock.mockImplementation(async () => new Response('', { status: 200 }))

    await storeGoogleCalendarTokens({
      accountId: 'manual@example.com',
      accessToken: 'manual-access-token',
      refreshToken: 'manual-refresh-token'
    })

    expect(await hasGoogleCalendarTokens('manual@example.com')).toBe(true)
    expect(await getGoogleCalendarTokens('manual@example.com')).toEqual({
      accessToken: 'manual-access-token',
      refreshToken: 'manual-refresh-token'
    })

    await disconnectGoogleCalendar('manual@example.com')

    expect(await getGoogleCalendarTokens('manual@example.com')).toEqual({
      accessToken: null,
      refreshToken: null
    })
    expect(keytar.deletePassword).toHaveBeenCalledWith(
      'com.memry.calendar.google',
      expect.stringContaining('manual@example.com')
    )
  })

  it('clears local Google tokens even when token revocation fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'))

    await storeGoogleCalendarTokens({
      accountId: 'revoke@example.com',
      accessToken: 'revoke-access',
      refreshToken: 'revoke-refresh'
    })

    await disconnectGoogleCalendar('revoke@example.com')

    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Failed to revoke Google Calendar token (non-blocking)',
      expect.objectContaining({ accountId: 'revoke@example.com' })
    )
    expect(await getGoogleCalendarTokens('revoke@example.com')).toEqual({
      accessToken: null,
      refreshToken: null
    })
  })

  it('connecting a second Google account stores tokens under a distinct accountId without overwriting the first', async () => {
    let userInfoCalls = 0
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)

      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(
          JSON.stringify({
            access_token: userInfoCalls === 0 ? 'first-access' : 'second-access',
            refresh_token: userInfoCalls === 0 ? 'first-refresh' : 'second-refresh',
            expires_in: 3600,
            scope: `openid email profile ${GOOGLE_CALENDAR_SCOPE}`,
            token_type: 'Bearer'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }

      if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') {
        const email = userInfoCalls === 0 ? 'alice@example.com' : 'bob@example.com'
        userInfoCalls++
        return new Response(
          JSON.stringify({ email, verified_email: true, name: email.split('@')[0] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }

      if (url === 'https://www.googleapis.com/calendar/v3/users/me/calendarList/primary') {
        const email = userInfoCalls === 1 ? 'alice@example.com' : 'bob@example.com'
        return new Response(
          JSON.stringify({
            id: email,
            summary: email,
            timeZone: 'UTC',
            primary: true
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
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

    const first = await connectGoogleCalendar()
    const second = await connectGoogleCalendar()

    expect(first.accountId).toBe('alice@example.com')
    expect(second.accountId).toBe('bob@example.com')

    expect(await getGoogleCalendarTokens('alice@example.com')).toEqual({
      accessToken: 'first-access',
      refreshToken: 'first-refresh'
    })
    expect(await getGoogleCalendarTokens('bob@example.com')).toEqual({
      accessToken: 'second-access',
      refreshToken: 'second-refresh'
    })

    await disconnectGoogleCalendar('alice@example.com')

    expect(await hasGoogleCalendarTokens('alice@example.com')).toBe(false)
    expect(await hasGoogleCalendarTokens('bob@example.com')).toBe(true)
  })

  it('rejects missing client id before opening the browser', async () => {
    delete process.env.GOOGLE_CALENDAR_CLIENT_ID

    await expect(connectGoogleCalendar()).rejects.toThrow('Missing GOOGLE_CALENDAR_CLIENT_ID')

    expect(mockOpenExternal).not.toHaveBeenCalled()
  })

  it('sends the optional client secret while warning that desktop clients should not need it', async () => {
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = ' desktop-secret '

    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === 'https://oauth2.googleapis.com/token') {
        expect(String(init?.body)).toContain('client_secret=desktop-secret')
        return new Response(
          JSON.stringify({
            access_token: 'secret-access',
            refresh_token: 'secret-refresh',
            expires_in: 3600,
            scope: GOOGLE_CALENDAR_SCOPE,
            token_type: 'Bearer'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') {
        return new Response(JSON.stringify({ email: 'secret@example.com' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url === 'https://www.googleapis.com/calendar/v3/users/me/calendarList/primary') {
        return new Response(JSON.stringify({ id: 'secret@example.com' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
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

    await connectGoogleCalendar()

    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('CLIENT_SECRET'))
  })

  it('logs plain text token errors without leaking provider codes to the user message', async () => {
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === 'https://oauth2.googleapis.com/token') {
        return new Response('temporarily unavailable', { status: 503 })
      }
      throw new Error(`Unexpected fetch call: ${String(input)}`)
    })

    mockOpenExternal.mockImplementation(async (authUrl: string) => {
      const parsed = new URL(authUrl)
      const redirectUri = parsed.searchParams.get('redirect_uri')
      const state = parsed.searchParams.get('state')
      setTimeout(() => {
        http.get(`${redirectUri}?code=google-auth-code&state=${state}`)
      }, 0)
    })

    await expect(connectGoogleCalendar()).rejects.toThrow('googleCalendar.temporarilyUnavailable')

    expect(loggerMock.error).toHaveBeenCalledWith(
      'Google Calendar token exchange failed',
      expect.objectContaining({
        status: 503,
        error: 'unknown_error',
        errorDescription: 'temporarily unavailable'
      })
    )
  })

  it('maps plain text primary calendar failures through the calendar API error path', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'metadata-access',
            refresh_token: 'metadata-refresh',
            expires_in: 3600,
            scope: GOOGLE_CALENDAR_SCOPE,
            token_type: 'Bearer'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ email: 'metadata@example.com' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(new Response('calendar backend down', { status: 500 }))

    mockOpenExternal.mockImplementation(async (authUrl: string) => {
      const parsed = new URL(authUrl)
      const redirectUri = parsed.searchParams.get('redirect_uri')
      const state = parsed.searchParams.get('state')
      setTimeout(() => {
        http.get(`${redirectUri}?code=google-auth-code&state=${state}`)
      }, 0)
    })

    await expect(connectGoogleCalendar()).rejects.toThrow('googleCalendar.temporarilyUnavailable')

    expect(loggerMock.error).toHaveBeenCalledWith(
      'Failed to fetch Google Calendar metadata',
      expect.objectContaining({ status: 500, apiStatus: undefined, body: 'calendar backend down' })
    )
  })

  it('resolves Google account ids and local auth state from calendar sources', async () => {
    mockListCalendarSources.mockReturnValue([
      { accountId: null },
      { accountId: 'first@example.com' },
      { accountId: 'second@example.com' }
    ])
    await storeGoogleCalendarTokens({
      accountId: 'second@example.com',
      accessToken: 'local-access',
      refreshToken: 'local-refresh'
    })

    expect(resolveDefaultGoogleAccountId({} as never)).toBe('first@example.com')
    expect(listGoogleAccountIds({} as never)).toEqual(['first@example.com', 'second@example.com'])
    expect(await hasGoogleCalendarLocalAuth('first@example.com')).toBe(false)
    expect(await hasAnyGoogleCalendarLocalAuth({} as never)).toBe(true)
    expect(await hasGoogleCalendarConnection({} as never)).toBe(true)
  })

  it('clears pending OAuth state and closes any active loopback server', () => {
    resetGoogleCalendarOAuthState()

    expect(loggerMock.debug).toHaveBeenCalledWith('Reset Google Calendar OAuth state')
  })
})

describe('abandoned OAuth flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.GOOGLE_CALENDAR_CLIENT_ID = 'google-client-id-123'
    resetGoogleCalendarOAuthState()
  })

  afterEach(() => {
    delete process.env.GOOGLE_CALENDAR_CLIENT_ID
    vi.useRealTimers()
  })

  it('marks the OAuth timeout as an expected condition so it is not error telemetry', async () => {
    // #given the user opens the consent screen and simply walks away —
    // production logged 5x "Failed_to_connect_calendar_provider" for this
    let opened = false
    mockOpenExternal.mockImplementation(async () => {
      opened = true
    })

    vi.useFakeTimers()
    const promise = connectGoogleCalendar()
    const rejection = promise.catch((error: unknown) => error)

    // #when the 10-minute OAuth window elapses with no callback
    await vi.waitUntil(() => opened, { timeout: 5000, interval: 10 })
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1)
    const error = await rejection

    // #then the user still sees the failure
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Google Calendar OAuth timed out')
    // #and telemetry skips it: an abandoned flow is a normal state, not a fault
    expect(isExpectedConditionError(error)).toBe(true)
  })
})
