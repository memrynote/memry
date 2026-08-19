import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../middleware/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/rate-limit')>()),
  createRateLimiter: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next())
}))

vi.mock('../services/email', () => ({
  sendEmail: vi.fn()
}))

vi.mock('../lib/jwt-verify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/jwt-verify')>()
  return { ...actual, verifyAccessToken: vi.fn() }
})

vi.mock('../services/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/entitlements')>()
  return { ...actual, getSyncEntitlement: vi.fn() }
})

import { app } from '../index'
import { verifyAccessToken } from '../lib/jwt-verify'
import { sendEmail } from '../services/email'
import { getSyncEntitlement } from '../services/entitlements'
import type { SyncEntitlement, SyncPlan, SyncEntitlementStatus } from '../services/entitlements'

const sendEmailMock = vi.mocked(sendEmail)
const verifyAccessTokenMock = vi.mocked(verifyAccessToken)
const getSyncEntitlementMock = vi.mocked(getSyncEntitlement)

const entitlement = (plan: SyncPlan, status: SyncEntitlementStatus = 'active'): SyncEntitlement =>
  ({
    user_id: 'user-1',
    plan,
    status,
    expires_at: null
  }) as SyncEntitlement

function createEnv(overrides?: Record<string, unknown>) {
  return {
    DB: {} as D1Database,
    STORAGE: {} as R2Bucket,
    USER_SYNC_STATE: {} as DurableObjectNamespace,
    LINKING_SESSION: {} as DurableObjectNamespace,
    ENVIRONMENT: 'development',
    ALLOWED_ORIGIN: 'https://app.memry.test',
    JWT_PUBLIC_KEY: '',
    JWT_PRIVATE_KEY: '',
    RESEND_API_KEY: 'test-resend-key',
    FEEDBACK_RECIPIENT: 'kaan@memrynote.com',
    OTP_HMAC_KEY: '',
    RECOVERY_DUMMY_SECRET: '',
    WEBHOOK_HMAC_KEY: '',
    ...overrides
  }
}

const post = (body: unknown, env: Record<string, unknown>, token?: string) =>
  app.request(
    new Request('http://localhost/feedback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body)
    }),
    {},
    env
  )

describe('POST /feedback', () => {
  beforeEach(() => {
    sendEmailMock.mockReset()
    verifyAccessTokenMock.mockReset()
    getSyncEntitlementMock.mockReset()
  })

  it('emails the team and sets the sender as reply-to when an email is given', async () => {
    const env = createEnv()
    const response = await post({ message: 'Love the app', email: 'user@example.com' }, env)

    expect(response.status).toBe(202)
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    const [to, subject, html, apiKey, replyTo] = sendEmailMock.mock.calls[0]
    expect(to).toBe('kaan@memrynote.com')
    expect(subject).toContain('user@example.com')
    expect(html).toContain('Love the app')
    expect(apiKey).toBe('test-resend-key')
    expect(replyTo).toBe('user@example.com')
  })

  it('accepts anonymous feedback (no email, no reply-to)', async () => {
    const env = createEnv()
    const response = await post({ message: 'Anonymous note' }, env)

    expect(response.status).toBe(202)
    const [to, subject, , , replyTo] = sendEmailMock.mock.calls[0]
    expect(to).toBe('kaan@memrynote.com')
    expect(subject).toContain('anonymous')
    expect(replyTo).toBeUndefined()
  })

  it('escapes HTML in the message to prevent injection', async () => {
    const env = createEnv()
    await post({ message: '<script>alert(1)</script>' }, env)

    const html = sendEmailMock.mock.calls[0][2]
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('rejects an empty message with 400 and sends no email', async () => {
    const env = createEnv()
    const response = await post({ message: '   ' }, env)

    expect(response.status).toBe(400)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('returns 500 and sends no email when the recipient is not configured', async () => {
    const env = createEnv({ FEEDBACK_RECIPIENT: '' })
    const response = await post({ message: 'hi' }, env)

    expect(response.status).toBe(500)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('brands the email as MemryNote in the subject and header', async () => {
    const env = createEnv()
    await post({ message: 'hi' }, env)

    const [, subject, html] = sendEmailMock.mock.calls[0]
    expect(subject).toContain('MemryNote feedback')
    expect(html).toContain('MemryNote feedback')
    expect(html).not.toContain('beta feedback')
  })

  it('reports the verified plan in the footer for a paid user', async () => {
    verifyAccessTokenMock.mockResolvedValue({
      userId: 'user-1',
      deviceId: 'device-1',
      exp: 9999999999
    })
    getSyncEntitlementMock.mockResolvedValue(entitlement('pro'))

    const env = createEnv()
    await post({ message: 'hi', appVersion: '718.3', platform: 'MacIntel' }, env, 'valid-token')

    const html = sendEmailMock.mock.calls[0][2]
    expect(html).toContain('Version 718.3')
    expect(html).toContain('MacIntel')
    expect(html).toContain('Pro plan · paid')
  })

  it('marks a signed-in free user as not paid', async () => {
    verifyAccessTokenMock.mockResolvedValue({
      userId: 'user-1',
      deviceId: 'device-1',
      exp: 9999999999
    })
    getSyncEntitlementMock.mockResolvedValue(entitlement('free', 'inactive'))

    const env = createEnv()
    await post({ message: 'hi' }, env, 'valid-token')

    expect(sendEmailMock.mock.calls[0][2]).toContain('Free plan · not paid')
  })

  it('marks an expired paid plan as not paid', async () => {
    verifyAccessTokenMock.mockResolvedValue({
      userId: 'user-1',
      deviceId: 'device-1',
      exp: 9999999999
    })
    getSyncEntitlementMock.mockResolvedValue({
      ...entitlement('believer'),
      expires_at: Math.floor(Date.now() / 1000) - 60
    })

    const env = createEnv()
    await post({ message: 'hi' }, env, 'valid-token')

    expect(sendEmailMock.mock.calls[0][2]).toContain('Believer plan · not paid')
  })

  it('falls back to unknown plan without a token', async () => {
    const env = createEnv()
    await post({ message: 'hi' }, env)

    expect(sendEmailMock.mock.calls[0][2]).toContain('Plan unknown (not signed in)')
    expect(getSyncEntitlementMock).not.toHaveBeenCalled()
  })

  it('still delivers feedback when the token is invalid', async () => {
    verifyAccessTokenMock.mockRejectedValue(new Error('bad token'))

    const env = createEnv()
    const response = await post({ message: 'hi' }, env, 'bogus-token')

    expect(response.status).toBe(202)
    expect(sendEmailMock.mock.calls[0][2]).toContain('Plan unknown (not signed in)')
  })
})
