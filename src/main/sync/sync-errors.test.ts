import { describe, it, expect } from 'vitest'
import { classifyError } from './sync-errors'
import { SyncServerError, NetworkError, RateLimitError } from './http-client'
import { DeadLetterError } from './retry'
import { CryptoError } from '../crypto/crypto-errors'

describe('classifyError', () => {
  it('#given SyncServerError 401 #then auth_expired, not retryable', () => {
    const err = new SyncServerError('Unauthorized', 401)
    const result = classifyError(err)

    expect(result.category).toBe('auth_expired')
    expect(result.retryable).toBe(false)
  })

  it('#given SyncServerError 429 #then rate_limited, retryable', () => {
    const err = new SyncServerError('Too many requests', 429)
    const result = classifyError(err)

    expect(result.category).toBe('rate_limited')
    expect(result.retryable).toBe(true)
  })

  it('#given RateLimitError #then rate_limited, retryable', () => {
    const err = new RateLimitError(60)
    const result = classifyError(err)

    expect(result.category).toBe('rate_limited')
    expect(result.retryable).toBe(true)
  })

  it('#given SyncServerError 500 #then server_error, retryable', () => {
    const err = new SyncServerError('Internal Server Error', 500, 'db connection failed')
    const result = classifyError(err)

    expect(result.category).toBe('server_error')
    expect(result.message).toBe('db connection failed')
    expect(result.retryable).toBe(true)
  })

  it('#given SyncServerError 502 #then server_error, retryable', () => {
    const err = new SyncServerError('Bad Gateway', 502)
    const result = classifyError(err)

    expect(result.category).toBe('server_error')
    expect(result.retryable).toBe(true)
  })

  it('#given SyncServerError 400 #then server_error, not retryable', () => {
    const err = new SyncServerError('Bad Request', 400, 'invalid payload')
    const result = classifyError(err)

    expect(result.category).toBe('server_error')
    expect(result.message).toBe('invalid payload')
    expect(result.retryable).toBe(false)
  })

  it('#given SyncServerError 403 #then server_error, not retryable', () => {
    const err = new SyncServerError('Forbidden', 403)
    const result = classifyError(err)

    expect(result.category).toBe('server_error')
    expect(result.retryable).toBe(false)
  })

  it('#given SyncServerError 403 with AUTH_DEVICE_REVOKED #then device_revoked, not retryable', () => {
    const err = new SyncServerError(
      'Forbidden',
      403,
      'AUTH_DEVICE_REVOKED: Device has been revoked'
    )
    const result = classifyError(err)

    expect(result.category).toBe('device_revoked')
    expect(result.message).toBe('This device has been removed')
    expect(result.retryable).toBe(false)
  })

  it('#given SyncServerError 403 without AUTH_DEVICE_REVOKED #then server_error', () => {
    const err = new SyncServerError('Forbidden', 403, 'SOME_OTHER_ERROR')
    const result = classifyError(err)

    expect(result.category).toBe('server_error')
    expect(result.retryable).toBe(false)
  })

  it('#given NetworkError #then network_offline, retryable', () => {
    const err = new NetworkError('fetch failed')
    const result = classifyError(err)

    expect(result.category).toBe('network_offline')
    expect(result.retryable).toBe(true)
  })

  it('#given CryptoError #then crypto_failure, not retryable', () => {
    const err = new CryptoError('DECRYPTION_FAILED', 'Ciphertext authentication failed')
    const result = classifyError(err)

    expect(result.category).toBe('crypto_failure')
    expect(result.retryable).toBe(false)
  })

  it('#given DeadLetterError wrapping 5xx #then server_error, not retryable', () => {
    const inner = new SyncServerError('Internal Server Error', 500)
    const err = new DeadLetterError(inner, 5)
    const result = classifyError(err)

    expect(result.category).toBe('server_error')
    expect(result.retryable).toBe(false)
  })

  it('#given DeadLetterError wrapping NetworkError #then network_offline, not retryable', () => {
    const inner = new NetworkError('timeout')
    const err = new DeadLetterError(inner, 3)
    const result = classifyError(err)

    expect(result.category).toBe('network_offline')
    expect(result.retryable).toBe(false)
  })

  it('#given generic Error #then unknown, retryable', () => {
    const err = new Error('something went wrong')
    const result = classifyError(err)

    expect(result.category).toBe('unknown')
    expect(result.message).toBe('something went wrong')
    expect(result.retryable).toBe(true)
  })

  it('#given string #then unknown, retryable', () => {
    const result = classifyError('random string error')

    expect(result.category).toBe('unknown')
    expect(result.message).toBe('random string error')
    expect(result.retryable).toBe(true)
  })
})
