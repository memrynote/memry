import { describe, expect, it } from 'vitest'
import {
  ProviderAuthError,
  ProviderConflictError,
  ProviderError,
  ProviderGoneError,
  ProviderRateLimitError,
  ProviderTransientError
} from './errors'

describe('calendar provider error taxonomy', () => {
  it('every provider error is an Error, a ProviderError, and reports its own class name', () => {
    const cases = [
      new ProviderAuthError('reconnect'),
      new ProviderGoneError('cursor dead'),
      new ProviderConflictError('etag mismatch'),
      new ProviderRateLimitError('slow down'),
      new ProviderTransientError('network blip')
    ]

    for (const error of cases) {
      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(ProviderError)
      expect(error.name).toBe(error.constructor.name)
    }
  })

  it('discriminates by class so the engine can branch on the condition', () => {
    const gone: ProviderError = new ProviderGoneError('cursor dead')

    expect(gone).toBeInstanceOf(ProviderGoneError)
    expect(gone).not.toBeInstanceOf(ProviderAuthError)
    expect(gone).not.toBeInstanceOf(ProviderConflictError)
  })

  it('carries the provider id and the original cause when the adapter supplies them', () => {
    const cause = new Error('HTTP 410')
    const error = new ProviderGoneError('cursor dead', { providerId: 'google', cause })

    expect(error.providerId).toBe('google')
    expect(error.cause).toBe(cause)
  })

  it('leaves providerId and cause undefined when the adapter omits them', () => {
    const error = new ProviderAuthError('reconnect')

    expect(error.providerId).toBeUndefined()
    expect(error.cause).toBeUndefined()
  })

  it('keeps the rate-limit retry hint, and reads null when the provider gave none', () => {
    expect(new ProviderRateLimitError('slow down', { retryAfterMs: 30_000 }).retryAfterMs).toBe(
      30_000
    )
    expect(new ProviderRateLimitError('slow down').retryAfterMs).toBeNull()
  })
})
