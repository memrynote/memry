import { describe, expect, it } from 'vitest'

import { extractErrorMessage, SyncRequestError } from '@/lib/errors'

const FALLBACK = 'Could not send the code. Check the address and retry.'

describe('extractErrorMessage', () => {
  it('never shows a server error its own wire text', () => {
    const err = new SyncRequestError(
      '/auth/otp/request failed (HTTP 400): VALIDATION_ERROR Invalid request body',
      400,
      'VALIDATION_ERROR'
    )
    const message = extractErrorMessage(err, FALLBACK)
    expect(message).toBe(FALLBACK)
    expect(message).not.toContain('HTTP')
    expect(message).not.toContain('VALIDATION_ERROR')
  })

  it('prefers the code-specific sentence over the caller fallback', () => {
    const err = new SyncRequestError(
      '/auth/otp/verify failed (HTTP 401): AUTH_INVALID_OTP Invalid OTP code',
      401,
      'AUTH_INVALID_OTP'
    )
    expect(extractErrorMessage(err, 'That code did not work.')).toBe(
      'That code is not right. Check it and try again.'
    )
  })

  it('falls back to a status sentence when the code is unmapped', () => {
    const err = new SyncRequestError('/sync/vaults failed (HTTP 500)', 500, 'INTERNAL_ERROR')
    expect(extractErrorMessage(err, FALLBACK)).toBe(
      'Something went wrong on our side. Try again in a moment.'
    )
  })

  it('uses the caller fallback when neither code nor status is mapped', () => {
    const err = new SyncRequestError('/sync/vaults failed (HTTP 418)', 418, null)
    expect(extractErrorMessage(err, FALLBACK)).toBe(FALLBACK)
  })

  it('keeps the message of errors this codebase throws', () => {
    const err = new Error('Account has no vault key material — set the vault up from desktop first')
    expect(extractErrorMessage(err, FALLBACK)).toBe(err.message)
  })

  it('falls back for an empty or non-error value', () => {
    expect(extractErrorMessage(new Error('   '), FALLBACK)).toBe(FALLBACK)
    expect(extractErrorMessage(undefined, FALLBACK)).toBe(FALLBACK)
    expect(extractErrorMessage('plain string', FALLBACK)).toBe('plain string')
  })
})
