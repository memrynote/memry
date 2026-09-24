import { describe, expect, it } from 'vitest'
import { IcsFeedError } from '../ics/ics-feed'
import {
  ProviderAuthError,
  ProviderConflictError,
  ProviderGoneError,
  ProviderRateLimitError,
  ProviderTransientError,
  classifyProviderError,
  isProviderError
} from './errors'

function httpError(status: number, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status, ...extra })
}

describe('provider error taxonomy (#1391)', () => {
  it('maps HTTP statuses onto the taxonomy', () => {
    expect(classifyProviderError('google', httpError(401))).toBeInstanceOf(ProviderAuthError)
    expect(classifyProviderError('google', httpError(403))).toBeInstanceOf(ProviderAuthError)
    expect(classifyProviderError('google', httpError(410))).toBeInstanceOf(ProviderGoneError)
    expect(classifyProviderError('caldav', httpError(412))).toBeInstanceOf(ProviderConflictError)
    expect(classifyProviderError('caldav', httpError(503))).toBeInstanceOf(ProviderTransientError)
  })

  it('carries retryAfterMs on a rate limit, with a floor when the server gives none', () => {
    const withHint = classifyProviderError('caldav', httpError(429, { retryAfterMs: 5_000 }))
    expect(withHint).toBeInstanceOf(ProviderRateLimitError)
    expect((withHint as ProviderRateLimitError).retryAfterMs).toBe(5_000)
    const noHint = classifyProviderError('caldav', httpError(429)) as ProviderRateLimitError
    expect(noHint.retryAfterMs).toBe(60_000)
  })

  it('maps existing ICS feed codes without replacing them', () => {
    const auth = classifyProviderError('ics', new IcsFeedError('unauthorized'))
    expect(auth).toBeInstanceOf(ProviderAuthError)
    expect(auth?.cause).toBeInstanceOf(IcsFeedError)
    expect(classifyProviderError('ics', new IcsFeedError('timeout'))).toBeInstanceOf(
      ProviderTransientError
    )
    expect(classifyProviderError('ics', new IcsFeedError('not_a_calendar'))).toBeNull()
  })

  it('leaves programming and database errors alone', () => {
    expect(classifyProviderError('google', new TypeError('boom'))).toBeNull()
    expect(classifyProviderError('google', httpError(400))).toBeNull()
  })

  it('passes a provider error through unchanged', () => {
    const gone = new ProviderGoneError('caldav')
    expect(classifyProviderError('caldav', gone)).toBe(gone)
    expect(isProviderError(gone)).toBe(true)
    expect(gone.providerId).toBe('caldav')
    expect(gone.kind).toBe('gone')
  })
})
