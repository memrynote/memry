import { Hono } from 'hono'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { AppError, ErrorCodes, errorHandler } from '../lib/errors'
import type { AppContext } from '../types'

// ============================================================================
// Module mocks (must be before imports that use them)
// ============================================================================

vi.mock('../services/otp', () => ({
  generateOtp: vi.fn().mockReturnValue('123456'),
  storeOtp: vi.fn().mockResolvedValue(undefined),
  verifyOtp: vi.fn().mockResolvedValue(undefined),
  checkEmailRateLimit: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../services/user', () => ({
  getOrCreateUserByEmail: vi.fn().mockResolvedValue({
    user: { id: 'user-1', kdf_salt: null },
    isNewUser: true
  }),
  getUserById: vi.fn().mockResolvedValue({ id: 'user-1', kdf_salt: null }),
  updateUser: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../services/auth', () => ({
  issueTokens: vi.fn().mockResolvedValue({
    accessToken: 'mock-access-token',
    refreshToken: 'mock-refresh-token'
  }),
  rotateRefreshToken: vi.fn().mockResolvedValue({
    accessToken: 'new-access-token',
    refreshToken: 'new-refresh-token'
  }),
  signSetupToken: vi.fn().mockResolvedValue('mock-setup-token')
}))

vi.mock('../services/email', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../emails/otp-template', () => ({
  buildOtpEmailHtml: vi.fn().mockReturnValue('<html>OTP</html>')
}))

vi.mock('../middleware/rate-limit', () => ({
  createRateLimiter: () => async (_c: unknown, next: () => Promise<void>) => next()
}))

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'user-1')
    c.set('deviceId', 'device-1')
    await next()
  }
}))

vi.mock('../middleware/setup-auth', () => ({
  setupAuthMiddleware: async (
    c: { set: (k: string, v: string) => void },
    next: () => Promise<void>
  ) => {
    c.set('userId', 'user-1')
    await next()
  }
}))

vi.mock('../lib/jwt-keys', () => ({
  getPrivateKey: vi.fn().mockResolvedValue({ type: 'private' }),
  getPublicKey: vi.fn().mockResolvedValue({ type: 'public' })
}))

vi.mock('jose', () => ({
  decodeJwt: vi.fn().mockReturnValue({
    type: 'refresh',
    sub: 'user-1',
    device_id: 'device-1'
  }),
  jwtVerify: vi.fn().mockResolvedValue({
    payload: {
      type: 'oauth_state',
      email: 'test@example.com',
      email_verified: true,
      sub: 'google-sub-123',
      name: 'Test User'
    }
  }),
  createRemoteJWKSet: vi.fn().mockReturnValue('mock-jwks'),
  SignJWT: class {
    setProtectedHeader() { return this }
    setIssuedAt() { return this }
    setIssuer() { return this }
    setAudience() { return this }
    setExpirationTime() { return this }
    async sign() { return 'mock-oauth-state' }
  }
}))

import { auth } from './auth'
import { checkEmailRateLimit } from '../services/otp'
import { getOrCreateUserByEmail, getUserById, updateUser } from '../services/user'
import { rotateRefreshToken } from '../services/auth'
import { decodeJwt, jwtVerify } from 'jose'

// ============================================================================
// Test app with error handler
// ============================================================================

const createApp = () => {
  const app = new Hono<AppContext>()
  app.onError(errorHandler)
  app.route('/auth', auth)
  return app
}

const createEnv = () => ({
  DB: {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
      run: vi.fn().mockResolvedValue({ success: true }),
      all: vi.fn().mockResolvedValue({ results: [] })
    })
  } as unknown as D1Database,
  STORAGE: {} as R2Bucket,
  USER_SYNC_STATE: {} as DurableObjectNamespace,
  LINKING_SESSION: {} as DurableObjectNamespace,
  ENVIRONMENT: 'development',
  JWT_PUBLIC_KEY: 'mock-public-key',
  JWT_PRIVATE_KEY: 'mock-private-key',
  RESEND_API_KEY: 'mock-resend-key',
  GOOGLE_CLIENT_ID: 'mock-google-client-id',
  GOOGLE_CLIENT_SECRET: 'mock-google-client-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost/callback'
})

const jsonPost = (path: string, body: Record<string, unknown>) => ({
  method: 'POST' as const,
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json' }
})

// ============================================================================
// Tests
// ============================================================================

describe('auth routes', () => {
  let app: ReturnType<typeof createApp>
  let env: ReturnType<typeof createEnv>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
    env = createEnv()
  })

  // ==========================================================================
  // POST /auth/otp/request
  // ==========================================================================

  describe('POST /auth/otp/request', () => {
    it('should return 200 with success and expiresIn for valid email', async () => {
      // #given
      const body = { email: 'test@example.com' }

      // #when
      const res = await app.request('/auth/otp/request', jsonPost('/auth/otp/request', body), env)

      // #then
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toEqual({ success: true, expiresIn: 600 })
    })

    it('should return 400 for invalid email', async () => {
      // #given
      const body = { email: 'not-an-email' }

      // #when
      const res = await app.request('/auth/otp/request', jsonPost('/auth/otp/request', body), env)

      // #then
      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR)
    })

    it('should return 429 when email rate limit is exceeded', async () => {
      // #given
      vi.mocked(checkEmailRateLimit).mockRejectedValueOnce(
        new AppError(ErrorCodes.AUTH_RATE_LIMITED, 'Too many requests', 429)
      )

      // #when
      const res = await app.request(
        '/auth/otp/request',
        jsonPost('/auth/otp/request', { email: 'test@example.com' }),
        env
      )

      // #then
      expect(res.status).toBe(429)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.AUTH_RATE_LIMITED)
    })
  })

  // ==========================================================================
  // POST /auth/otp/resend
  // ==========================================================================

  describe('POST /auth/otp/resend', () => {
    it('should return 200 with success for valid email', async () => {
      // #when
      const res = await app.request(
        '/auth/otp/resend',
        jsonPost('/auth/otp/resend', { email: 'test@example.com' }),
        env
      )

      // #then
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toEqual({ success: true, expiresIn: 600 })
    })
  })

  // ==========================================================================
  // POST /auth/otp/verify
  // ==========================================================================

  describe('POST /auth/otp/verify', () => {
    it('should return 200 with userId, isNewUser, needsSetup, and setupToken', async () => {
      // #given
      const body = { email: 'test@example.com', code: '123456' }

      // #when
      const res = await app.request('/auth/otp/verify', jsonPost('/auth/otp/verify', body), env)

      // #then
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toEqual({
        success: true,
        userId: 'user-1',
        isNewUser: true,
        needsSetup: true,
        setupToken: 'mock-setup-token'
      })
    })

    it('should return 400 for invalid body', async () => {
      // #given - code must be 6 digits
      const body = { email: 'test@example.com', code: 'abc' }

      // #when
      const res = await app.request('/auth/otp/verify', jsonPost('/auth/otp/verify', body), env)

      // #then
      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR)
    })

    it('should return error when OTP verification fails', async () => {
      // #given
      const { verifyOtp } = await import('../services/otp')
      vi.mocked(verifyOtp).mockRejectedValueOnce(
        new AppError(ErrorCodes.AUTH_INVALID_OTP, 'Invalid OTP', 401)
      )

      // #when
      const res = await app.request(
        '/auth/otp/verify',
        jsonPost('/auth/otp/verify', { email: 'test@example.com', code: '999999' }),
        env
      )

      // #then
      expect(res.status).toBe(401)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.AUTH_INVALID_OTP)
    })
  })

  // ==========================================================================
  // GET /auth/oauth/:provider
  // ==========================================================================

  describe('GET /auth/oauth/:provider', () => {
    it('should redirect to Google OAuth URL for google provider', async () => {
      // #when
      const res = await app.request('/auth/oauth/google', { method: 'GET' }, env)

      // #then
      expect(res.status).toBe(302)
      const location = res.headers.get('Location')
      expect(location).toContain('https://accounts.google.com/o/oauth2/v2/auth')
      expect(location).toContain('client_id=mock-google-client-id')
      expect(location).toContain('state=mock-oauth-state')
    })

    it('should return 400 for unsupported provider', async () => {
      // #when
      const res = await app.request('/auth/oauth/github', { method: 'GET' }, env)

      // #then
      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.AUTH_INVALID_PROVIDER)
    })
  })

  // ==========================================================================
  // POST /auth/oauth/:provider/callback
  // ==========================================================================

  describe('POST /auth/oauth/:provider/callback', () => {
    beforeEach(() => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ id_token: 'mock-id-token' })
        })
      )
    })

    it('should return 200 with userId, setupToken, and isNewUser on valid callback', async () => {
      // #given
      const body = { code: 'auth-code', state: 'valid-state' }

      // #when
      const res = await app.request(
        '/auth/oauth/google/callback',
        jsonPost('/auth/oauth/google/callback', body),
        env
      )

      // #then
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toEqual({
        success: true,
        userId: 'user-1',
        isNewUser: true,
        needsSetup: true,
        setupToken: 'mock-setup-token'
      })
    })

    it('should return 401 when state verification fails', async () => {
      // #given
      vi.mocked(jwtVerify).mockRejectedValueOnce(
        new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Invalid state', 401)
      )

      // #when
      const res = await app.request(
        '/auth/oauth/google/callback',
        jsonPost('/auth/oauth/google/callback', { code: 'auth-code', state: 'bad-state' }),
        env
      )

      // #then
      expect(res.status).toBe(401)
    })

    it('should return 400 when body is missing required fields', async () => {
      // #when
      const res = await app.request(
        '/auth/oauth/google/callback',
        jsonPost('/auth/oauth/google/callback', { code: '' }),
        env
      )

      // #then
      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR)
    })

    it('should return 401 when Google token exchange fails', async () => {
      // #given
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          json: () => Promise.resolve({ error: 'invalid_grant' })
        })
      )

      // #when
      const res = await app.request(
        '/auth/oauth/google/callback',
        jsonPost('/auth/oauth/google/callback', { code: 'bad-code', state: 'valid-state' }),
        env
      )

      // #then
      expect(res.status).toBe(401)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.AUTH_INVALID_TOKEN)
    })
  })

  // ==========================================================================
  // POST /auth/devices
  // ==========================================================================

  describe('POST /auth/devices', () => {
    const validDeviceBody = {
      name: 'MacBook Pro',
      platform: 'macos',
      osVersion: '14.0',
      appVersion: '1.0.0',
      authPublicKey: btoa('mock-public-key-bytes'),
      challengeSignature: btoa('mock-signature-bytes'),
      challengeNonce: 'test-nonce'
    }

    beforeEach(() => {
      vi.stubGlobal('crypto', {
        randomUUID: () => 'device-uuid-1',
        subtle: {
          importKey: vi.fn().mockResolvedValue({ type: 'public' }),
          verify: vi.fn().mockResolvedValue(true)
        }
      })
    })

    it('should return 200 with deviceId and tokens on valid request', async () => {
      // #when
      const res = await app.request(
        '/auth/devices',
        jsonPost('/auth/devices', validDeviceBody),
        env
      )

      // #then
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toEqual({
        success: true,
        deviceId: 'device-uuid-1',
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token'
      })
    })

    it('should return 401 when challenge verification fails', async () => {
      // #given
      vi.stubGlobal('crypto', {
        randomUUID: () => 'device-uuid-1',
        subtle: {
          importKey: vi.fn().mockResolvedValue({ type: 'public' }),
          verify: vi.fn().mockResolvedValue(false)
        }
      })

      // #when
      const res = await app.request(
        '/auth/devices',
        jsonPost('/auth/devices', validDeviceBody),
        env
      )

      // #then
      expect(res.status).toBe(401)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.AUTH_INVALID_TOKEN)
    })

    it('should return 400 for invalid body', async () => {
      // #when
      const res = await app.request(
        '/auth/devices',
        jsonPost('/auth/devices', { name: '' }),
        env
      )

      // #then
      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR)
    })
  })

  // ==========================================================================
  // POST /auth/setup
  // ==========================================================================

  describe('POST /auth/setup', () => {
    it('should return 200 on valid setup request', async () => {
      // #given
      const body = { kdfSalt: 'salt-value', keyVerifier: 'verifier-value' }

      // #when
      const res = await app.request('/auth/setup', jsonPost('/auth/setup', body), env)

      // #then
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toEqual({ success: true })
    })

    it('should return 409 when setup is already completed', async () => {
      // #given
      vi.mocked(getUserById).mockResolvedValueOnce({
        id: 'user-1',
        kdf_salt: 'existing-salt'
      } as ReturnType<typeof getUserById> extends Promise<infer T> ? T : never)

      // #when
      const res = await app.request(
        '/auth/setup',
        jsonPost('/auth/setup', { kdfSalt: 'salt', keyVerifier: 'verifier' }),
        env
      )

      // #then
      expect(res.status).toBe(409)
    })

    it('should return 404 when user is not found', async () => {
      // #given
      vi.mocked(getUserById).mockResolvedValueOnce(null as unknown as Awaited<
        ReturnType<typeof getUserById>
      >)

      // #when
      const res = await app.request(
        '/auth/setup',
        jsonPost('/auth/setup', { kdfSalt: 'salt', keyVerifier: 'verifier' }),
        env
      )

      // #then
      expect(res.status).toBe(404)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.NOT_FOUND)
    })
  })

  // ==========================================================================
  // POST /auth/refresh
  // ==========================================================================

  describe('POST /auth/refresh', () => {
    it('should return 200 with new tokens on valid refresh token', async () => {
      // #when
      const res = await app.request(
        '/auth/refresh',
        jsonPost('/auth/refresh', { refreshToken: 'valid-refresh-token' }),
        env
      )

      // #then
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toEqual({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresIn: 900
      })
    })

    it('should return 401 when token decoding fails', async () => {
      // #given
      vi.mocked(decodeJwt).mockImplementationOnce(() => {
        throw new Error('Invalid token')
      })

      // #when
      const res = await app.request(
        '/auth/refresh',
        jsonPost('/auth/refresh', { refreshToken: 'malformed-token' }),
        env
      )

      // #then
      expect(res.status).toBe(401)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.AUTH_INVALID_TOKEN)
    })

    it('should return 401 when token claims are invalid', async () => {
      // #given - missing type field
      vi.mocked(decodeJwt).mockReturnValueOnce({
        sub: 'user-1',
        device_id: 'device-1'
      } as ReturnType<typeof decodeJwt>)

      // #when
      const res = await app.request(
        '/auth/refresh',
        jsonPost('/auth/refresh', { refreshToken: 'token-with-bad-claims' }),
        env
      )

      // #then
      expect(res.status).toBe(401)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.AUTH_INVALID_TOKEN)
    })
  })
})
