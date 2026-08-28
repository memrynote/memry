import { Hono } from 'hono'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const realCrypto = crypto

import { AppError, ErrorCodes, errorHandler } from '../lib/errors'
import type { AppContext } from '../types'

// ============================================================================
// Module mocks (must be before imports that use them)
// ============================================================================

vi.mock('../services/otp', () => ({
  generateOtp: vi.fn().mockReturnValue('123456'),
  storeOtp: vi.fn().mockResolvedValue(undefined),
  verifyOtp: vi.fn().mockResolvedValue(undefined),
  checkEmailRateLimit: vi.fn().mockResolvedValue(undefined),
  hasPendingOtp: vi.fn().mockResolvedValue(true)
}))

vi.mock('../services/user', () => ({
  getOrCreateUserByEmail: vi.fn().mockResolvedValue({
    user: { id: 'user-1', kdf_salt: null },
    isNewUser: true
  }),
  getUserByEmail: vi.fn().mockResolvedValue(null),
  getUserById: vi.fn().mockResolvedValue({ id: 'user-1', kdf_salt: null }),
  updateUser: vi.fn().mockResolvedValue(undefined),
  updateUserEmail: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../services/auth', () => ({
  issueTokens: vi.fn().mockResolvedValue({
    accessToken: 'mock-access-token',
    refreshToken: 'mock-refresh-token'
  }),
  revokeDeviceTokens: vi.fn().mockResolvedValue(undefined),
  rotateRefreshToken: vi.fn().mockResolvedValue({
    accessToken: 'new-access-token',
    refreshToken: 'new-refresh-token'
  }),
  signSetupToken: vi.fn().mockResolvedValue('mock-setup-token'),
  // Renewal is covered for real in setup-token-renewal.real-jose.test.ts; this
  // stub only keeps the module's export surface complete for this suite.
  verifyRenewableSetupToken: vi.fn(),
  SETUP_TOKEN_RENEWAL_WINDOW_SECONDS: 24 * 60 * 60
}))

vi.mock('../services/device', () => ({
  listDevices: vi.fn().mockResolvedValue([
    {
      id: 'device-1',
      name: 'Mac',
      platform: 'macos',
      auth_public_key: 'public-key-1',
      revoked_at: null
    }
  ])
}))

vi.mock('../services/email', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../services/analytics', () => ({
  captureBusinessEvent: vi.fn().mockResolvedValue(undefined),
  captureServerError: vi.fn().mockResolvedValue(undefined),
  safeWaitUntil: vi.fn(),
  waitUntilCaptured: vi.fn()
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

vi.mock('../services/account-deletion', () => ({
  deleteUserData: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../middleware/setup-auth', () => ({
  setupAuthMiddleware: async (
    c: { set: (k: string, v: string) => void },
    next: () => Promise<void>
  ) => {
    c.set('userId', 'user-1')
    c.set('tokenJti', 'setup-jti-1')
    await next()
  }
}))

vi.mock('../lib/jwt-keys', () => ({
  getPrivateKey: vi.fn().mockResolvedValue({ type: 'private' }),
  getPublicKey: vi.fn().mockResolvedValue({ type: 'public' })
}))

vi.mock('jose', () => ({
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
    setProtectedHeader() {
      return this
    }
    setIssuedAt() {
      return this
    }
    setIssuer() {
      return this
    }
    setAudience() {
      return this
    }
    setExpirationTime() {
      return this
    }
    async sign() {
      return 'mock-oauth-state'
    }
  }
}))

import { auth } from './auth'
import { captureServerError } from '../services/analytics'
import { checkEmailRateLimit, hasPendingOtp } from '../services/otp'
import { getUserByEmail, getUserById, updateUserEmail } from '../services/user'
import { revokeDeviceTokens, rotateRefreshToken } from '../services/auth'
import { SYNC_PLAN_LIMITS } from '../services/entitlements'
import { deleteUserData } from '../services/account-deletion'
import { jwtVerify } from 'jose'

// ============================================================================
// Test app with error handler
// ============================================================================

const createApp = () => {
  const app = new Hono<AppContext>()
  app.onError(errorHandler)
  app.route('/auth', auth)
  return app
}

const createD1Statement = () => {
  const statement = {
    bind: vi.fn(),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
    all: vi.fn().mockResolvedValue({ results: [{ id: 'device-uuid-1' }] })
  }
  statement.bind.mockReturnValue(statement)
  return statement
}

const createEnv = (options?: {
  firstRows?: unknown[]
  paddleFetch?: typeof fetch
  paddleApiKey?: string
  environment?: string
  localAdminSyncEmails?: string
}) => {
  const firstRows = [...(options?.firstRows ?? [])]
  return {
    DB: {
      prepare: vi.fn().mockImplementation(() => {
        const statement = createD1Statement()
        statement.first.mockImplementation(() => Promise.resolve(firstRows.shift() ?? null))
        return statement
      }),
      batch: vi.fn().mockResolvedValue([])
    } as unknown as D1Database,
    STORAGE: {} as R2Bucket,
    USER_SYNC_STATE: {} as DurableObjectNamespace,
    LINKING_SESSION: {} as DurableObjectNamespace,
    ENVIRONMENT: options?.environment ?? 'development',
    LOCAL_ADMIN_SYNC_EMAILS: options?.localAdminSyncEmails ?? 'kaan@memrynote.com',
    JWT_PUBLIC_KEY: 'mock-public-key',
    JWT_PRIVATE_KEY: 'mock-private-key',
    RESEND_API_KEY: 'mock-resend-key',
    OTP_HMAC_KEY: 'mock-otp-hmac-key',
    GOOGLE_CLIENT_ID: 'mock-google-client-id',
    GOOGLE_CLIENT_SECRET: 'mock-google-client-secret',
    GOOGLE_REDIRECT_URI: 'http://localhost/callback',
    RECOVERY_DUMMY_SECRET: 'mock-dummy-recovery-secret',
    PADDLE_CHECKOUT_TOKEN_SECRET: 'mock-checkout-token-secret',
    PADDLE_API_KEY: options?.paddleApiKey ?? 'pdl_sandbox_key',
    PADDLE_ENVIRONMENT: 'sandbox',
    fetch: options?.paddleFetch
  }
}

const jsonPost = (path: string, body: Record<string, unknown>) => ({
  method: 'POST' as const,
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json' }
})

const getAuthed = () => ({ method: 'GET' as const })

function readCheckoutTokenPayload(token: string): Record<string, unknown> {
  const [encodedPayload] = token.split('.')
  const base64 = encodedPayload.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  return JSON.parse(atob(padded)) as Record<string, unknown>
}

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

    it('should return 400 for invalid resend email', async () => {
      const res = await app.request(
        '/auth/otp/resend',
        jsonPost('/auth/otp/resend', { email: 'bad' }),
        env
      )

      expect(res.status).toBe(400)
    })

    it('should not send a new email when no OTP is pending', async () => {
      vi.mocked(hasPendingOtp).mockResolvedValueOnce(false)

      const res = await app.request(
        '/auth/otp/resend',
        jsonPost('/auth/otp/resend', { email: 'test@example.com' }),
        env
      )

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true, expiresIn: 600 })
      expect(checkEmailRateLimit).not.toHaveBeenCalled()
    })
  })

  describe('billing routes', () => {
    it('returns free billing status when no paid entitlement exists', async () => {
      env = createEnv({
        firstRows: [
          { email: 'test@example.com' },
          {
            user_id: 'user-1',
            storage_used: 0,
            plan: 'free',
            status: 'inactive',
            source: 'none',
            storage_limit: 0,
            max_file_size: 0,
            max_vaults: 0,
            version_history_days: 0,
            paddle_customer_id: null,
            paddle_subscription_id: null,
            paddle_transaction_id: null,
            expires_at: null
          }
        ]
      })

      const res = await app.request('/auth/billing', { method: 'GET' }, env)

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toMatchObject({
        plan: 'free',
        status: 'inactive',
        limits: { storageLimit: 0 },
        usage: { storageUsed: 0 },
        canManageBilling: false
      })
    })

    it('returns Kaan as a local dev paid sync account without a checkout', async () => {
      env = createEnv({
        firstRows: [
          { email: 'kaan@memrynote.com' },
          {
            user_id: 'user-1',
            storage_used: 0,
            plan: 'believer',
            status: 'active',
            source: 'dev_seed',
            storage_limit: SYNC_PLAN_LIMITS.believer.storageLimit,
            max_file_size: SYNC_PLAN_LIMITS.believer.maxFileSize,
            max_vaults: SYNC_PLAN_LIMITS.believer.maxVaults,
            version_history_days: SYNC_PLAN_LIMITS.believer.versionHistoryDays,
            paddle_customer_id: null,
            paddle_subscription_id: null,
            paddle_transaction_id: null,
            expires_at: null
          }
        ]
      })

      const res = await app.request('/auth/billing', { method: 'GET' }, env)

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toMatchObject({
        plan: 'believer',
        status: 'active',
        source: 'dev_seed',
        limits: { storageLimit: SYNC_PLAN_LIMITS.believer.storageLimit },
        canManageBilling: false
      })
      const prepareMock = env.DB.prepare as unknown as ReturnType<typeof vi.fn>
      expect(
        prepareMock.mock.calls.some(([sql]) =>
          String(sql).includes('INSERT INTO sync_entitlements')
        )
      ).toBe(true)
    })

    it('reconciles a completed Paddle transaction for the authenticated user', async () => {
      const paddleFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              id: 'txn_1',
              status: 'completed',
              customer_id: 'ctm_1',
              subscription_id: 'sub_1',
              billing_period: { ends_at: '2026-06-01T00:00:00Z' },
              custom_data: {
                app: 'memry',
                entitlement: 'sync',
                plan: 'pro',
                userId: 'user-1'
              }
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      env = createEnv({
        paddleFetch,
        firstRows: [
          { email: 'test@example.com' },
          {
            user_id: 'user-1',
            storage_used: 128,
            plan: 'pro',
            status: 'active',
            source: 'paddle',
            storage_limit: 10,
            max_file_size: 5,
            max_vaults: 10,
            version_history_days: 365,
            paddle_customer_id: 'ctm_1',
            paddle_subscription_id: 'sub_1',
            paddle_transaction_id: 'txn_1',
            expires_at: 1_780_272_000
          }
        ]
      })

      const res = await app.request(
        '/auth/billing/reconcile',
        jsonPost('/auth/billing/reconcile', { transactionId: 'txn_1' }),
        env
      )

      expect(res.status).toBe(200)
      expect(paddleFetch).toHaveBeenCalledWith(
        'https://sandbox-api.paddle.com/transactions/txn_1',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer pdl_sandbox_key' })
        })
      )
      await expect(res.json()).resolves.toMatchObject({
        plan: 'pro',
        status: 'active',
        canManageBilling: true
      })
    })

    it('rejects reconcile when transaction custom data belongs to another user', async () => {
      const paddleFetch = vi.fn().mockResolvedValue(
        Response.json({
          data: {
            id: 'txn_1',
            status: 'completed',
            customer_id: 'ctm_1',
            custom_data: {
              app: 'memry',
              entitlement: 'sync',
              plan: 'pro',
              userId: 'user-2'
            }
          }
        })
      )
      env = createEnv({ paddleFetch })

      const res = await app.request(
        '/auth/billing/reconcile',
        jsonPost('/auth/billing/reconcile', { transactionId: 'txn_1' }),
        env
      )

      expect(res.status).toBe(403)
    })

    it('rejects reconcile when transaction is not completed', async () => {
      const paddleFetch = vi.fn().mockResolvedValue(
        Response.json({
          data: {
            id: 'txn_1',
            status: 'paid',
            customer_id: 'ctm_1',
            custom_data: {
              app: 'memry',
              entitlement: 'sync',
              plan: 'pro',
              userId: 'user-1'
            }
          }
        })
      )
      env = createEnv({ paddleFetch })

      const res = await app.request(
        '/auth/billing/reconcile',
        jsonPost('/auth/billing/reconcile', { transactionId: 'txn_1' }),
        env
      )

      expect(res.status).toBe(409)
    })

    it('creates a temporary Paddle portal session when a customer exists', async () => {
      const paddleFetch = vi.fn().mockResolvedValue(
        Response.json(
          {
            data: {
              urls: {
                general: {
                  overview: 'https://customer-portal.paddle.com/cpl_1?action=overview&token=tmp'
                }
              }
            }
          },
          { status: 201 }
        )
      )
      env = createEnv({
        paddleFetch,
        firstRows: [{ paddle_customer_id: 'ctm_1', paddle_subscription_id: 'sub_1' }]
      })

      const res = await app.request(
        '/auth/billing/portal-session',
        { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } },
        env
      )

      expect(res.status).toBe(200)
      expect(paddleFetch).toHaveBeenCalledWith(
        'https://sandbox-api.paddle.com/customers/ctm_1/portal-sessions',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ subscription_ids: ['sub_1'] })
        })
      )
      await expect(res.json()).resolves.toEqual({
        portalUrl: 'https://customer-portal.paddle.com/cpl_1?action=overview&token=tmp'
      })
    })

    it('returns 409 for portal sessions before Paddle customer creation', async () => {
      env = createEnv({ firstRows: [{ paddle_customer_id: null, paddle_subscription_id: null }] })

      const res = await app.request(
        '/auth/billing/portal-session',
        { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } },
        env
      )

      expect(res.status).toBe(409)
    })

    it('GET /billing/invoices returns 200 with empty invoices array', async () => {
      const paddleFetch = vi.fn().mockResolvedValue(Response.json({ data: [] }))
      env = createEnv({
        paddleFetch,
        firstRows: [{ paddle_customer_id: 'ctm_1' }]
      })

      const res = await app.request('/auth/billing/invoices', getAuthed(), env)

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ invoices: [] })
    })

    it('GET /billing/invoices returns [] without calling Paddle when no customer id', async () => {
      env = createEnv({ firstRows: [null] })

      const res = await app.request('/auth/billing/invoices', getAuthed(), env)

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ invoices: [] })
    })

    it('GET /billing/invoices/:id/pdf returns the PDF url for an owned transaction', async () => {
      const paddleFetch = vi
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve(
            url.endsWith('/invoice')
              ? Response.json({ data: { url: 'https://paddle.com/invoice/txn_1.pdf' } })
              : Response.json({ data: { id: 'txn_1', customer_id: 'ctm_1' } })
          )
        )
      env = createEnv({ paddleFetch, firstRows: [{ paddle_customer_id: 'ctm_1' }] })

      const res = await app.request('/auth/billing/invoices/txn_1/pdf', getAuthed(), env)

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ url: 'https://paddle.com/invoice/txn_1.pdf' })
    })

    it('GET /billing/invoices/:id/pdf rejects a transaction owned by another customer', async () => {
      const paddleFetch = vi
        .fn()
        .mockResolvedValue(Response.json({ data: { id: 'txn_1', customer_id: 'ctm_other' } }))
      env = createEnv({ paddleFetch, firstRows: [{ paddle_customer_id: 'ctm_1' }] })

      const res = await app.request('/auth/billing/invoices/txn_1/pdf', getAuthed(), env)

      expect(res.status).toBe(403)
    })
  })

  // ==========================================================================
  // POST /auth/otp/verify
  // ==========================================================================

  describe('POST /auth/otp/verify', () => {
    it('should return 200 with isNewUser, needsSetup, and setupToken', async () => {
      // #given
      const body = { email: 'test@example.com', code: '123456' }

      // #when
      const res = await app.request('/auth/otp/verify', jsonPost('/auth/otp/verify', body), env)

      // #then
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toEqual({
        success: true,
        isNewUser: true,
        needsSetup: true,
        setupToken: 'mock-setup-token'
      })
    })

    it('grants Kaan a local dev paid sync entitlement', async () => {
      const res = await app.request(
        '/auth/otp/verify',
        jsonPost('/auth/otp/verify', { email: 'kaan@memrynote.com', code: '123456' }),
        env
      )

      expect(res.status).toBe(200)
      const prepareMock = env.DB.prepare as unknown as ReturnType<typeof vi.fn>
      const entitlementCallIndex = prepareMock.mock.calls.findIndex(([sql]) =>
        String(sql).includes('INSERT INTO sync_entitlements')
      )
      expect(entitlementCallIndex).toBeGreaterThanOrEqual(0)

      const entitlementStatement = prepareMock.mock.results[entitlementCallIndex]!
        .value as ReturnType<typeof createD1Statement>
      const bindArgs = entitlementStatement.bind.mock.calls[0]
      expect(bindArgs.slice(0, 8)).toEqual([
        'user-1',
        'believer',
        'active',
        'dev_seed',
        SYNC_PLAN_LIMITS.believer.storageLimit,
        SYNC_PLAN_LIMITS.believer.maxFileSize,
        SYNC_PLAN_LIMITS.believer.maxVaults,
        SYNC_PLAN_LIMITS.believer.versionHistoryDays
      ])
    })

    it('does not grant local admin sync entitlement outside development', async () => {
      env = createEnv({ environment: 'production' })

      const res = await app.request(
        '/auth/otp/verify',
        jsonPost('/auth/otp/verify', { email: 'kaan@memrynote.com', code: '123456' }),
        env
      )

      expect(res.status).toBe(200)
      const prepareMock = env.DB.prepare as unknown as ReturnType<typeof vi.fn>
      expect(
        prepareMock.mock.calls.some(([sql]) =>
          String(sql).includes('INSERT INTO sync_entitlements')
        )
      ).toBe(false)
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

    it('should reject non-loopback client redirect URIs', async () => {
      const res = await app.request(
        '/auth/oauth/google?redirect_uri=https://evil.example/callback',
        { method: 'GET' },
        env
      )

      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR)
    })

    it('should accept configured web redirect URI', async () => {
      const webRedirectUri = 'https://memrynote.com/auth/oauth/callback'
      const envWithWeb = { ...env, WEB_OAUTH_REDIRECT_URI: webRedirectUri }
      const res = await app.request(
        `/auth/oauth/google?redirect_uri=${encodeURIComponent(webRedirectUri)}`,
        { method: 'GET' },
        envWithWeb
      )

      expect(res.status).toBe(302)
      const location = res.headers.get('Location')
      expect(location).toContain('https://accounts.google.com/o/oauth2/v2/auth')
    })

    it('should reject non-loopback, non-configured redirect URIs even when WEB_OAUTH_REDIRECT_URI is set', async () => {
      const envWithWeb = {
        ...env,
        WEB_OAUTH_REDIRECT_URI: 'https://memrynote.com/auth/oauth/callback'
      }
      const res = await app.request(
        '/auth/oauth/google?redirect_uri=https://evil.example/callback',
        { method: 'GET' },
        envWithWeb
      )

      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR)
    })

    it('should use the desktop client for loopback redirects when configured', async () => {
      const envWithDesktop = {
        ...env,
        GOOGLE_DESKTOP_CLIENT_ID: 'mock-desktop-client-id',
        GOOGLE_DESKTOP_CLIENT_SECRET: 'mock-desktop-client-secret'
      }
      const res = await app.request(
        `/auth/oauth/google?redirect_uri=${encodeURIComponent('http://127.0.0.1:54321/callback')}`,
        { method: 'GET' },
        envWithDesktop
      )

      expect(res.status).toBe(302)
      const location = res.headers.get('Location') ?? ''
      expect(location).toContain('client_id=mock-desktop-client-id')
      expect(location).not.toContain('client_id=mock-google-client-id')
    })

    it('should fall back to the web client for loopback redirects when desktop client is unset', async () => {
      const res = await app.request(
        `/auth/oauth/google?redirect_uri=${encodeURIComponent('http://127.0.0.1:54321/callback')}`,
        { method: 'GET' },
        env
      )

      expect(res.status).toBe(302)
      expect(res.headers.get('Location') ?? '').toContain('client_id=mock-google-client-id')
    })

    it('should fall back to the web client for loopback when desktop secret is missing', async () => {
      const envIdOnly = { ...env, GOOGLE_DESKTOP_CLIENT_ID: 'mock-desktop-client-id' }
      const res = await app.request(
        `/auth/oauth/google?redirect_uri=${encodeURIComponent('http://127.0.0.1:54321/callback')}`,
        { method: 'GET' },
        envIdOnly
      )

      expect(res.status).toBe(302)
      expect(res.headers.get('Location') ?? '').toContain('client_id=mock-google-client-id')
    })
  })

  // ==========================================================================
  // POST /auth/oauth/:provider/native
  // ==========================================================================

  describe('POST /auth/oauth/:provider/native', () => {
    const iosEnv = () => ({ ...env, GOOGLE_IOS_CLIENT_ID: 'mock-ios-client-id' })

    it('should reject unsupported providers', async () => {
      const res = await app.request(
        '/auth/oauth/github/native',
        jsonPost('/auth/oauth/github/native', { idToken: 'anything' }),
        iosEnv()
      )

      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.AUTH_INVALID_PROVIDER)
    })

    it('should refuse rather than fall back to the web client when the iOS client is unset', async () => {
      // #given a deployment that never configured the iOS OAuth client
      // #when
      const res = await app.request(
        '/auth/oauth/google/native',
        jsonPost('/auth/oauth/google/native', { idToken: 'mock-id-token' }),
        env
      )

      // #then it fails loudly; validating against the web audience would accept
      // a token minted for a different application
      expect(res.status).toBe(501)
    })

    it('should return 400 when the ID token is missing', async () => {
      const res = await app.request(
        '/auth/oauth/google/native',
        jsonPost('/auth/oauth/google/native', { idToken: '' }),
        iosEnv()
      )

      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR)
    })

    it('should validate the ID token against the iOS client and issue a setup token', async () => {
      // #when
      const res = await app.request(
        '/auth/oauth/google/native',
        jsonPost('/auth/oauth/google/native', { idToken: 'mock-id-token' }),
        iosEnv()
      )

      // #then
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        success: true,
        isNewUser: true,
        needsSetup: true,
        setupToken: 'mock-setup-token'
      })
      // The audience is the thing that stops another app's token working here.
      const options = vi.mocked(jwtVerify).mock.calls.at(-1)?.[2] as { audience?: string }
      expect(options.audience).toBe('mock-ios-client-id')
    })

    it('should reject an ID token whose email Google has not verified', async () => {
      // #given
      vi.mocked(jwtVerify).mockResolvedValueOnce({
        payload: { email: 'test@example.com', email_verified: false, sub: 'google-sub-123' }
      } as never)

      // #when
      const res = await app.request(
        '/auth/oauth/google/native',
        jsonPost('/auth/oauth/google/native', { idToken: 'mock-id-token' }),
        iosEnv()
      )

      // #then
      expect(res.status).toBe(401)
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

    it('should exchange the code with the desktop client for loopback redirects', async () => {
      // #given a loopback redirect carried in the OAuth state
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id_token: 'mock-id-token' })
      })
      vi.stubGlobal('fetch', fetchSpy)
      vi.mocked(jwtVerify).mockResolvedValueOnce({
        payload: { type: 'oauth_state', redirect_uri: 'http://127.0.0.1:5000/callback' }
      } as never)

      const envWithDesktop = {
        ...env,
        GOOGLE_DESKTOP_CLIENT_ID: 'mock-desktop-client-id',
        GOOGLE_DESKTOP_CLIENT_SECRET: 'mock-desktop-client-secret'
      }

      // #when
      const res = await app.request(
        '/auth/oauth/google/callback',
        jsonPost('/auth/oauth/google/callback', { code: 'auth-code', state: 'valid-state' }),
        envWithDesktop
      )

      // #then the token exchange uses the desktop credential, not the web one
      expect(res.status).toBe(200)
      const sentBody = (fetchSpy.mock.calls[0][1] as { body: URLSearchParams }).body
      const params = new URLSearchParams(sentBody.toString())
      expect(params.get('client_id')).toBe('mock-desktop-client-id')
      expect(params.get('client_secret')).toBe('mock-desktop-client-secret')
    })

    it('should return 200 with setupToken and isNewUser on valid callback', async () => {
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

    it('should return 400 for unsupported OAuth callback provider', async () => {
      const res = await app.request(
        '/auth/oauth/github/callback',
        jsonPost('/auth/oauth/github/callback', { code: 'auth-code', state: 'valid-state' }),
        env
      )

      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.AUTH_INVALID_PROVIDER)
    })

    it('should return 401 when token exchange omits id_token', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({})
        })
      )

      const res = await app.request(
        '/auth/oauth/google/callback',
        jsonPost('/auth/oauth/google/callback', { code: 'auth-code', state: 'valid-state' }),
        env
      )

      expect(res.status).toBe(401)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.AUTH_INVALID_TOKEN)
    })

    it('should return 401 when Google email is not verified', async () => {
      vi.mocked(jwtVerify)
        .mockResolvedValueOnce({ payload: { type: 'oauth_state' } } as never)
        .mockResolvedValueOnce({
          payload: { email: 'test@example.com', email_verified: false, sub: 'sub-1' }
        } as never)

      const res = await app.request(
        '/auth/oauth/google/callback',
        jsonPost('/auth/oauth/google/callback', { code: 'auth-code', state: 'valid-state' }),
        env
      )

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

    it('should sanitize device name before persistence', async () => {
      const prepareMock = env.DB.prepare as unknown as ReturnType<typeof vi.fn>
      const statements: ReturnType<typeof createD1Statement>[] = []
      prepareMock.mockImplementation(() => {
        const statement = createD1Statement()
        statements.push(statement)
        return statement
      })

      const body = {
        ...validDeviceBody,
        name: 'My <script>alert(1)</script> Device'
      }

      const res = await app.request('/auth/devices', jsonPost('/auth/devices', body), env)

      expect(res.status).toBe(200)
      const deviceInsertIndex = prepareMock.mock.calls.findIndex(([sql]) =>
        String(sql).includes('INSERT INTO devices')
      )
      expect(deviceInsertIndex).toBeGreaterThan(-1)
      const insertBindArgs = statements[deviceInsertIndex].bind.mock.calls[0]
      expect(insertBindArgs[2]).not.toMatch(/[<>"'`&]/)
      expect(insertBindArgs[3]).toBe('macos')
    })

    it('should return 400 for invalid body', async () => {
      // #when
      const res = await app.request('/auth/devices', jsonPost('/auth/devices', { name: '' }), env)

      // #then
      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR)
    })

    it('should reject reused setup tokens', async () => {
      const consumedStmt = createD1Statement()
      consumedStmt.run.mockResolvedValue({ success: true, meta: { changes: 0 } })
      ;(env.DB.prepare as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(consumedStmt)

      const res = await app.request(
        '/auth/devices',
        jsonPost('/auth/devices', validDeviceBody),
        env
      )

      expect(res.status).toBe(401)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.AUTH_INVALID_TOKEN)
    })

    it('should reject registration when the user has too many active devices', async () => {
      const consumedStmt = createD1Statement()
      const countStmt = createD1Statement()
      countStmt.first.mockResolvedValue({ cnt: 50 })
      ;(env.DB.prepare as unknown as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(consumedStmt)
        .mockReturnValueOnce(countStmt)

      const res = await app.request(
        '/auth/devices',
        jsonPost('/auth/devices', validDeviceBody),
        env
      )

      expect(res.status).toBe(409)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR)
    })

    it('should reject device metadata that becomes empty after sanitization', async () => {
      const res = await app.request(
        '/auth/devices',
        jsonPost('/auth/devices', {
          ...validDeviceBody,
          name: '<>&',
          platform: '<>&'
        }),
        env
      )

      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR)
    })

    it('should store null osVersion when the client omits it', async () => {
      const prepareMock = env.DB.prepare as unknown as ReturnType<typeof vi.fn>
      const statements: ReturnType<typeof createD1Statement>[] = []
      prepareMock.mockImplementation(() => {
        const statement = createD1Statement()
        statements.push(statement)
        return statement
      })
      const { osVersion: _osVersion, ...body } = validDeviceBody

      const res = await app.request('/auth/devices', jsonPost('/auth/devices', body), env)

      expect(res.status).toBe(200)
      const deviceInsertIndex = prepareMock.mock.calls.findIndex(([sql]) =>
        String(sql).includes('INSERT INTO devices')
      )
      expect(statements[deviceInsertIndex].bind.mock.calls[0][4]).toBeNull()
    })
  })

  describe('GET /auth/recovery-info', () => {
    it('should return configured recovery info', async () => {
      vi.mocked(getUserById).mockResolvedValueOnce({
        id: 'user-1',
        kdf_salt: 'salt-1',
        key_verifier: 'verifier-1'
      } as ReturnType<typeof getUserById> extends Promise<infer T> ? T : never)

      const res = await app.request('/auth/recovery-info', { method: 'GET' }, env)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ kdfSalt: 'salt-1', keyVerifier: 'verifier-1' })
    })

    it('should return 404 when recovery user is missing', async () => {
      vi.mocked(getUserById).mockResolvedValueOnce(
        null as unknown as Awaited<ReturnType<typeof getUserById>>
      )

      const res = await app.request('/auth/recovery-info', { method: 'GET' }, env)

      expect(res.status).toBe(404)
    })

    it('should return 400 when encryption keys are not configured', async () => {
      vi.mocked(getUserById).mockResolvedValueOnce({
        id: 'user-1',
        kdf_salt: null
      } as ReturnType<typeof getUserById> extends Promise<infer T> ? T : never)

      const res = await app.request('/auth/recovery-info', { method: 'GET' }, env)

      expect(res.status).toBe(400)
    })
  })

  describe('GET /auth/key-verifier', () => {
    it('should return the account key verifier for an access-token session', async () => {
      vi.mocked(getUserById).mockResolvedValueOnce({
        id: 'user-1',
        kdf_salt: 'salt-1',
        key_verifier: 'verifier-1'
      } as ReturnType<typeof getUserById> extends Promise<infer T> ? T : never)

      const res = await app.request('/auth/key-verifier', { method: 'GET' }, env)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ kdfSalt: 'salt-1', keyVerifier: 'verifier-1' })
    })

    it('should return 404 when the user is missing', async () => {
      vi.mocked(getUserById).mockResolvedValueOnce(
        null as unknown as Awaited<ReturnType<typeof getUserById>>
      )

      const res = await app.request('/auth/key-verifier', { method: 'GET' }, env)

      expect(res.status).toBe(404)
    })

    it('should return 400 when encryption keys are not configured', async () => {
      vi.mocked(getUserById).mockResolvedValueOnce({
        id: 'user-1',
        kdf_salt: null
      } as ReturnType<typeof getUserById> extends Promise<infer T> ? T : never)

      const res = await app.request('/auth/key-verifier', { method: 'GET' }, env)

      expect(res.status).toBe(400)
    })
  })

  // ==========================================================================
  // GET /auth/recovery
  // ==========================================================================

  describe('GET /auth/recovery', () => {
    beforeEach(() => {
      vi.stubGlobal('crypto', realCrypto)
    })

    it('should derive dummy recovery data from RECOVERY_DUMMY_SECRET, not JWT_PRIVATE_KEY', async () => {
      vi.mocked(getUserByEmail).mockResolvedValueOnce(
        null as unknown as Awaited<ReturnType<typeof getUserByEmail>>
      )
      const envWithJwtA = {
        ...env,
        JWT_PRIVATE_KEY: 'jwt-key-a',
        RECOVERY_DUMMY_SECRET: 'dummy-secret'
      }
      const first = await app.request(
        '/auth/recovery?email=test@example.com',
        { method: 'GET' },
        envWithJwtA
      )
      expect(first.status).toBe(200)
      const firstJson = await first.json()

      vi.mocked(getUserByEmail).mockResolvedValueOnce(
        null as unknown as Awaited<ReturnType<typeof getUserByEmail>>
      )
      const envWithJwtB = {
        ...env,
        JWT_PRIVATE_KEY: 'jwt-key-b',
        RECOVERY_DUMMY_SECRET: 'dummy-secret'
      }
      const second = await app.request(
        '/auth/recovery?email=test@example.com',
        { method: 'GET' },
        envWithJwtB
      )
      expect(second.status).toBe(200)
      const secondJson = await second.json()

      expect(secondJson).toEqual(firstJson)

      vi.mocked(getUserByEmail).mockResolvedValueOnce(
        null as unknown as Awaited<ReturnType<typeof getUserByEmail>>
      )
      const envWithDifferentDummySecret = {
        ...env,
        JWT_PRIVATE_KEY: 'jwt-key-a',
        RECOVERY_DUMMY_SECRET: 'different-dummy-secret'
      }
      const third = await app.request(
        '/auth/recovery?email=test@example.com',
        { method: 'GET' },
        envWithDifferentDummySecret
      )
      expect(third.status).toBe(200)
      const thirdJson = await third.json()

      expect(thirdJson).not.toEqual(firstJson)
    })

    it('should return 400 for missing or invalid recovery email', async () => {
      const res = await app.request('/auth/recovery?email=bad', { method: 'GET' }, env)

      expect(res.status).toBe(400)
    })

    it('should return real recovery data when the account has keys', async () => {
      vi.mocked(getUserByEmail).mockResolvedValueOnce({
        id: 'user-1',
        kdf_salt: 'real-salt',
        key_verifier: 'real-verifier'
      } as Awaited<ReturnType<typeof getUserByEmail>>)

      const res = await app.request('/auth/recovery?email=test@example.com', { method: 'GET' }, env)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ kdfSalt: 'real-salt', keyVerifier: 'real-verifier' })
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
      const updateStmt = createD1Statement()
      updateStmt.run.mockResolvedValue({ success: true, meta: { changes: 0 } })
      ;(env.DB.prepare as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(updateStmt)

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
      const updateStmt = createD1Statement()
      updateStmt.run.mockResolvedValue({ success: true, meta: { changes: 0 } })
      ;(env.DB.prepare as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(updateStmt)

      vi.mocked(getUserById).mockResolvedValueOnce(
        null as unknown as Awaited<ReturnType<typeof getUserById>>
      )

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

    it('should return 400 for invalid setup body', async () => {
      const res = await app.request('/auth/setup', jsonPost('/auth/setup', { kdfSalt: '' }), env)

      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR)
    })
  })

  describe('GET /auth/devices', () => {
    it('should list active devices for the authenticated user', async () => {
      const res = await app.request('/auth/devices', { method: 'GET' }, env)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        devices: [
          {
            id: 'device-1',
            name: 'Mac',
            platform: 'macos',
            signingPublicKey: 'public-key-1',
            revokedAt: null
          }
        ]
      })
    })
  })

  // ==========================================================================
  // POST /auth/refresh
  // ==========================================================================

  describe('POST /auth/refresh', () => {
    it('should return 200 with new tokens on valid refresh token', async () => {
      vi.mocked(jwtVerify).mockResolvedValueOnce({
        payload: {
          type: 'refresh',
          sub: 'user-1',
          device_id: 'device-1'
        }
      } as never)

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

    it('should return 401 when token verification fails', async () => {
      // #given
      vi.mocked(jwtVerify).mockRejectedValueOnce(new Error('Invalid token'))

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

    it('should return 401 when the refresh token is expired', async () => {
      vi.mocked(jwtVerify).mockRejectedValueOnce(new Error('token expired'))

      const res = await app.request(
        '/auth/refresh',
        jsonPost('/auth/refresh', { refreshToken: 'expired-token' }),
        env
      )

      expect(res.status).toBe(401)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.AUTH_TOKEN_EXPIRED)
    })

    it('should return 401 when token claims are invalid', async () => {
      // #given - missing type field
      vi.mocked(jwtVerify).mockResolvedValueOnce({
        payload: {
          sub: 'user-1',
          device_id: 'device-1'
        }
      } as never)

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

    it('should return 400 for invalid refresh bodies', async () => {
      const res = await app.request('/auth/refresh', jsonPost('/auth/refresh', {}), env)

      expect(res.status).toBe(400)
    })
  })

  describe('POST /auth/checkout-token', () => {
    it('mints an account-bound identity token for the authenticated sync account', async () => {
      const res = await app.request(
        '/auth/checkout-token',
        jsonPost('/auth/checkout-token', {}),
        env
      )

      expect(res.status).toBe(200)
      const json = (await res.json()) as { checkoutToken: string; expiresAt: number }
      const payload = readCheckoutTokenPayload(json.checkoutToken)

      expect(payload).toEqual({
        userId: 'user-1',
        exp: json.expiresAt
      })
      expect(json.checkoutToken.split('.')).toHaveLength(2)
    })
  })

  describe('POST /auth/logout', () => {
    it('should revoke device tokens and return success', async () => {
      const res = await app.request('/auth/logout', { method: 'POST' }, env)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true })
      expect(revokeDeviceTokens).toHaveBeenCalledWith(env.DB, 'device-1')
    })

    it('should still return success when token revocation logging handles an error', async () => {
      vi.mocked(revokeDeviceTokens).mockRejectedValueOnce(new Error('db unavailable'))

      const res = await app.request('/auth/logout', { method: 'POST' }, env)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true })
    })

    it('captures the revoke failure to server error telemetry', async () => {
      vi.mocked(revokeDeviceTokens).mockRejectedValueOnce(new Error('db unavailable'))

      const res = await app.request('/auth/logout', { method: 'POST' }, env)

      expect(res.status).toBe(200)
      expect(captureServerError).toHaveBeenCalledTimes(1)
      expect(captureServerError).toHaveBeenCalledWith(
        env,
        expect.objectContaining({
          source: 'auth',
          action: 'logout_revoke_tokens',
          handled: true,
          deviceId: 'device-1'
        })
      )
    })
  })

  // ==========================================================================
  // POST /auth/email/change
  // ==========================================================================

  describe('POST /auth/email/change', () => {
    it('sends OTP when new email is free', async () => {
      vi.mocked(getUserByEmail).mockResolvedValueOnce(null)

      const res = await app.request(
        '/auth/email/change',
        jsonPost('/auth/email/change', { newEmail: 'new@example.com' }),
        env
      )

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true, expiresIn: 600 })
    })

    it('returns 409 when new email is already in use', async () => {
      vi.mocked(getUserByEmail).mockResolvedValueOnce({ id: 'user-2' } as never)

      const res = await app.request(
        '/auth/email/change',
        jsonPost('/auth/email/change', { newEmail: 'taken@example.com' }),
        env
      )

      expect(res.status).toBe(409)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR)
    })
  })

  // ==========================================================================
  // POST /auth/email/change/verify
  // ==========================================================================

  describe('POST /auth/email/change/verify', () => {
    it('verifies OTP and updates email', async () => {
      vi.mocked(getUserByEmail).mockResolvedValueOnce(null)

      const res = await app.request(
        '/auth/email/change/verify',
        jsonPost('/auth/email/change/verify', { newEmail: 'new@example.com', code: '123456' }),
        env
      )

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true })
      expect(updateUserEmail).toHaveBeenCalledWith(env.DB, 'user-1', 'new@example.com')
    })
  })

  // ==========================================================================
  // POST /auth/logout-all
  // ==========================================================================

  describe('POST /auth/logout-all', () => {
    it('revokes all devices and tokens and returns success', async () => {
      const res = await app.request('/auth/logout-all', { method: 'POST' }, env)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true })
    })
  })

  // ==========================================================================
  // DELETE /auth/account
  // ==========================================================================

  describe('DELETE /auth/account', () => {
    const makeDeleteAuthed = (body: Record<string, unknown>) =>
      new Request('http://localhost/auth/account', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer mock-access-token'
        },
        body: JSON.stringify(body)
      })

    const makeEnvWithStorage = () => {
      const storage: Pick<R2Bucket, 'list' | 'delete'> = {
        list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
        delete: vi.fn().mockResolvedValue(undefined)
      }
      return {
        ...env,
        STORAGE: storage as unknown as R2Bucket
      }
    }

    it('returns 200 and wipes user data when OTP is valid', async () => {
      vi.mocked(getUserById).mockResolvedValueOnce({
        id: 'user-1',
        email: 'test@example.com'
      } as never)

      const envWithStorage = makeEnvWithStorage()
      const res = await app.request(makeDeleteAuthed({ code: '123456' }), undefined, envWithStorage)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true })
      expect(deleteUserData).toHaveBeenCalledWith(
        envWithStorage.DB,
        envWithStorage.STORAGE,
        'user-1',
        'test@example.com'
      )
    })

    it('returns 400 when code is missing or invalid format', async () => {
      const envWithStorage = makeEnvWithStorage()
      const res = await app.request(makeDeleteAuthed({ code: 'bad' }), undefined, envWithStorage)

      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR)
    })

    it('returns 404 when user is not found', async () => {
      vi.mocked(getUserById).mockResolvedValueOnce(null as never)

      const envWithStorage = makeEnvWithStorage()
      const res = await app.request(makeDeleteAuthed({ code: '123456' }), undefined, envWithStorage)

      expect(res.status).toBe(404)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.NOT_FOUND)
    })

    it('returns 401 when OTP verification fails', async () => {
      vi.mocked(getUserById).mockResolvedValueOnce({
        id: 'user-1',
        email: 'test@example.com'
      } as never)
      const { verifyOtp } = await import('../services/otp')
      vi.mocked(verifyOtp).mockRejectedValueOnce(
        new AppError(ErrorCodes.AUTH_INVALID_OTP, 'Invalid OTP', 401)
      )

      const envWithStorage = makeEnvWithStorage()
      const res = await app.request(makeDeleteAuthed({ code: '000000' }), undefined, envWithStorage)

      expect(res.status).toBe(401)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.AUTH_INVALID_OTP)
    })
  })
})
