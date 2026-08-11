import { describe, it, expect } from 'vitest'
import { classifyError } from './sync-errors'
import {
  SyncServerError,
  NetworkError,
  RateLimitError,
  AttachmentTooLargeError
} from './http-client'
import { DeadLetterError } from './retry'
import { CryptoError } from '../crypto/crypto-errors'

describe('classifyError', () => {
  it('#given SyncServerError 413 STORAGE_FILE_TOO_LARGE #then file_too_large, not retryable', () => {
    // Both causes of a 413 used to map to storage_quota_exceeded, which told the
    // user to free up space — never a fix for one oversized file.
    const body =
      '{"error":{"code":"STORAGE_FILE_TOO_LARGE","message":"File exceeds the plus plan file size limit"}}'
    const err = new SyncServerError(`Failed to initiate upload: ${body}`, 413, body)
    const result = classifyError(err)

    expect(result.category).toBe('file_too_large')
    expect(result.retryable).toBe(false)
  })

  it('#given SyncServerError 413 with VALIDATION_BODY_TOO_LARGE #then note_too_large', () => {
    // The server's body-limit middleware 413s oversized CRDT payloads. Calling
    // that "storage full" sends the user to free up space, which never fixes it.
    const body = '{"error":{"code":"VALIDATION_BODY_TOO_LARGE","message":"Request body too large"}}'
    const err = new SyncServerError(`Failed to push snapshot: ${body}`, 413, body)
    const result = classifyError(err)

    expect(result.category).toBe('note_too_large')
    expect(result.retryable).toBe(false)
  })

  it('#given SyncServerError 413 with no error code #then note_too_large, not retryable', () => {
    // Real quota responses always carry STORAGE_QUOTA_EXCEEDED in the body. A
    // bare 413 comes from a body-size layer (middleware, edge proxy), so it is
    // a payload-size problem, not an account-storage problem.
    const err = new SyncServerError('Request Entity Too Large', 413)
    const result = classifyError(err)

    expect(result.category).toBe('note_too_large')
    expect(result.retryable).toBe(false)
  })

  it('#given AttachmentTooLargeError #then file_too_large, not retryable', () => {
    const err = new AttachmentTooLargeError('File is larger than your plan allows', 2048, 1024)
    const result = classifyError(err)

    expect(result.category).toBe('file_too_large')
    expect(result.retryable).toBe(false)
  })

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

  it('#given SyncServerError 413 with STORAGE_QUOTA_EXCEEDED #then storage_quota_exceeded', () => {
    const body = '{"error":{"code":"STORAGE_QUOTA_EXCEEDED","message":"Storage quota exceeded"}}'
    const err = new SyncServerError('Storage quota exceeded', 413, body)
    const result = classifyError(err)

    expect(result.category).toBe('storage_quota_exceeded')
    expect(result.message).toBe('Storage quota exceeded')
    expect(result.retryable).toBe(false)
  })

  it('#given SyncServerError 402 #then sync_payment_required, not retryable', () => {
    const err = new SyncServerError('Payment required', 402, 'SYNC_PAYMENT_REQUIRED')
    const result = classifyError(err)

    expect(result.category).toBe('sync_payment_required')
    expect(result.message).toBe('A paid Sync plan is required')
    expect(result.retryable).toBe(false)
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
