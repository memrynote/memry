import { beforeEach, describe, expect, it, vi } from 'vitest'

// oauth-errors resolves its copy through the main-process i18n singleton, which
// only exists after setMainI18n() during app boot. Echo the key back so the
// assertions below pin the chosen message, not one locale's wording.
const { getFixedTSpy } = vi.hoisted(() => ({
  getFixedTSpy: vi.fn((_lng: unknown, _ns: unknown) => (key: string) => key)
}))

vi.mock('../../lib/main-i18n', () => ({
  getMainI18n: () => ({
    t: (key: string) => key,
    getFixedT: getFixedTSpy
  })
}))

import {
  calendarScopeNotGrantedMessage,
  userMessageForCalendarApiError,
  userMessageForTokenEndpointError
} from './oauth-errors'

const RECONNECT = 'googleCalendar.reconnectNeeded'
const ACCESS_DENIED = 'googleCalendar.accessDenied'
const MISCONFIGURED = 'googleCalendar.misconfigured'
const SCOPE_MISSING = 'googleCalendar.scopeMissing'
const UNAVAILABLE = 'googleCalendar.temporarilyUnavailable'
const CONNECT_FAILED = 'googleCalendar.connectFailed'

beforeEach(() => {
  getFixedTSpy.mockClear()
})

describe('userMessageForTokenEndpointError', () => {
  it('#given a refresh token Google no longer honours #when errorCode is invalid_grant #then tells the user to reconnect', () => {
    expect(userMessageForTokenEndpointError({ status: 400, errorCode: 'invalid_grant' })).toBe(
      RECONNECT
    )
  })

  it('#given the user clicked Cancel on the consent screen #when errorCode is access_denied #then reports a declined connection, not a broken one', () => {
    expect(userMessageForTokenEndpointError({ status: 400, errorCode: 'access_denied' })).toBe(
      ACCESS_DENIED
    )
  })

  it.each(['invalid_client', 'unauthorized_client', 'unsupported_grant_type'])(
    '#given our OAuth app is set up wrong #when errorCode is %s #then blames configuration so the user contacts support instead of retrying forever',
    (errorCode) => {
      expect(userMessageForTokenEndpointError({ status: 400, errorCode })).toBe(MISCONFIGURED)
    }
  )

  it.each([
    'Unauthenticated: client_secret is missing',
    'code_verifier does not match the challenge'
  ])(
    '#given invalid_request whose description names a credential problem (%s) #when mapped #then treated as misconfiguration rather than a transient failure',
    (errorDescription) => {
      expect(
        userMessageForTokenEndpointError({
          status: 400,
          errorCode: 'invalid_request',
          errorDescription
        })
      ).toBe(MISCONFIGURED)
    }
  )

  it('#given invalid_request whose description shouts the credential name in caps #when mapped #then still detected (match is case-insensitive)', () => {
    expect(
      userMessageForTokenEndpointError({
        status: 400,
        errorCode: 'invalid_request',
        errorDescription: 'Missing required parameter: CLIENT_SECRET'
      })
    ).toBe(MISCONFIGURED)
  })

  it('#given invalid_request with an unrelated description #when mapped #then falls back to the generic retry message', () => {
    expect(
      userMessageForTokenEndpointError({
        status: 400,
        errorCode: 'invalid_request',
        errorDescription: 'Missing required parameter: redirect_uri'
      })
    ).toBe(CONNECT_FAILED)
  })

  it('#given invalid_request with no description at all #when mapped #then falls back to the generic retry message without throwing on undefined', () => {
    expect(userMessageForTokenEndpointError({ status: 400, errorCode: 'invalid_request' })).toBe(
      CONNECT_FAILED
    )
  })

  it('#given an error shape the code does not recognise #when errorCode is unknown and the status is a plain 4xx #then the user sees the generic fallback', () => {
    expect(
      userMessageForTokenEndpointError({
        status: 400,
        errorCode: 'slow_down',
        errorDescription: 'client_secret'
      })
    ).toBe(CONNECT_FAILED)
  })

  it('#given no errorCode is returned at all #when the status is a plain 4xx #then the user sees the generic fallback', () => {
    expect(userMessageForTokenEndpointError({ status: 400 })).toBe(CONNECT_FAILED)
  })

  it.each([500, 503])(
    "#given Google's token endpoint faulted #when status is %i and no errorCode is classified #then reports a temporary outage",
    (status) => {
      expect(userMessageForTokenEndpointError({ status })).toBe(UNAVAILABLE)
    }
  )

  it('#given an unrecognised errorCode alongside a server fault #when mapped #then the 5xx branch still reports a temporary outage', () => {
    expect(
      userMessageForTokenEndpointError({ status: 502, errorCode: 'temporarily_unavailable' })
    ).toBe(UNAVAILABLE)
  })

  it('#given a classified errorCode arrives with a 5xx status #when mapped #then the specific cause wins over the generic outage message', () => {
    expect(userMessageForTokenEndpointError({ status: 500, errorCode: 'invalid_grant' })).toBe(
      RECONNECT
    )
    expect(userMessageForTokenEndpointError({ status: 503, errorCode: 'invalid_client' })).toBe(
      MISCONFIGURED
    )
  })

  it('#given the status sits either side of the 500 boundary #when mapped #then 499 is generic and 500 is the outage message', () => {
    expect(userMessageForTokenEndpointError({ status: 499 })).toBe(CONNECT_FAILED)
    expect(userMessageForTokenEndpointError({ status: 500 })).toBe(UNAVAILABLE)
  })

  it('#given any token failure #when a message is produced #then the copy is resolved from the errors namespace', () => {
    userMessageForTokenEndpointError({ status: 400, errorCode: 'invalid_grant' })
    expect(getFixedTSpy).toHaveBeenCalledWith(null, 'errors')
  })
})

describe('userMessageForCalendarApiError', () => {
  it('#given the stored access token is rejected #when status is 401 #then tells the user to reconnect', () => {
    expect(userMessageForCalendarApiError({ status: 401 })).toBe(RECONNECT)
  })

  it('#given the token works but lacks the Calendar scope #when status is 403 #then explains the missing Calendar permission', () => {
    expect(userMessageForCalendarApiError({ status: 403 })).toBe(SCOPE_MISSING)
  })

  it('#given Google signals PERMISSION_DENIED in the body while the HTTP status is not 403 #when mapped #then still explains the missing Calendar permission', () => {
    expect(userMessageForCalendarApiError({ status: 400, apiStatus: 'PERMISSION_DENIED' })).toBe(
      SCOPE_MISSING
    )
  })

  it('#given a 401 that also carries PERMISSION_DENIED #when mapped #then reconnect wins, because a dead token cannot be fixed by re-granting scope', () => {
    expect(userMessageForCalendarApiError({ status: 401, apiStatus: 'PERMISSION_DENIED' })).toBe(
      RECONNECT
    )
  })

  it.each([500, 503])(
    '#given the Calendar API faulted #when status is %i #then reports a temporary outage rather than asking the user to reconnect',
    (status) => {
      expect(userMessageForCalendarApiError({ status })).toBe(UNAVAILABLE)
    }
  )

  it('#given the status sits either side of the 500 boundary #when mapped #then 499 is generic and 500 is the outage message', () => {
    expect(userMessageForCalendarApiError({ status: 499 })).toBe(CONNECT_FAILED)
    expect(userMessageForCalendarApiError({ status: 500 })).toBe(UNAVAILABLE)
  })

  it('#given Google rate limits us #when status is 429 #then the user sees the generic retry message (rate limiting is not called out separately)', () => {
    expect(userMessageForCalendarApiError({ status: 429 })).toBe(CONNECT_FAILED)
    expect(userMessageForCalendarApiError({ status: 429, apiStatus: 'RESOURCE_EXHAUSTED' })).toBe(
      CONNECT_FAILED
    )
  })

  it('#given an error shape the code does not recognise #when neither the status nor apiStatus is classified #then the user sees the generic fallback', () => {
    expect(userMessageForCalendarApiError({ status: 404 })).toBe(CONNECT_FAILED)
    expect(userMessageForCalendarApiError({ status: 400, apiStatus: 'NOT_FOUND' })).toBe(
      CONNECT_FAILED
    )
    expect(userMessageForCalendarApiError({ status: 0 })).toBe(CONNECT_FAILED)
  })

  it('#given any API failure #when a message is produced #then the copy is resolved from the errors namespace', () => {
    userMessageForCalendarApiError({ status: 403 })
    expect(getFixedTSpy).toHaveBeenCalledWith(null, 'errors')
  })
})

describe('calendarScopeNotGrantedMessage', () => {
  it('#given the consent screen returned without the Calendar scope #when called #then returns the same missing-scope copy the API path uses', () => {
    expect(calendarScopeNotGrantedMessage()).toBe(SCOPE_MISSING)
    expect(calendarScopeNotGrantedMessage()).toBe(userMessageForCalendarApiError({ status: 403 }))
    expect(getFixedTSpy).toHaveBeenCalledWith(null, 'errors')
  })
})

describe('message distinctness', () => {
  it('#given the six failure causes users can hit #when each is mapped #then every cause gets its own message key, so no two causes are described identically', () => {
    const messages = [
      userMessageForTokenEndpointError({ status: 400, errorCode: 'invalid_grant' }),
      userMessageForTokenEndpointError({ status: 400, errorCode: 'access_denied' }),
      userMessageForTokenEndpointError({ status: 400, errorCode: 'invalid_client' }),
      userMessageForTokenEndpointError({ status: 500 }),
      userMessageForTokenEndpointError({ status: 400 }),
      userMessageForCalendarApiError({ status: 403 })
    ]

    expect(new Set(messages).size).toBe(messages.length)
  })
})
