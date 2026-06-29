import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../middleware/rate-limit', () => ({
  createRateLimiter: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next())
}))

vi.mock('../services/email', () => ({
  sendEmail: vi.fn()
}))

import { app } from '../index'
import { sendEmail } from '../services/email'

const sendEmailMock = vi.mocked(sendEmail)

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

const post = (body: unknown, env: Record<string, unknown>) =>
  app.request(
    new Request('http://localhost/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }),
    {},
    env
  )

describe('POST /feedback', () => {
  beforeEach(() => {
    sendEmailMock.mockReset()
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
})
