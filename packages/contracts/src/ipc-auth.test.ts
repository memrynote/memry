/**
 * IPC Auth Contract Tests
 *
 * Zod schema validation tests for the auth IPC boundary: OTP flow,
 * OAuth kickoff, first-device setup, and recovery-phrase confirmation.
 * Also verifies the AUTH_CHANNELS channel-name constant surface.
 */

import { describe, expect, it } from 'vitest'
import {
  AUTH_CHANNELS,
  ConfirmRecoveryPhraseSchema,
  InitOAuthSchema,
  RequestOtpSchema,
  ResendOtpSchema,
  SetupFirstDeviceSchema,
  VerifyOtpSchema
} from './ipc-auth'

describe('AUTH_CHANNELS', () => {
  it('exposes every expected channel literal', () => {
    expect(AUTH_CHANNELS.AUTH_REQUEST_OTP).toBe('auth:request-otp')
    expect(AUTH_CHANNELS.AUTH_VERIFY_OTP).toBe('auth:verify-otp')
    expect(AUTH_CHANNELS.AUTH_RESEND_OTP).toBe('auth:resend-otp')
    expect(AUTH_CHANNELS.AUTH_INIT_OAUTH).toBe('auth:init-oauth')
    expect(AUTH_CHANNELS.AUTH_REFRESH_TOKEN).toBe('auth:refresh-token')
    expect(AUTH_CHANNELS.SETUP_FIRST_DEVICE).toBe('sync:setup-first-device')
    expect(AUTH_CHANNELS.SETUP_NEW_ACCOUNT).toBe('sync:setup-new-account')
    expect(AUTH_CHANNELS.CONFIRM_RECOVERY_PHRASE).toBe('sync:confirm-recovery-phrase')
    expect(AUTH_CHANNELS.GET_RECOVERY_PHRASE).toBe('sync:get-recovery-phrase')
    expect(AUTH_CHANNELS.AUTH_LOGOUT).toBe('sync:logout')
  })
})

describe('RequestOtpSchema', () => {
  it('accepts a well-formed email', () => {
    const result = RequestOtpSchema.safeParse({ email: 'kaan@memry.dev' })
    expect(result.success).toBe(true)
  })

  it('rejects a malformed email', () => {
    const result = RequestOtpSchema.safeParse({ email: 'not-an-email' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('email')
    }
  })

  it('rejects missing email', () => {
    const result = RequestOtpSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

describe('VerifyOtpSchema', () => {
  it('accepts a well-formed email + 6-digit code', () => {
    const result = VerifyOtpSchema.safeParse({
      email: 'kaan@memry.dev',
      code: '123456'
    })
    expect(result.success).toBe(true)
  })

  it('rejects non-numeric codes', () => {
    const result = VerifyOtpSchema.safeParse({
      email: 'kaan@memry.dev',
      code: '12a456'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('code')
    }
  })

  it('rejects codes that are not exactly 6 digits', () => {
    const tooShort = VerifyOtpSchema.safeParse({
      email: 'kaan@memry.dev',
      code: '12345'
    })
    expect(tooShort.success).toBe(false)

    const tooLong = VerifyOtpSchema.safeParse({
      email: 'kaan@memry.dev',
      code: '1234567'
    })
    expect(tooLong.success).toBe(false)
  })
})

describe('ResendOtpSchema', () => {
  it('accepts a valid email', () => {
    const result = ResendOtpSchema.safeParse({ email: 'kaan@memry.dev' })
    expect(result.success).toBe(true)
  })

  it('rejects malformed email', () => {
    const result = ResendOtpSchema.safeParse({ email: 'broken' })
    expect(result.success).toBe(false)
  })
})

describe('InitOAuthSchema', () => {
  it('accepts provider "google"', () => {
    const result = InitOAuthSchema.safeParse({ provider: 'google' })
    expect(result.success).toBe(true)
  })

  it('rejects any other provider', () => {
    const result = InitOAuthSchema.safeParse({ provider: 'github' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('provider')
    }
  })

  it('rejects missing provider', () => {
    const result = InitOAuthSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

describe('SetupFirstDeviceSchema', () => {
  it('accepts full valid input', () => {
    const result = SetupFirstDeviceSchema.safeParse({
      oauthToken: 'token',
      provider: 'google',
      state: 'state-value'
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty oauthToken', () => {
    const result = SetupFirstDeviceSchema.safeParse({
      oauthToken: '',
      provider: 'google',
      state: 'state'
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty state', () => {
    const result = SetupFirstDeviceSchema.safeParse({
      oauthToken: 'token',
      provider: 'google',
      state: ''
    })
    expect(result.success).toBe(false)
  })

  it('rejects a non-google provider', () => {
    const result = SetupFirstDeviceSchema.safeParse({
      oauthToken: 'token',
      provider: 'apple',
      state: 'state'
    })
    expect(result.success).toBe(false)
  })
})

describe('ConfirmRecoveryPhraseSchema', () => {
  it('accepts confirmed: true', () => {
    const result = ConfirmRecoveryPhraseSchema.safeParse({ confirmed: true })
    expect(result.success).toBe(true)
  })

  it('accepts confirmed: false', () => {
    const result = ConfirmRecoveryPhraseSchema.safeParse({ confirmed: false })
    expect(result.success).toBe(true)
  })

  it('rejects non-boolean confirmed values', () => {
    const result = ConfirmRecoveryPhraseSchema.safeParse({ confirmed: 'yes' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('confirmed')
    }
  })

  it('rejects missing confirmed flag', () => {
    const result = ConfirmRecoveryPhraseSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})
