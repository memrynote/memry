/**
 * Auth API Contract Tests
 *
 * Zod schema validation tests for the auth-api contracts covering
 * OTP flow, device registration, OAuth callback, first-device setup,
 * refresh-token rotation, and corresponding response envelopes.
 */

import { describe, expect, it } from 'vitest'
import {
  DeviceRegisterRequestSchema,
  DeviceRegisterResponseSchema,
  FirstDeviceSetupRequestSchema,
  OAuthCallbackResponseSchema,
  OAuthCallbackSchema,
  RecoveryDataResponseSchema,
  RefreshTokenRequestSchema,
  RefreshTokenResponseSchema,
  RequestOtpRequestSchema,
  RequestOtpResponseSchema,
  ResendOtpRequestSchema,
  VerifyOtpRequestSchema,
  VerifyOtpResponseSchema
} from './auth-api'

describe('RequestOtpRequestSchema', () => {
  it('accepts a well-formed email', () => {
    const result = RequestOtpRequestSchema.safeParse({ email: 'kaan@memry.dev' })
    expect(result.success).toBe(true)
  })

  it('rejects a malformed email', () => {
    const result = RequestOtpRequestSchema.safeParse({ email: 'not-an-email' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('email')
    }
  })

  it('rejects missing email', () => {
    const result = RequestOtpRequestSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

describe('VerifyOtpRequestSchema', () => {
  it('accepts a 6-digit code without sessionNonce', () => {
    const result = VerifyOtpRequestSchema.safeParse({
      email: 'kaan@memry.dev',
      code: '123456'
    })
    expect(result.success).toBe(true)
  })

  it('accepts sessionNonce when provided', () => {
    const result = VerifyOtpRequestSchema.safeParse({
      email: 'kaan@memry.dev',
      code: '654321',
      sessionNonce: 'nonce-abc'
    })
    expect(result.success).toBe(true)
  })

  it('rejects non-numeric codes', () => {
    const result = VerifyOtpRequestSchema.safeParse({
      email: 'kaan@memry.dev',
      code: 'abcdef'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('code')
    }
  })

  it('rejects codes with fewer than 6 digits', () => {
    const result = VerifyOtpRequestSchema.safeParse({
      email: 'kaan@memry.dev',
      code: '12345'
    })
    expect(result.success).toBe(false)
  })

  it('rejects codes with more than 6 digits', () => {
    const result = VerifyOtpRequestSchema.safeParse({
      email: 'kaan@memry.dev',
      code: '1234567'
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty sessionNonce when the field is supplied', () => {
    const result = VerifyOtpRequestSchema.safeParse({
      email: 'kaan@memry.dev',
      code: '123456',
      sessionNonce: ''
    })
    expect(result.success).toBe(false)
  })
})

describe('ResendOtpRequestSchema', () => {
  it('accepts a well-formed email', () => {
    const result = ResendOtpRequestSchema.safeParse({ email: 'kaan@memry.dev' })
    expect(result.success).toBe(true)
  })

  it('rejects missing email', () => {
    const result = ResendOtpRequestSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

describe('DeviceRegisterRequestSchema', () => {
  const base = {
    name: 'Kaan MBP',
    platform: 'macos' as const,
    appVersion: '0.6.0',
    authPublicKey: 'pk-base64',
    challengeSignature: 'sig-base64',
    challengeNonce: 'nonce-base64'
  }

  it('accepts minimal valid input', () => {
    const result = DeviceRegisterRequestSchema.safeParse(base)
    expect(result.success).toBe(true)
  })

  it('accepts optional osVersion and sessionNonce', () => {
    const result = DeviceRegisterRequestSchema.safeParse({
      ...base,
      osVersion: '15.4',
      sessionNonce: 'nonce'
    })
    expect(result.success).toBe(true)
  })

  it('accepts every valid platform enum value', () => {
    const platforms = ['macos', 'windows', 'linux', 'ios', 'android'] as const
    for (const platform of platforms) {
      const result = DeviceRegisterRequestSchema.safeParse({ ...base, platform })
      expect(result.success).toBe(true)
    }
  })

  it('rejects unknown platforms', () => {
    const result = DeviceRegisterRequestSchema.safeParse({ ...base, platform: 'chromeos' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('platform')
    }
  })

  it('rejects empty device name (at least one character)', () => {
    const result = DeviceRegisterRequestSchema.safeParse({ ...base, name: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('name')
    }
  })

  it('rejects a name over 255 characters', () => {
    const result = DeviceRegisterRequestSchema.safeParse({ ...base, name: 'x'.repeat(256) })
    expect(result.success).toBe(false)
  })

  it('accepts a name exactly at the 255 boundary', () => {
    const result = DeviceRegisterRequestSchema.safeParse({ ...base, name: 'x'.repeat(255) })
    expect(result.success).toBe(true)
  })

  it('rejects missing authPublicKey', () => {
    const invalid: Record<string, unknown> = { ...base }
    delete invalid.authPublicKey
    const result = DeviceRegisterRequestSchema.safeParse(invalid)
    expect(result.success).toBe(false)
  })

  it('rejects empty appVersion', () => {
    const result = DeviceRegisterRequestSchema.safeParse({ ...base, appVersion: '' })
    expect(result.success).toBe(false)
  })
})

describe('FirstDeviceSetupRequestSchema', () => {
  it('accepts valid kdfSalt + keyVerifier', () => {
    const result = FirstDeviceSetupRequestSchema.safeParse({
      kdfSalt: 'salt-base64',
      keyVerifier: 'verifier-base64'
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty kdfSalt', () => {
    const result = FirstDeviceSetupRequestSchema.safeParse({
      kdfSalt: '',
      keyVerifier: 'verifier-base64'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('kdfSalt')
    }
  })

  it('rejects empty keyVerifier', () => {
    const result = FirstDeviceSetupRequestSchema.safeParse({
      kdfSalt: 'salt',
      keyVerifier: ''
    })
    expect(result.success).toBe(false)
  })
})

describe('RefreshTokenRequestSchema', () => {
  it('accepts a non-empty refresh token', () => {
    const result = RefreshTokenRequestSchema.safeParse({ refreshToken: 'rt-abc' })
    expect(result.success).toBe(true)
  })

  it('rejects an empty refresh token (rotation must carry a value)', () => {
    const result = RefreshTokenRequestSchema.safeParse({ refreshToken: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('refreshToken')
    }
  })

  it('rejects missing refresh token', () => {
    const result = RefreshTokenRequestSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

describe('OAuthCallbackSchema', () => {
  it('accepts code + state without sessionNonce (PKCE verifier is the code itself)', () => {
    const result = OAuthCallbackSchema.safeParse({ code: 'auth-code', state: 'state-value' })
    expect(result.success).toBe(true)
  })

  it('accepts sessionNonce when present', () => {
    const result = OAuthCallbackSchema.safeParse({
      code: 'auth-code',
      state: 'state-value',
      sessionNonce: 'nonce'
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty code', () => {
    const result = OAuthCallbackSchema.safeParse({ code: '', state: 'state' })
    expect(result.success).toBe(false)
  })

  it('rejects empty state', () => {
    const result = OAuthCallbackSchema.safeParse({ code: 'auth-code', state: '' })
    expect(result.success).toBe(false)
  })
})

describe('RequestOtpResponseSchema', () => {
  it('accepts success-only payload', () => {
    const result = RequestOtpResponseSchema.safeParse({ success: true })
    expect(result.success).toBe(true)
  })

  it('accepts optional expiresIn and message', () => {
    const result = RequestOtpResponseSchema.safeParse({
      success: true,
      expiresIn: 600,
      message: 'OTP sent'
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing success flag', () => {
    const result = RequestOtpResponseSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

describe('VerifyOtpResponseSchema', () => {
  it('accepts success with tokens + userId for existing user', () => {
    const result = VerifyOtpResponseSchema.safeParse({
      success: true,
      accessToken: 'at',
      refreshToken: 'rt',
      userId: 'user-1',
      isNewUser: false,
      needsSetup: false
    })
    expect(result.success).toBe(true)
  })

  it('accepts success with setupToken for new user needing setup', () => {
    const result = VerifyOtpResponseSchema.safeParse({
      success: true,
      setupToken: 'st',
      isNewUser: true,
      needsSetup: true
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing success flag', () => {
    const result = VerifyOtpResponseSchema.safeParse({ accessToken: 'at' })
    expect(result.success).toBe(false)
  })
})

describe('DeviceRegisterResponseSchema', () => {
  it('accepts success with deviceId and tokens', () => {
    const result = DeviceRegisterResponseSchema.safeParse({
      success: true,
      deviceId: 'dev-1',
      accessToken: 'at',
      refreshToken: 'rt'
    })
    expect(result.success).toBe(true)
  })

  it('accepts failure with error message', () => {
    const result = DeviceRegisterResponseSchema.safeParse({
      success: false,
      error: 'registration failed'
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing success flag', () => {
    const result = DeviceRegisterResponseSchema.safeParse({ error: 'nope' })
    expect(result.success).toBe(false)
  })
})

describe('OAuthCallbackResponseSchema', () => {
  it('accepts success only', () => {
    const result = OAuthCallbackResponseSchema.safeParse({ success: true })
    expect(result.success).toBe(true)
  })

  it('accepts setup fields for new users', () => {
    const result = OAuthCallbackResponseSchema.safeParse({
      success: true,
      isNewUser: true,
      needsSetup: true,
      setupToken: 'st'
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing success flag', () => {
    const result = OAuthCallbackResponseSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

describe('RecoveryDataResponseSchema', () => {
  it('accepts valid salt + verifier pair', () => {
    const result = RecoveryDataResponseSchema.safeParse({
      kdfSalt: 'salt',
      keyVerifier: 'verifier'
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing kdfSalt', () => {
    const result = RecoveryDataResponseSchema.safeParse({ keyVerifier: 'verifier' })
    expect(result.success).toBe(false)
  })

  it('rejects missing keyVerifier', () => {
    const result = RecoveryDataResponseSchema.safeParse({ kdfSalt: 'salt' })
    expect(result.success).toBe(false)
  })
})

describe('RefreshTokenResponseSchema', () => {
  it('accepts a full rotated token response with expiry', () => {
    const result = RefreshTokenResponseSchema.safeParse({
      accessToken: 'at',
      refreshToken: 'rt-new',
      expiresIn: 3600
    })
    expect(result.success).toBe(true)
  })

  it('rejects a non-numeric expiresIn', () => {
    const result = RefreshTokenResponseSchema.safeParse({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresIn: '3600'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('expiresIn')
    }
  })

  it('rejects when any of the three required fields is missing', () => {
    const missingAccess = RefreshTokenResponseSchema.safeParse({
      refreshToken: 'rt',
      expiresIn: 3600
    })
    expect(missingAccess.success).toBe(false)

    const missingRefresh = RefreshTokenResponseSchema.safeParse({
      accessToken: 'at',
      expiresIn: 3600
    })
    expect(missingRefresh.success).toBe(false)

    const missingExpiry = RefreshTokenResponseSchema.safeParse({
      accessToken: 'at',
      refreshToken: 'rt'
    })
    expect(missingExpiry.success).toBe(false)
  })
})
